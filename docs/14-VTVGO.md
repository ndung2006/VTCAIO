# 14 — Tích hợp VTVgo (đối tác kéo luồng HLS)

> Dành cho phía VTVgo + operator bên ta. Schema JSON ổn định: chỉ thêm field,
> không xóa/đổi field đang có.
>
> Danh mục public là **opt-in theo kênh**: chỉ kênh được tích cột VTVgo (trang
> Kênh, lưu ngay cả khi RUNNING) mới xuất hiện. Mặc định tắt hết — không lộ
> kênh nội bộ/thử nghiệm cho đối tác.

## 1. Tổng quan

- VTVgo lấy **danh mục kênh** (máy đọc) rồi **kéo HLS trực tiếp** từng kênh về hạ
  tầng mình, play trong app VTVgo (ExoPlayer/AVPlayer/Web).
- 2 loại link xem:
  - `?token=..&exp=..` — hạn dùng (mặc định 4 giờ khi cấp từ web; API cho
    5 phút–24 giờ). Dùng cho chia sẻ ad-hoc, VLC.
  - `?pull=..` — **không hết hạn**, gắn theo kênh. Dùng cho VTVgo lưu 1 lần.
- Mọi link đều HMAC-SHA256 theo kênh. Đổi `VTC_HLS_SECRET` = mọi link cũ
  (cả 2 loại) vô hiệu ngay — đó là đường thu hồi khẩn cấp.

## 2. Xác thực (phía server-gọi-server)

Header cho mọi gọi API dưới đây:

```
Authorization: Bearer <key>
```

Key do operator cấp, cấu hình ở backend (`VTC_PARTNER_KEYS="vtvgo:KEY..."`),
giữ kín như mật khẩu. Sai/thiếu → `401 {"error":"unauthorized"}`.

## 3. Endpoint

Base: `https://catchup.vtcrd.top` (operator chốt domain trong `VTC_PUBLIC_BASE_URL`).

### GET /api/public/channels — danh mục kênh

```bash
curl -s https://catchup.vtcrd.top/api/public/channels \
  -H 'Authorization: Bearer <key>'
```

```json
{
  "generatedAt": "2026-09-15T08:00:00.000Z",
  "baseUrl": "https://catchup.vtcrd.top",
  "channels": [
    {
      "name": "VTV1",
      "serviceId": 1,
      "sourceId": "V1",
      "status": "RUNNING",
      "live": true,
      "hls": "https://catchup.vtcrd.top/hls/VTV1/index.m3u8?pull=9f2c..."
    }
  ]
}
```

- `status`: `RUNNING` (đang phát) / `STOPPED` / `ERROR`. Chỉ kéo kênh RUNNING.
- `hls` là URL pull đầy đủ, dùng ngay cho player. Poll lại endpoint này khi đổi
  kênh (thêm/xóa/đổi secret).
- `live:false` = kênh tắt live (không có playlist) — bỏ qua.

### POST /api/pull-tokens — cấp link kéo cho 1 kênh

```bash
curl -s -X POST https://catchup.vtcrd.top/api/pull-tokens \
  -H 'Authorization: Bearer <key>' -H 'content-type: application/json' \
  -d '{"channel":"VTV1"}'
# {"channel":"VTV1","pull":"9f2c...","url":"/hls/VTV1/index.m3u8?pull=9f2c..."}
```

### POST /api/hls-tokens — link hạn dùng (nếu cần)

```bash
curl -s -X POST https://catchup.vtcrd.top/api/hls-tokens \
  -H 'Authorization: Bearer <key>' -H 'content-type: application/json' \
  -d '{"channel":"VTV1","ttlMinutes":240}'
# {"token":"...","exp":1789...,"url":"/hls/VTV1/index.m3u8?token=...&exp=..."}
```

`ttlMinutes` kẹp 5–1440. Hết hạn → player nhận 403, xin link mới.

## 4. Phát trong app

- Playlist là HLS chuẩn (`index.m3u8` + segment `.ts` 5s). Token đã gắn sẵn vào
  từng URI segment phía server — player không cần làm gì thêm.
- Web player cross-origin: server trả `Access-Control-Allow-Origin: *`
  (auth vẫn bằng token trong URL).
- Khuyên: retry với backoff khi 4xx/5xx (đổi secret/restart backend gây gián
  đoạn ngắn); log `generatedAt` mỗi lần pull danh mục để đối soát.
- Sức khỏe kênh: `status` trong danh mục; chi tiết playlist từng kênh do VTVgo
  tự giám sát (404/403 kéo dài = báo operator).

## 5. Xoay secret KHÔNG downtime (quy trình chuẩn khi lộ key)

Hệ verify chấp nhận đồng thời secret mới + cũ. Ký luôn bằng secret mới.

1. Sinh secret mới. Đặt ở **cả 2 bên** (backend `.env.prod`, frontend Coolify):
   `VTC_HLS_SECRET=<mới>`, `VTC_HLS_SECRET_PREVIOUS=<cũ>` → recreate backend
   (`up -d`) + Deploy frontend.
2. Báo VTVgo pull lại `/api/public/channels` và swap URL dần — link cũ (ký bằng
   cũ) vẫn chạy vì verify còn chấp nhận, khán giả không rớt.
3. Khi VTVgo xác nhận xong **và** đã quá TTL link ngắn nhất đang lưu hành
   (mặc định 4 giờ): xóa `VTC_HLS_SECRET_PREVIOUS` (để trống) → recreate +
   Deploy. Từ đây link cũ chết hẳn.

Không bao giờ đổi thẳng secret (xóa cũ ngay) giờ cao điểm — mọi player ăn 403
trong vài giây.

## 6. Vận hành phía ta (checklist)

1. `VTC_PARTNER_KEYS` đặt ở backend, restart backend. Key dài ngẫu nhiên
   (`openssl rand -hex 32`), mỗi đối tác 1 key có tên.
2. `VTC_PUBLIC_BASE_URL` phải đúng domain public (không thì `hls` trong danh
   mục sai host).
3. `VTC_HLS_SECRET` giống nhau backend + frontend (đã có từ trước).
4. Giao key + file này cho VTVgo qua kênh kín (không mail thường/chat nhóm).
5. Thu hồi 1 đối tác: xóa key khỏi danh sách + restart backend (key còn lại
   không ảnh hưởng). Thu hồi toàn bộ link xem: đổi `VTC_HLS_SECRET` (2 bên).
