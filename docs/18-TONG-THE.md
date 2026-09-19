# 18 — VTCAIO TỔNG THỂ: kiến trúc + deploy + vận hành (1 tài liệu duy nhất)

> Đọc từ đầu tới cuối khi dựng mới. Chi tiết từng mảng xem docs liên quan
> (ghi chú tham chiếu ở mỗi phần).

## 1. Hệ thống gồm những gì

```text
NGUỒN VÀO                        VTCAIO backend (1 container = tsp + ffmpeg + node)
──────────                        ─────────────────────────────────────────────────
Multicast MPTS ──┐
SRT push ────────┼─► [MediaMTX] ─► puller ffmpeg ─┐
RTMP push ───────┘                                ├─► UDP localhost ─► TSDuck ingest (1 process/nguồn, 24/7)
SDI/HDMI ──► capture agent ffmpeg ────────────────┘         │
                                                            ├──► GHI catchup (trước transcode, IP) ─► Timeshift/Trích xuất
                                                            ├──► Live HLS gốc (RAMDisk) ─────────────► Web nội bộ
                                                            └──► fork UDP loopback ─► ffmpeg transcode (1 process/kênh)
                                                                                     ├──► SRT listener (mặc định, đối tác kéo)
                                                                                     ├──► SRT caller / RTMP push (khi bị yêu cầu)
                                                                                     └──► UDP multicast-out (kiểm tra LAN)
Frontend (Next.js, Coolify) ──► API :18081 ──► cấu hình + giám sát + preset + test
Hệ cũ VTCCatchup ──► giữ nguyên :18080, path cũ (chạy song song lâu dài)
```

- **Encode vs Transcode (§16-§18):** khác nhau chỉ ở đầu vào (SDI/HDMI qua capture agent → UDP 6200–6299; IP trực tiếp). Dưới tsp ingest thì mọi luồng giống hệt nhau.
- **Live/GHI:** IP lấy trước transcode (khóa cứng); Encode lấy sau encode (mặc định).
- **CPU:** `libx264`, mặc định; GPU NVIDIA (Turing+) qua image riêng (GTX 770 loại).

## 2. Thành phần chạy ở đâu

| Thành phần | Chạy ở | Image/compose | Ghi chú |
|---|---|---|---|
| Backend CPU | plain docker, host-network | `Dockerfile.backend` / `docker-compose.catchup.yml` | mặc định; TSDuck + ffmpeg + srt-tools |
| Backend GPU | plain docker, host-network | `Dockerfile.backend-gpu` / `docker-compose.transcode-gpu.yml` | THAY CPU, không chạy cùng (chung port 18081) |
| Frontend | Coolify (bridge) | `Dockerfile.frontend` | standalone :3000, build ăn `VTC_API_ORIGIN` |
| MediaMTX | plain docker (khi cần RTMP-in) | `docker-compose.mediamtx.yml` | RTMP :1935, publish user/pass |
| Hệ cũ | giữ nguyên | repo `VTC-Catchup` | :18080, không đụng vào |

## 3. Bản đồ cổng

| Cổng | Dùng cho |
|---|---|
| host `18081` | API + HLS origin VTCAIO |
| host `9000–9199/UDP` | SRT listen (1 port = 1 rendition) |
| `236.30.x.x:7000–7099/UDP` | multicast-out kiểm tra (TTL=1) |
| container `1935/TCP` | MediaMTX RTMP push-in |
| `127.0.0.1:6000–6099` | UDP loopback tsp→ffmpeg (nội bộ) |
| `127.0.0.1:6100–6199` | puller RTMP→tsp (nội bộ) |
| `127.0.0.1:6200–6299` | capture agent SDI→tsp (nội bộ) |
| container `3000` | Frontend (Traefik → domain) |

## 4. Deploy từ GitHub (máy Prod sạch)

```sh
# 0. Host: Ubuntu 22.04/24.04 + Docker + Compose v2 (+ driver NVIDIA/toolkit nếu GPU)
git clone git@github.com:ndung2006/VTCAIO.git /opt/vtcaio/repo && cd /opt/vtcaio/repo && git checkout main
sudo sh scripts/mount-ramdisk.sh
sudo mkdir -p /mnt/Data/vtcaio/captures /mnt/Data/vtcaio/exports /opt/vtcaio/conf/sources /var/log/vtcaio
sudo cp scripts/sysctl-vtc.conf /etc/sysctl.d/99-vtc.conf && sudo sysctl --system
cp .env.prod.example .env.prod   # điền JWT secret + admin pass (SRT passphrase để sau)
sudo sh scripts/prod-check.sh    # GPU: VTC_GPU=1 sudo -E sh scripts/prod-check.sh

# 1. Backend (chọn 1):
docker compose -f docker-compose.catchup.yml build backend && docker compose -f docker-compose.catchup.yml up -d backend
# hoặc GPU:
docker compose -f docker-compose.transcode-gpu.yml build backend-gpu && docker compose -f docker-compose.transcode-gpu.yml up -d backend-gpu

# 2. MediaMTX (khi cần nhận RTMP):
MTX_PUBLISH_PASS=<mạnh> docker compose -f docker-compose.mediamtx.yml up -d

# 3. Frontend trên Coolify: repo VTCAIO / branch main / Dockerfile `Dockerfile.frontend` /
#    exposes 3000 / env PORT=3000, VTC_API_ORIGIN=http://10.0.1.1:18081,
#    VTC_HLS_SECRET (giống backend) / Domain internal port 3000 → Deploy.
#    Đổi VTC_API_ORIGIN phải Redeploy (ăn lúc build).

curl -m 5 -s http://127.0.0.1:18081/health   # {"ok":true}
```

Cập nhật bản mới: `git pull` → build lại image đổi code → `up -d` lại (config/DB trên host nên không mất; source RUNNING tự chạy lại).

## 5. Cấu hình luồng đầu tiên (VD DN1/SID 807)

1. UI `/sources`: Thêm nguồn `DN1`, input `ip <multicast>:<port>`, kênh `DN1` SID `807`, Live + ghi catchup → **Start** → preview có hình, trích thử 1 phút được (baseline).
2. Trang kênh → panel **Truyền dẫn**: bật transcode, engine CPU, loopback `6001`, tick `720p`, output SRT-mở-cổng `9001` → Lưu.
3. Máy LAN: `ffplay "srt://<ip-prod>:9001?streamid=DN1"` → có hình, panel báo `fps>0` (lúc đầu `waiting` là bình thường — **phải có caller thì ffmpeg mới chạy**).
4. Mở rộng: thêm rendition/output (hot-restart, không động tsp) → multicast-out kiểm tra → tắt khi xong.
5. Để 24h, ghi fps/CPU/RAM (kỳ vọng ~5 core/kênh 1080i). Chi tiết + mẫu báo lỗi: `docs/17-TEST-T1.md`.

## 6. Vận hành hàng ngày

- `/channels` cột **TĐ**: `●` chạy / `◌ chờ` (chờ caller SRT) / `STALE` (tự restart ~45s) / `○` chưa chạy.
- `/sources`: badge puller/capture (chạy/chờ input/chưa chạy).
- `/transcode`: CRUD preset (sửa không ảnh hưởng kênh đang chạy).
- `/api/admin/config-backup`: tải `{sources, presets}` — lưu định kỳ ngoài máy (restore ăn cả 2).
- Crash → Telegram + restart 2s; >3 lần/5 phút → dừng hẳn chờ người. Stale → watchdog 30s restart.
- Quy tắc sắt: bật/tắt transcode + đổi loopbackPort khi RUNNING bị chặn (stop source trước); đổi endpoint/preset/output/passphrase-ref là hot-update.
- Lên Prod bật mã hóa: `.env.prod` thêm `VTC_SRT_PASSPHRASES` → recreate backend → tick **Mã hóa SRT** + điền ref → Lưu. Bên kéo thêm `&passphrase=` vào URL.

## 7. Xử lý sự cố nhanh

| Thấy gì | Làm gì |
|---|---|
| `waiting` mãi | Chưa ai kéo SRT → kéo ffplay, fps lên là xong |
| `STALE` lặp lại | Xem log/transcode status, restart tay, gửi status JSON + log |
| Lưu báo "stop source trước" | Đúng thiết kế (đổi cấu trúc) — stop, sửa, start lại |
| Start ffmpeg báo thiếu `h264_nvenc` | Engine để nhầm nvenc → về `cpu` (GTX 770 không dùng được) |
| Telegram "DỪNG HẲN" | ffmpeg chết >3 lần/5ph — dừng test, gửi log |
| `/admin` 504 | FE không với tới BE: kiểm tra `VTC_API_ORIGIN`, BE sống không (`curl` health 2 đầu) |
| Đổi env FE không ăn | Phải **Redeploy** (build lại), restart không đủ |
| VLC đen hình, fps > 0 | Firewall UDP/IGMP/VLAN — thử ffplay, cùng VLAN |
