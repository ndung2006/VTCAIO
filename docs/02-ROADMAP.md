# 02 — ROADMAP 6 PHASE (Checklist để bắt đầu code)

> Nguyên tắc: xong Phase nào, test chứng minh Phase đó rồi mới sang Phase sau.

## Phase 1 — Core Manager (ƯU TIÊN TUẦN NÀY)
**Mục tiêu:** `1 Source = 1 process 24/7`, Start/Stop không Zombie.

- [ ] `apps/backend/src/core/ConfigGenerator.ts`
  - Input: `{ source_id, ip_address, is_record_all, channels: [{id, service_id, is_live}] }`
  - Output: string conf theo thuật toán PRD 3.1 (Input + N×fork HLS + Output hls/drop)
  - Thêm `preview-conf` API để xem trước
- [ ] `apps/backend/src/core/ProcessManager.ts`
  - `start(source)` → `spawn('tsp', ['@conf'], {detached:true})`, lưu pid, gắn `on(exit/error)` + drain stderr
  - `stop(source)` → `process.kill(-pid,'SIGTERM')` + chờ 5s, còn sống thì `SIGKILL`
  - `autoRestart` sau 5s nếu crash không chủ đích
- [ ] Test chứng minh:
  - `node scripts/test-pgid.js` Start → Stop 10 lần, `ps aux | grep defunct` phải = 0
  - Kill -9 giả lập crash → tự restart sau 5s
- [ ] Lưu mẫu conf vào `storage/conf/sources/<SOURCE_ID>.conf`

**Xong khi:** chạy 24h với 1 MPTS mẫu không tăng process/RAM.

## Phase 2 — Database & API
- [ ] Prisma + SQLite (dev) / PostgreSQL (prod): `Source, Channel, ExportJob, User, SystemEvent`
- [ ] Quyết retention theo Source (xem BRAINSTORM §2.4)
- [ ] CRUD `/api/sources`, `/api/channels` (JWT `verifyAuth`)
- [ ] SSE `GET /api/system/stream` mỗi 2s (lib `systeminformation`)
- [ ] Auth: `/login`, bcrypt(10), HttpOnly JWT, `/change-password`, `/forgot + /reset`

## Phase 3 — Workers (Storage & GC)
- [ ] `apps/backend/src/jobs/garbageCollector.ts` cron mỗi giờ: xóa file quá hạn, giữ disk <85%
- [ ] `scripts/mount-ramdisk.sh` (tmpfs) + `scripts/sysctl-vtc.conf` (rp_filter=0, rmem 25MB)
- [ ] Healthcheck HLS 30s: playlist đứng >15s → restart + alert
- [ ] `NotificationService` (Telegram): trigger exit!=0, CC-error 10s, disk>90% (cooldown 5’)

## Phase 4 — Frontend UI
- [ ] Next.js + Tailwind + shadcn/ui + Recharts + hls.js
- [ ] Layout: Sidebar dark / Header light / Workspace slate-50
- [ ] `LivePlayer` + `useEffect [streamUrl]` cleanup `hls.destroy()` (bắt buộc)
- [ ] Trang `/channel/[id]`: tiêu đề IN HOA + Stream Link Box + nút Copy + player 16:9 (ẩn seekbar)
- [ ] Dashboard monitor: RadialBar CPU/RAM/SWAP/DISK + AreaChart mạng
- [ ] `middleware.ts` bảo vệ `/dashboard,/sources,/channels,/exports`

## Phase 5 — Catchup Exporter
- [ ] Form: dropdown kênh + In/Out datetime, validate Out>In, duration ≤6h (FE+BE)
- [ ] `POST /api/exports` → tạo job PROCESSING → trả 200 ngay → `spawn tsp -I file ... -P zap -O file`
- [ ] `on(exit)`: 0→SUCCESS, !=0→ERROR + unlink file dở
- [ ] Bảng lịch sử + nút Tải (stream, filename `Kenh_DDMMYYYY_HHmm-HHmm.ts`) + Xóa (unlink trước, xóa DB sau)
- [ ] Queue: tối đa 2 export concurrent, còn lại QUEUED; chặn export mới khi disk>90%

## Phase 6 — Deployment
- [ ] `Dockerfile` backend (host network) + frontend + `docker-compose.yml`
- [ ] Nginx: serve `.m3u8/.ts`, anti-hotlink, X-Accel-Redirect cho download
- [ ] Winston/Pino + rotation 15 ngày, tách `tsduck-warnings.log`
- [ ] Tài liệu vận hành: quy hoạch IP 239.x, checklist NIC/CPU/Disk sizing

## Việc đầu tiên nên gõ (gợi ý lệnh)

```bash
# 1. Khởi tạo backend tối thiểu
cd /workspace/VTCAIO/apps/backend && npm init -y && npm i typescript tsx @types/node
# 2. Viết ConfigGenerator + test in conf ra storage/conf/sources/demo.conf
# 3. Viết ProcessManager + test Start/Stop với tsp thật (hoặc sleep giả lập nếu chưa có tsp)
```

## Ước tính dung lượng (để đặt ổ cứng)
`1 kênh HD ~6 Mbps ≈ 2.7 GB/h ≈ 64.8 GB/ngày ≈ 1.9 TB/30 ngày`.
→ 10 kênh MPTS 30 ngày ≈ 19 TB. 90 ngày ≈ 58 TB. Chốt retention trước khi mua disk.
