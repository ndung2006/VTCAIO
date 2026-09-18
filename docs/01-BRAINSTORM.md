# 01 — BRAINSTORM: Hệ thống Lưu chiểu & Live Streaming (VTCAIO)

Ngày brainstorm: 2026-09-12 | Nguồn: PRD 17 phần | Trạng thái: Sẵn sàng đưa vào code Phase 1

---

## 1. Tóm tắt 1 trang

**Hệ thống làm 2 việc song song trên cùng 1 luồng IP đầu vào (MPTS/SPTS):**

- **Live (độ trễ thấp):** `IP Multicast → tsp demux (zap) → HLS 5s segment trên RAMDisk (tmpfs) → Web player (hls.js)`.
- **Catchup (bằng chứng phát sóng 30–90 ngày):** `cùng tiến trình tsp đó → -O hls cắt chunk 60s ra HDD → GC xóa quá hạn → Export theo In/Out-point (tối đa 6h/lần)`.

**Insight lớn nhất từ hệ cũ:** 19.044 Zombie không phải do TSDuck yếu, mà do **thiết kế vòng đời process sai**: dùng `--max-duration 60` để tự sát process cha mỗi phút + `-P fork` đẻ 6 con HLS → con mồ côi → Zombie nhân cấp số nhân. Fix đúng không phải là “kill mạnh hơn”, mà là **bỏ hẳn vòng lặp restart, chuyển sang 1 process 24/7 + cắt segment nội tại**.

---

## 2. Mổ xẻ quyết định kiến trúc then chốt

### 2.1. Source-based config (không phải Channel-based)

PRD yêu cầu sinh `.conf` theo Source. Đây là quyết định đúng nhất:

```
-I ip <IP_SOURCE>
-P fork "tsp -P zap <SID_1> -O hls --duration 5 --live 5 ..."   # kênh 1 live
-P fork "tsp -P zap <SID_2> -O hls --duration 5 --live 5 ..."   # kênh 2 live
-O hls --duration 60 --live 0 /captures/<SOURCE_ID>/capture_%05d.ts  # record tổng
# hoặc -O drop nếu is_record_all=false
```

**Brainstorm sâu:**
- Lợi: 1 NIC read 1 lần cho cả MPTS (VD 6 kênh chung 1 IP), tiết kiệm băng thông 6x so với mở 6 process ingest riêng.
- Rủi ro: 1 Source chết là chết chùm N kênh. → Bắt buộc có **auto-restart 5s + alert Telegram** (PRD mục 15).
- Edge case: Source có 0 kênh `is_live=true` + `is_record_all=false` → conf chỉ còn `-I ip ... -O drop` (vô nghĩa, tốn CPU). Nên chặn ở API: không cho Start khi cả 2 cờ đều false.
- Edge case: đổi `service_id` / thêm kênh khi đang RUNNING → phải **regen conf + restart graceful** (kill PGID cũ → spawn mới). Cần versioning conf (`conf_rev` trong DB) để debug.

### 2.2. Process Manager + PGID (linh hồn Phase 1)

```ts
// Pseudo-code chuẩn
child = spawn('tsp', [`@${confPath}`], { detached: true, stdio: ['ignore','ignore','pipe'] });
db.sources.update({ pid: child.pid, status: 'RUNNING' });
child.on('exit', (code, sig) => {
  if (!intentionalStop) scheduleRestart(5000);
  notifyTelegramIfNeeded(code);
});
child.stderr.on('data', parseContinuityError); // đếm CC error >10s → alert

// Stop:
process.kill(-child.pid, 'SIGTERM'); // dấu - là kill cả nhóm fork
```

**Điểm dễ sai:**
- Quên `detached:true` → `kill(-pid)` sẽ kill nhầm cả backend.
- `stdio` để default pipe mà không consume → đầy buffer → treo process. Nên `ignore` stdout, chỉ pipe stderr và drain liên tục.
- Zombie vẫn có thể sót nếu fork con double-fork. Nên Phase 1 phải có **test chứng minh**: `ps aux | grep defunct` = 0 sau 10 chu kỳ Start/Stop + script đếm `ps -o stat | grep Z`.

### 2.3. Node.js (TS) vs Go — chọn gì?

| Tiêu chí | Node.js TS (khuyến nghị Phase 1–3) | Go |
|---|---|---|
| Spawn/kill PGID | Dễ (`child_process`, lib `systeminformation` cho SSE) | Mạnh hơn, binary nhẹ cho Worker Node |
| Async Export + SSE | Hệ sinh thái sẵn (Express/Fastify, Winston/Pino) | Phải tự viết nhiều |
| Dev speed | Nhanh, dễ tuyển, khớp PRD ví dụ | Tốt cho Phase scale sau |
| RAM/CPU khi scale 50+ source | Đủ (vì nặng ở tsp, không ở backend) | Tốt hơn chút |

**Kết luận brainstorm:** Start bằng **Node.js + TypeScript + Fastify/Express + Prisma**. Khi lên Master-Worker (mục 14), viết **Worker agent bằng Go hoặc giữ Node** đều được — quan trọng là contract gRPC/Redis, không phải ngôn ngữ.

### 2.4. DB: SQLite vs PostgreSQL

- Dev/1 node: **SQLite + Prisma** là đủ, backup chỉ là copy 1 file.
- Prod/Multi-node: bắt buộc **PostgreSQL** (concurrency Export + GC + API cùng ghi).
- **Mâu thuẫn PRD cần chốt:** `retention_days` đang nằm ở `channels`, nhưng file record là MPTS tổng theo `sources` (`capture_%05d.ts` chứa N kênh). Vậy khi kênh A giữ 30 ngày, kênh B giữ 90 ngày, GC xóa file tổng theo chuẩn nào?
  - **Đề xuất A (đơn giản):** Chuyển `retention_days` lên `sources`. Cả MPTS chung 1 hạn.
  - **Đề xuất B (giữ PRD):** GC lấy `MAX(retention_days)` của các channel thuộc source. Ghi chú rõ trong UI.
  - Khuyến nghị chọn A cho Phase 2, tránh logic GC phức tạp sai.

Schema bổ sung cần thêm so với PRD:
```prisma
model Source { id, name, ip_address, is_record_all, retention_days?, status, pid, conf_rev, updatedAt }
model Channel { id, source_id, name, service_id, is_live, /* retention_days? */ }
model ExportJob { id, channel_id, service_id, in_point, out_point, status, file_path, size, error, created_by }
model User { id, username, email, password_hash, role, reset_token, reset_expires }
model SystemEvent { id, source_id?, level, message, createdAt } // cho log alert
```

---

## 3. Frontend brainstorm

### 3.1. Layout
- Sidebar dark `bg-slate-900` 2 khối: **Danh sách kênh (scroll)** + **Menu quản lý**. Header light + avatar dropdown (đổi MK, logout). Workspace `bg-slate-50` cards.
- Route: `/` (monitor) + `/channel/[id]` (live view) + `/sources` + `/channels` + `/exports` + `/login`. Middleware bảo vệ tất cả trừ `/login`.

### 3.2. System Monitor (SSE 2s)
- Dùng **SSE không phải WebSocket** (1 chiều server→client là đủ, nhẹ, auto-reconnect). Payload `{cpu, ram, swap, disk, net:{tx,rx}}` via `systeminformation`.
- Recharts: RadialBar CPU/RAM/SWAP/DISK (xanh <60, cam 60–85, đỏ >85) + AreaChart mạng (đỏ up, xanh lá down). Giữ rolling window 60 điểm (~2 phút).
- Cảnh báo disk >90% → banner đỏ + Telegram.

### 3.3. LivePlayer (chỗ dễ sập trình duyệt nhất)
```tsx
useEffect(() => {
  let hls: Hls | null = null;
  if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = streamUrl; // Safari
  else if (Hls.isSupported()) { hls = new Hls({ maxBufferLength: 15 }); hls.loadSource(streamUrl); hls.attachMedia(video); }
  return () => { hls?.destroy(); video.removeAttribute('src'); video.load(); }; // BẮT BUỘC
}, [streamUrl]);
```
- Ẩn seekbar (live), chỉ Play/Pause, Volume/Mute, Fullscreen.
- Thanh URL + nút Copy → tooltip “Đã sao chép” (dùng `navigator.clipboard`).
- Chuyển kênh = đổi route, không reload trang.

### 3.4. Auth
- Bcrypt salt 10, JWT 24h–7d trong **HttpOnly Cookie** (chống XSS), không localStorage.
- `middleware.ts` redirect `/login` nếu thiếu cookie. Backend `verifyAuth` trả 401 chặn spawn/chạm disk.
- Quên MK: luôn trả message chung chung chống enumerate email. Reset token TTL 15 phút. Đổi MK validate min 8 ký tự + confirm khớp.

---

## 4. Exporter (Catchup) brainstorm

Luồng chuẩn (async, không 504):
1. `POST /api/exports` → validate Out>In, duration ≤6h (cả FE + BE) → tạo `ExportJob(status=PROCESSING)` → trả 200 ngay.
2. Backend resolve In/Out → list file chunk vật lý → `spawn('tsp', ['-I','file', ...files, '-P','zap', sid, '-O','file', outPath])`.
3. `on('exit')`: code 0 → SUCCESS; !=0 → ERROR + `fs.unlinkSync` file dở.
4. Download: `Content-Disposition: attachment; filename=Kenh_DDMMYYYY_HHmm-HHmm.ts` + `fs.createReadStream().pipe(res)` (hoặc Nginx X-Accel-Redirect khi lên Prod). Luồng tải phải qua JWT.
5. Xóa: modal confirm → `unlink` file vật lý trước, rồi mới xóa row DB.

**Giới hạn đồng thời:** chỉ cho tối đa 2 export chạy cùng lúc (queue còn lại), tránh nghẽn I/O. Đây là ý tưởng bổ sung ngoài PRD nhưng rất cần.

---

## 5. Storage, Log, Infra

- **RAMDisk:** Prod bắt buộc `tmpfs` cho `/media/ramdisk/live`. Nếu không, IOPS HLS 5s/chunk × N kênh sẽ bào SSD. Script mount mẫu để trong `scripts/`.
- **GC:** cron mỗi giờ, `unlink` file quá hạn, giữ disk <85%. Thứ tự xóa: cũ nhất trước. Log mỗi lần xóa vào `SystemEvent`.
- **Log:** Winston/Pino async + rotation 15 ngày. Tách `tsduck-warnings.log` (packet loss, CC error, No input signal).
- **Docker:** Backend `network_mode: "host"` mới bắt multicast. Frontend/DB bridge bình thường.
- **Mạng:** Chuẩn hóa về `239.x.x.x` (RFC 2365). `sysctl`: `rp_filter=0`, `rmem_max/wmem_max ≥25MB`. Sinh sẵn `scripts/sysctl-vtc.conf`.
- **Remux không cần GPU:** PRD đúng — chỉ `-P zap` + `-O hls` là copy packet, ăn CPU + I/O, không decode/encode. Đừng đầu tư VGA.

---

## 6. 12 ý tưởng cải tiến (ngoài PRD, nên làm)

1. **Dry-run validate conf:** trước khi Start thật, chạy `tsp --version` + check file conf tồn tại + test `timeout 3s tsp @conf` để bắt lỗi cú pháp sớm.
2. **Conf versioning:** lưu mỗi lần regen vào `storage/conf/history/<SOURCE>_<rev>.conf` để rollback.
3. **Healthcheck HLS:** worker HEAD `index.m3u8` mỗi 30s, nếu playlist đứng >15s → coi như stale → auto-restart.
4. **Backpressure stderr:** dùng readline parse dòng, đếm CC-error sliding window 10s, tránh spam Telegram (cooldown 5 phút/source).
5. **Disk watermark 3 nấc:** 75% warn, 85% GC gấp, 90% alert critical + chặn export mới.
6. **Export queue (max 2 concurrent):** job thứ 3 trở đi ở trạng thái QUEUED.
7. **Tên file capture có timestamp:** `capture_20260912_103500_%05d.ts` thay vì chỉ số tăng dần → GC và map In/Out-point dễ hơn nhiều.
8. **API `GET /api/sources/:id/preview-conf`:** cho admin xem conf sẽ sinh ra trước khi Start (debug MPTS).
9. **Audit log:** ai Start/Stop/Export/Xóa (user, IP, thời gian) vào bảng `SystemEvent`.
10. **Seed demo mode:** không có multicast thật vẫn dev được — script sinh `.ts` giả + HLS mẫu vào `storage/`.
11. **Nginx anti-hotlink:** chỉ cho domain `luuchieu.truyenhinhso.vn` + check cookie JWT khi GET `.m3u8/.ts`.
12. **Telegram message template chuẩn:** `[CẢNH BÁO][<SOURCE>][<LEVEL>] <msg> lúc <time> — <action>` để filter dễ.

---

## 7. Rủi ro lớn nhất & cách né

| # | Rủi ro | Xác suất | Tác động | Cách né |
|---|---|---|---|---|
| 1 | Zombie tái phát do fork con sót | Cao nếu code ẩu | Sập PID/RAM | PGID + test `grep Z` Phase 1 |
| 2 | Mâu thuẫn retention channel vs file tổng | Cao | GC xóa sai, mất bằng chứng | Chuyển retention lên Source |
| 3 | Export 6h nghẽn I/O, OOM | TB | File lỗi, disk đầy | Queue max 2, unlink khi fail, chặn khi disk>90% |
| 4 | HLS stale nhưng process vẫn sống | TB | Màn hình đứng, tưởng live | Healthcheck playlist 30s |
| 5 | Multicast sai dải 227/238, rp_filter | Cao ở Prod | Không bắt được tín hiệu | Script sysctl + checklist mạng |
| 6 | hls.js leak khi trực 10 kênh liên tục | Cao | Chrome Aw Snap | Cleanup bắt buộc (mục 3.3) |
| 7 | JWT lộ / hotlink .m3u8 | TB | Bị câu trộm băng thông | HttpOnly + Nginx referer/JWT check |

---

## 8. Câu hỏi mở cần chủ dự án chốt (trước khi code Phase 2)

1. DB chốt **PostgreSQL hay SQLite** cho Prod? (khuyến nghị Postgres nếu >1 node).
2. `retention_days` theo Source hay Channel? (khuyến nghị Source).
3. Chunk catchup **60s hay 10 phút/file**? 60s → nhiều inode, dễ map giờ; 10 phút → ít file, GC nhẹ hơn.
4. SMTP/Nodemailer đã có account chưa? Telegram Bot token + group ID trực kỹ thuật?
5. Domain Prod chốt `luuchieu.truyenhinhso.vn`? Mount path có đúng `/media/ramdisk` + `/mnt/Data/catchup`?
6. Quy mô tối đa: bao nhiêu Source MPTS, bao nhiêu kênh, mỗi MPTS mấy chương trình? Để tính NIC/CPU/Dung lượng (VD 1 kênh HD ~6Mbps × 90 ngày ≈ 5.8TB).
7. Export có cần mux thêm audio-only (radio VOV) không, hay chỉ TV?

---

## 9. Kết luận để bắt đầu code

- Phase 1 chỉ cần 2 file là thắng: `ConfigGenerator.ts` + `ProcessManager.ts` + test Start/Stop sạch Zombie.
- Đừng nhảy vào UI vội. Backend sống 24/7 ổn định mới có gì để hiển thị.
- Mọi quyết định trên đã lưu ở đây làm “hợp đồng kiến trúc” — AI/code sau này lệch là lôi ra đối chiếu.

→ Tiếp theo đọc `02-ROADMAP.md` để làm theo checklist.
