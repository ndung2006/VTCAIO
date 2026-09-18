# 12 — YÊU CẦU HỆ THỐNG & HƯỚNG DẪN TRIỂN KHAI (HW / OS / SW)

> Áp dụng cho VTCAIO sau rà soát. Hệ thống **remux-only** (không transcode,
> không cần GPU) nên yêu cầu phần cứng thấp — tốn nhất là **ổ cứng lưu chiểu**.

---

## 1. Yêu cầu phần cứng

### 1.1. Demo (laptop/PC thường — đủ chạy toàn bộ)

| Thành phần | Tối thiểu | Ghi chú |
|---|---|---|
| CPU | 2 core x86_64 | Chạy backend + frontend + 1–2 `tsp` file mẫu |
| RAM | 4 GB | tmpfs demo vài trăm MB là đủ |
| Disk | 20 GB trống | File mẫu + image Docker (~2–3 GB) |
| NIC | Card mạng thường | Không cần multicast (dùng file `.ts` mẫu) |
| GPU | **Không cần** | Remux chỉ copy packet, không decode/encode |

### 1.2. Prod single-node (ước tính theo số kênh)

Giả thiết bitrate (đo thực tế bằng `tsp -P bitrate_monitor` rồi hiệu chỉnh):

| Loại kênh | Bitrate/kênh | 1 kênh/ngày | 1 kênh/30 ngày | 1 kênh/90 ngày |
|---|---|---|---|---|
| SD (~3 Mbps) | 3 Mbps | ~32 GB | ~0.97 TB | ~2.9 TB |
| HD (~6 Mbps) | 6 Mbps | ~65 GB | ~1.9 TB | ~5.8 TB |
| HD cao (~8 Mbps) | 8 Mbps | ~86 GB | ~2.6 TB | ~7.8 TB |

Công thức: `GB/ngày = Mbps × 10.8` (1 Mbps = 10.8 GB/ngày).

Bảng sizing theo quy mô (kênh HD 6 Mbps, MPTS gộp):

| Quy mô | Ingress | Disk 30 ngày | Disk 90 ngày | CPU | RAM |
|---|---|---|---|---|---|
| 6 kênh (1 MPTS) | ~40 Mbps | ~12 TB | ~35 TB | 4 core | 16 GB (tmpfs 4G) |
| 12 kênh | ~80 Mbps | ~23 TB | ~70 TB | 8 core | 32 GB (tmpfs 8G) |
| 30 kênh | ~200 Mbps | ~58 TB | ~175 TB | 12–16 core | 64 GB |

- **NIC:** 1 Gbps đủ tới ~150 kênh HD ingest; cộng thêm egress cho người xem HLS
  (mỗi viewer ~6 Mbps). Trên 500 Mbps sustained thì lên 10 Gbps + tách Nginx ra máy riêng.
- **Disk:** HDD/SSD/NAS đều được (ghi tuần tự chunk 60s, không cần IOPS cao);
  giữ dùng <85%, cảnh báo 90% (GC + Telegram đã làm ở Phase 3).
- **RAMDisk tmpfs:** 4 GB cho ~10 kênh live (5s/segment), tăng tuyến tính khi thêm kênh.
- **Không mua VGA/GPU.**

### 1.3. Mở rộng (khi 1 node nghẽn NIC/CPU)

Kiến trúc Master–Worker (PRD §14): Master chạy Next.js + API + DB, mỗi Worker chạy
backend + `tsp` ingest tại phân hệ mạng của mình, mount chung NFS/SAN cho captures.
Ngưỡng cân nhắc tách: ingress sustained >600 Mbps hoặc CPU ingest >70% liên tục.

---

## 2. Yêu cầu OS

| Máy | OS | Ghi chú |
|---|---|---|
| Host Prod | **Ubuntu 22.04 LTS** (giữ nguyên hệ hiện tại) | Kernel ≥5.15, user sudo |
| Container | Ubuntu 24.04 (tự có trong Dockerfile) | Upstream chỉ còn binary TSDuck mới cho 24.04+; container khác OS host vẫn chạy `tsp` bình thường |
| Dev/laptop | Bất kỳ OS nào chạy được Docker | Windows/macOS dùng Docker Desktop |

Tinh chỉnh kernel bắt buộc trên host Prod (có sẵn `scripts/sysctl-vtc.conf`):

```
net.ipv4.conf.all.rp_filter=0        # nhận multicast ngoài default gateway
net.core.rmem_max=26214400           # UDP buffer ≥25MB chống rớt gói MPTS
net.core.wmem_max=26214400
```

Mount bắt buộc: `tmpfs 4G` tại `/media/ramdisk/live` (`scripts/mount-ramdisk.sh`).
Kiểm tra 1 lệnh: `sudo sh scripts/prod-check.sh` (phải PASS hết mới lên sóng).

---

## 3. Yêu cầu phần mềm

| Phần mềm | Bản tối thiểu | Dùng cho |
|---|---|---|
| Docker Engine | 24+ | Chạy toàn bộ stack |
| Docker Compose | v2.20+ (`docker compose`) | `host-gateway`, profiles |
| (Dev không Docker) Node.js | 20+ | `npm run dev` backend/frontend, test |
| TSDuck | 3.33+ (khuyên mới nhất) | Tự cài trong image, không cần cài tay |
| Nginx | 1.27-alpine (trong compose) | Không cần cài tay |
| Trình duyệt xem | Chrome/Edge/Firefox mới, Safari 15+ | hls.js / native HLS |

Không cần: GPU driver, FFmpeg, Redis, DB rời (store in-memory hiện tại; PostgreSQL
khi lên Phase 2b multi-node).

### Port & firewall

| Port | Dịch vụ | Mở cho ai |
|---|---|---|
| 80 | Nginx (HLS + web + API) | Người dùng + kỹ thuật |
| 18080 | Backend API trực tiếp (host-network) | Chỉ nội bộ (FE gọi qua đây); tránh 8080 vì trùng dashboard Traefik |
| 3000 | Frontend dev | Chỉ dev local |
| UDP theo cấu hình | Multicast ingest (VD 1234) | Switch multicast, IGMP snooping bật |

---

## 4. Yêu cầu mạng (quan trọng nhất khi lên Prod)

1. **Dải IP:** chuẩn hóa về Private Multicast `239.x.x.x` (RFC 2365); bỏ dải sai
   `227.x` / `238.60.x` đang dùng để tránh xung đột định tuyến.
2. **Switch:** bật IGMP snooping/querier, cho phép host join group; backend chạy
   `network_mode: host` nên bind trực tiếp interface vật lý.
3. **Băng thông:** ingress = tổng bitrate các MPTS + 20% dự phòng; egress = ingress
   + (số viewer đồng thời × bitrate).
4. **DNS/domain:** `luuchieu.truyenhinhso.vn` trỏ về Nginx (anti-hotlink cấu hình
   theo domain này trong `docker/nginx.conf`).

---

## 5. Hướng dẫn cài đặt

### A. Demo trên laptop (15 phút, không cần multicast)

```sh
git clone <repo> && cd VTCAIO
docker compose --profile demo up -d --build
docker compose exec tsduck tsp --version
docker compose exec tsduck sh /work/scripts/demo-cli.sh        # Live + catchup mẫu
# Terminal khác: xem playlist sinh ra
docker compose exec tsduck ls -lh /media/ramdisk/live/demo/
# Xem HLS trên trình duyệt dev:
cd apps/frontend && npm install && npm run dev                  # :3000
# (đặt NEXT_PUBLIC_HLS_BASE=http://localhost:8081/hls — demo-hls serve sẵn)
```

### B. Prod single-node (lần đầu)

```sh
sudo sh scripts/prod-check.sh        # FAIL ở đâu sửa ở đó, chạy lại tới PASS hết
sudo sh scripts/mount-ramdisk.sh
cp .env.prod.example .env.prod       # điền JWT secret, admin pass mạnh, Telegram
docker compose --profile prod up -d --build
docker compose --profile prod -f docker-compose.yml -f compose.prod.yml up -d  # bind HDD thật
curl http://127.0.0.1:18080/health   # backend ở host network → {"ok":true}
# Web + HLS qua Nginx: http://<ip-may>/ (xem chi tiết trong 11-DEPLOY)
```

Tạo source đầu tiên (thay IP/service_id thật):

```sh
# login lấy cookie rồi tạo + start (xem docs/06-API.md), hoặc gọi từ UI /sources
```

### C. Vận hành hằng ngày
- Sáng: liếc dashboard `/` (CPU/RAM/DISK xanh, mạng ổn), `/api/admin/hls-health` không stale.
- Telegram báo CC-error/exit/disk: xử lý theo runbook (mất tín hiệu → check switch/source; disk >90% → GC tay `POST /api/admin/gc`).
- Backup: file `.conf` (`/opt/vtc/conf/sources`), DB (khi lên Prisma), `.env.prod` (giữ offline).
- Cập nhật: `docker compose --profile prod pull && up -d` (tsp image mới), rollback bằng image tag cũ.

---

## 6. Triển khai qua Coolify trên Ubuntu 24.04 (khuyên dùng nếu đã có Coolify)

**Được, và 24.04 là bản Coolify hỗ trợ cài tự động** (script chính thức chạy LTS
20.04/22.04/24.04, cần Docker Engine 24+ — không dùng Docker bản snap).
Tự thân Coolify tốn ~2 CPU / 2 GB RAM / 10 GB disk, tính thêm vào sizing §1.

Điểm phải chỉnh so với compose thường (đã làm sẵn trong `compose.coolify.yml`):

| Vấn đề | Cách xử lý |
|---|---|
| Coolify (Traefik) đã chiếm port 80/443 + SSL | `nginx` bỏ `ports`, gán domain trong UI Coolify (chỉ service `nginx` cần domain) |
| Backend `network_mode: host` không vào được mạng compose | Giữ nguyên (bắt multicast), gọi nhau qua `host.docker.internal` + `extra_hosts` (có sẵn trong file) |
| Secrets trong `.env.prod` | Điền vào Environment Variables trong UI Coolify: `VTC_JWT_SECRET`, `VTC_ADMIN_*`, `VTC_COOKIE_SECURE=1`, `VTC_TELEGRAM_*` |
| HDD/SAN + tmpfs | Vẫn làm trên host qua SSH (`sysctl`, `mount-ramdisk.sh`); volumes trong file là named — sửa thành bind `/mnt/Data...` trước khi import, hoặc dùng Persistent Storage của Coolify |

Các bước:

```sh
# 1. Trên host Ubuntu 24.04 fresh: cài Coolify theo docs chính thức, mở 22/80/443
# 2. Trên host (SSH): sysctl + tmpfs + kiểm tra multicast (mục B, bước prod-check)
# 3. Trong Coolify: New Resource → Docker Compose → trỏ repo/branch,
#    Compose file = compose.coolify.yml → điền env → gán domain cho nginx → Deploy
```

Lưu ý: build image trong Coolify tốn RAM lúc build (Next.js ~2 GB) — nếu máy yếu,
build sẵn ở máy khác rồi push registry sẽ nhẹ hơn.
