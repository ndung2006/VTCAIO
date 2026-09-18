# 17 — RUNBOOK TEST T1 TRÊN MÁY PROD (transcode nội bộ, chưa mã hóa)

> Mục tiêu: ingest multicast thật → transcode CPU → kéo SRT nội bộ kiểm tra.
> Chưa đấu VTVgo, chưa passphrase (test trần cho nhanh).
> Làm theo thứ tự 0→5, mỗi bước ghi lại kết quả vào mẫu báo ở §6 gửi lại.

## 0. Chuẩn bị máy Prod (làm 1 lần)

```sh
sudo sh scripts/prod-check.sh
# Đạt: rp_filter=0, rmem ≥25MB, tmpfs /media/ramdisk/vtcaio, docker OK.
# Bỏ qua FAIL dòng captures/conf nếu là lần đầu (mkdir theo hướng dẫn trong log).

cp .env.prod.example .env.prod   # điền JWT secret + admin pass (VTC_SRT_PASSPHRASES để trống = test trần)
docker compose -f docker-compose.catchup.yml build backend
docker compose -f docker-compose.catchup.yml up -d backend
curl -m 5 -s http://127.0.0.1:18081/health   # {"ok":true}
```

Mở firewall (chạy trên host):
```sh
sudo ufw allow 9000:9199/udp   # SRT listen
sudo ufw allow 7000:7099/udp   # multicast-out kiểm tra
```

## 1. Tạo source + start ingest (baseline, chưa transcode)

Trên UI `/sources` (admin): Thêm nguồn — ID `DN1`, input `ip <multicast>:<port>`
(VD `ip 239.69.69.10:1234`), kênh `DN1` SID `807`, tick Live, bật ghi catchup.
Nhấn **Start**.

Đạt khi:
- Status source = RUNNING, không ERROR.
- Web preview kênh có hình + tiếng (Live HLS gốc).
- Chờ 2–3 phút, vào `/exports` trích thử 1 phút → tải được file (GHI hoạt động).

> GHI + Live chạy ổn mới sang bước 2 (cách ly: transcode sập cũng không ảnh hưởng 2 cái này).

## 2. Bật transcode 720p + SRT listen

Vào trang kênh `/channel/DN1` → panel **TRUYỀN DẪN**:
- Tick "Bật transcode", engine `CPU`, cổng loopback `6001`.
- Tick preset `720p`.
- Thêm output: loại `SRT mở cổng`, rendition `720p`, cổng `9001`, Bật.
- **Lưu truyền dẫn**.

Đạt khi (poll `GET /api/transcode/status` hoặc nhìn panel):
- Entry `DN1/DN1` xuất hiện. Lúc đầu `waiting=true` là BÌNH THƯỜNG (chưa ai kéo).

## 3. Kéo SRT kiểm tra (BẮT BUỘC — không kéo thì ffmpeg đứng chờ)

Trên máy kỹ thuật cùng LAN (có VLC/ffplay):

```sh
ffplay "srt://<ip-may-prod>:9001?streamid=DN1"
```

Đạt khi:
- Có hình + tiếng, đúng nội dung DN1.
- `fps` trên panel > 0 (VD 25), `stale=false`, `waiting` tắt.
- Để chạy 10 phút xem có đứng hình/rớt không.

> ⚠️ Quy tắc sắt đã đo: **listener không có caller thì ffmpeg đứng ở bước mở output** (không encode, không báo lỗi). Muốn biết ffmpeg sống hay chết thì nhìn `fps`, đừng nhìn process.

## 4. Mở rộng: thêm rendition + multicast-out

- Panel Truyền dẫn: tick thêm `480p`, thêm output SRT cổng `9002` → Lưu (hot-restart, không động tsp).
- Kéo thử `:9002` như bước 3.
- Thêm output `UDP multicast`: nhóm `236.30.233.1`, cổng `7001`, IP card phát ra (VD `192.168.20.200`) → Lưu → trên máy cùng VLAN: `ffplay udp://236.30.233.1:7001`.
- Xem badge "đang phát multicast", test xong TẮT output này đi (đỡ tốn băng thông LAN).

## 5. Đo tải (quyết định số kênh/prod)

- Bật đủ 4 renditions + audio-only như cấu hình thật, để chạy **24h**.
- Ghi lại mỗi vài giờ: `fps` từng lúc, %CPU máy (`top`/`htop`), RAM.
- Kỳ vọng theo số đo lab: ~5 core/kênh 1080i. Máy Prod mà CPU > 85% liên tục → báo lại, tính phương án giảm rendition hoặc tách máy.

### Lên Prod: bật mã hóa SRT (làm sau khi test trần đạt)

1. Thêm secret vào `.env.prod`: `VTC_SRT_PASSPHRASES=vtvgo:<mat-khau-≥16-ky-tu>` → recreate backend (restart để ăn env).
2. Panel Truyền dẫn → output SRT → tick **Mã hóa SRT** → điền ref `vtvgo` → Lưu (hot-restart ffmpeg, không động tsp).
3. Bên kéo phải thêm `&passphrase=<mat-khau>` vào URL SRT, nếu không handshake rớt.
4. Tắt mã hóa = bỏ tick → Lưu (về trần ngay, không cần restart backend).

## 6. Mẫu báo lại từng bước (copy-paste gửi tôi)
```
Bước 1 (ingest): ĐẠT / LỖI + mô tả
  - preview-conf có dòng fork loopback không? (Xem conf trên UI)
Bước 2 (start ffmpeg): status JSON từ /api/transcode/status:
  <paste>
Bước 3 (kéo SRT): ĐẠT / LỖI + mô tả hình/tiếng, fps quan sát:
Bước 4 (mở rộng): 480p ĐẠT/LỖI, mcast ĐẠT/LỖI:
Bước 5 (tải 24h): fps lúc ghi: ___, CPU%: ___, RAM: ___
Lỗi gặp (paste message lỗi UI/API/log nếu có):
```

## 7. Lỗi thường gặp

| Thấy gì | Nghĩa là gì | Làm gì |
|---|---|---|
| `waiting=true` mãi | Chưa ai kéo SRT (ffmpeg chờ caller) | Kéo ffplay như bước 3, fps sẽ lên |
| `stale=true` | Đã chạy rồi đứng fps | Restart ffmpeg (nút Stop/Start ffmpeg), báo lại |
| Lưu báo "stop source trước" | Đổi enabled/loopback khi RUNNING | Đúng thiết kế — stop source, sửa, start lại |
| Start ffmpeg báo thiếu `h264_nvenc` | Engine để nhầm nvenc | Chuyển engine về `cpu` (máy này không có GPU Turing+) |
| VLC đen hình nhưng fps > 0 | Thường do firewall/UDP + IGMP | Kiểm tra ufw + cùng VLAN, thử ffplay thay VLC |
| Crash lặp + Telegram "DỪNG HẲN" | ffmpeg chết >3 lần/5 phút | Dừng test, gửi log + status cho tôi |
