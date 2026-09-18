# 13 — Triển khai BE (WSL) + FE (Coolify), từng bước (VTCAIO chạy song song hệ cũ)

> Kiến trúc chốt: backend host-network ngoài Coolify (bắt multicast) +
> frontend trong Coolify (stateless). Áp dụng từ commit `fb0bf24` trở đi.
>
> SONG SONG LÂU DÀI với hệ cũ VTCCatchup trên cùng 1 host:
> hệ cũ giữ `18080` + `/media/ramdisk/live` + `/mnt/Data/catchup/*` +
> `/opt/vtc/conf/sources`; VTCAIO dùng `18081` + `/media/ramdisk/vtcaio` +
> `/mnt/Data/vtcaio/*` + `/opt/vtcaio/conf/sources` (xem bảng §0.1).
> KHÔNG đổi VTCAIO về path/port cũ — sẽ ghi đè DB/conf/chunk của hệ cũ.

## 0. Bản đồ cổng và địa chỉ (thuộc lòng trước khi đụng gì)

| Thành phần | Nghe ở | Ai gọi tới |
|---|---|---|
| Backend API + HLS origin (VTCAIO) | host `18081` (host-network) | FE qua `http://10.0.1.1:18081`, kỹ thuật `curl` trực tiếp |
| Frontend web | container `3000` | Traefik qua Domains → Internal port `3000` |
| Traefik dashboard | host `8080` | không đụng vào |
| Nginx full-stack (profile prod) | host `8082` | người dùng LAN (hệ cũ giữ `:80`) |
| Demo HLS (profile demo) | host `8083` | dev local (hệ cũ giữ `:8081`) |

### 0.1. Bảng tách song song VTCAIO vs hệ cũ (giữ nguyên dài hạn)

| Tài nguyên | Hệ cũ VTCCatchup | VTCAIO (repo này) |
|---|---|---|
| Backend PORT | `18080` | `18081` |
| Live RAMDisk | `/media/ramdisk/live` | `/media/ramdisk/vtcaio` |
| Captures/exports | `/mnt/Data/catchup/*` | `/mnt/Data/vtcaio/*` |
| Conf + DB (`sources.db.json`, `epg.db.json`) | `/opt/vtc/conf/sources` | `/opt/vtcaio/conf/sources` |
| Log host | `/var/log/vtccatchup` | `/var/log/vtcaio` |
| Container | `vtccatchup-backend` | `vtcaio-backend` |
| Compose project | `vtccatchup` | `vtcaio` |
| Public base URL | `https://catchup.vtcrd.top` | `https://vtcaio.vtcrd.top` |
| FE `VTC_API_ORIGIN` | `http://10.0.1.1:18080` | `http://10.0.1.1:18081` |
| Nginx prod / demo-hls | `:80` / `:8081` | `:8082` / `:8083` |

Quy tắc cổng: env `PORT` = Ports exposes = Domains internal port. Lệch 1 chỗ
là 502/Exited (đã gặp 2 lần).

## 1. Backend trên WSL (máy DESKTOP-A67TQLI)

### 1.1. Lần đầu (làm 1 lần)

```bash
# .wslconfig: networkingMode=mirrored, memory=8GB → wsl --shutdown
# Windows: Sleep=Never, IP tĩnh/DHCP reservation, firewall inbound TCP 18081
# (hệ cũ giữ 18080 — mở cả 2 khi chạy song song).
sudo mkdir -p /srv/vtcaio && sudo chown $USER:$USER /srv/vtcaio
git clone https://github.com/ndung2006/VTCAIO /srv/vtcaio/repo
cd /srv/vtcaio/repo && git checkout main
cp .env.prod.example .env.prod && chmod 600 .env.prod && nano .env.prod
sudo mkdir -p /mnt/Data/vtcaio/captures /mnt/Data/vtcaio/exports /opt/vtcaio/conf/sources /var/log/vtcaio
sudo sh scripts/mount-ramdisk.sh   # mount /media/ramdisk/vtcaio (hệ cũ giữ /media/ramdisk/live)
df -h /media/ramdisk/vtcaio
ip route get 239.1.1.1   # phải ra đúng card về phía nguồn phát
```

`.env.prod` bắt buộc điền (còn lại để trống được):
`VTC_JWT_SECRET`, `VTC_ADMIN_USER/EMAIL/PASS`, `VTC_HLS_SECRET` (sinh riêng,
**dán y hệt sang FE VTCAIO** — nên khác secret hệ cũ), `VTC_PARTNER_KEYS=vtvgo:<key>`,
`VTC_EPG_API_KEY`, `VTC_PUBLIC_BASE_URL=https://vtcaio.vtcrd.top`,
`VTC_TELEGRAM_BOT_TOKEN/CHAT_ID`, `PORT=18081`.

```bash
docker compose -f docker-compose.catchup.yml build backend
docker compose -f docker-compose.catchup.yml up -d backend
sudo cp systemd/vtcaio-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vtcaio-backend
```

Verify (thiếu 1 dòng là dừng):
```bash
docker inspect vtcaio-backend --format '{{.HostConfig.NetworkMode}}'  # host
docker exec vtcaio-backend tsp --version                              # 3.44-4676
docker exec vtcaio-backend tsp -P vtcmonitor --help >/dev/null && echo PLUGIN-OK
curl -m 5 -s http://127.0.0.1:18081/health                                # {"ok":true}
# Song song: hệ cũ vẫn xanh ở :18080
curl -m 5 -s http://127.0.0.1:18080/health; echo
```

### 1.2. Cập nhật thường kỳ (mỗi lần có commit mới)

```bash
cd /srv/vtcaio/repo && git pull && git log --oneline -1
# Đổi .env.prod trước nếu commit mới thêm biến (xem git log/CHANGELOG).
docker compose -f docker-compose.catchup.yml build backend
docker compose -f docker-compose.catchup.yml up -d backend   # recreate mới ăn env
sleep 5 && curl -m 5 -s http://127.0.0.1:18081/health; echo
```

Lưu ý: đổi `VTC_JWT_SECRET` = mọi phiên login chết (đăng nhập lại);
đổi `PORT` = FE + firewall đổi theo; nguồn RUNNING tự chạy lại sau vài giây.

## 2. Frontend trên Coolify (máy này) — resource RIÊNG cho VTCAIO

Resource Frontend VTCAIO, domain `vtcaio.vtcrd.top` (hệ cũ giữ `catchup.vtcrd.top`):

1. Environment Variables:
   - `VTC_API_ORIGIN=http://10.0.1.1:18081` (gateway mạng coolify, ổn định; hệ cũ `:18080`)
   - `VTC_HLS_SECRET` = y hệt backend VTCAIO (nên khác secret hệ cũ)
   - `VTC_LIVE_DIR=/media/ramdisk/vtcaio`
   - `PORT=3000`
2. Ports exposes `3000`, Port mappings **trống**, Domains → Internal port `3000`.
3. Persistent Storage: `/media/ramdisk/vtcaio` → `/media/ramdisk/vtcaio`
   (thiếu là `/hls` 404 toàn bộ — đã gặp ở hệ cũ với `/media/ramdisk/live`).
4. **Deploy** (đổi biến/env chỉ cần Deploy, không cần Force Rebuild trừ khi
   build lỗi; restart thường KHÔNG nạp env mới).

Verify: domain → `/login` → `/admin` xanh → bắn tin thử → `/sources`,
`/channels`, `/epg` mở được.

## 3. Nghiệp vụ đầu tiên (sau khi 2 bên xanh)

1. `/sources` → thêm nguồn multicast thật (input `ip <nhóm>:<cổng>`, SID lấy từ
   `tsp -P tables --pid 0`), Start → RUNNING.
2. `/channels` → playlist hết "mất playlist" → `/channel/<tên>` xem live.
3. `/epg` → map ID đối tác → Đồng bộ ngay → xem lịch → **Xem** thử timeshift
   (chỉ SPTS; MPTS báo thẳng dùng Trích xuất).
4. `/exports` → trích xuất thử 5–10 phút → tải file.
5. `curl` danh mục VTVgo bằng Bearer → VLC mở link `?pull=` (không login).

## 4. Xử sự cố nhanh

| Hiện tượng | Nguyên nhân chắc nhất | Làm gì |
|---|---|---|
| Domain 502 | FE Exited / lệch cổng (3 số không đồng nhất) | Deployments log + đồng nhất PORT/exposes/internal |
| `/admin` HTTP 504 | FE không với tới BE (sai `VTC_API_ORIGIN`, BE chết) | `wget` từ trong FE tới origin; `curl` health trên host BE |
| `/admin` unauthorized | Cookie chết (đổi secret/recreate) | Đăng nhập lại |
| Source ERROR ngay khi Start | Đọc log: `tsp @conf` tay (conf sai) / thiếu thư mục (bản cũ) / mất tín hiệu | `docker exec vtcaio-backend tsp @/opt/vtcaio/conf/sources/<id>.conf` |
| Mất playlist >30s khi RUNNING | Fork gãy / tín hiệu mất | log backend + `ls /media/ramdisk/vtcaio/<kênh>/` |
| EPG trống ngày hôm nay | Chưa duyệt (bình thường) | Xem ngày đã duyệt gần nhất |

## 5. Lui về

- BE: bản cũ còn tag trong Docker (`docker images`) hoặc `git checkout <cũ>` +
  build + up -d. Cấu hình nằm ở volume/file ngoài image nên còn nguyên.
- FE: Deployments → Deploy lại bản cũ.
