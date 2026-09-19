# B4 — Backend core: ConfigGenerator + ProcessManager (Node TS)

> `tsc --noEmit` sạch, `npm test` 8/8 xanh. Logic port 1-1 từ `scripts/gen-conf.sh` (đã diff `IDENTICAL`).

## File

- `apps/backend/src/core/types.ts` — `SourceConfig/ChannelConfig/GeneratedConf/SourceStatus/CcErrorEvent`.
- `apps/backend/src/core/ConfigGenerator.ts` — `generateConfText()` (thuần túy) + `writeConfFile()` (ghi `storage/conf/<id>.conf`). Validate: tên `[A-Za-z0-9_-]`, sid 0–65535, chặn conf vô nghĩa (0 live + record false).
- `apps/backend/src/core/ProcessManager.ts` — `start()` spawn `tsp @conf` với `detached:true`, `stdio:['ignore','ignore','pipe']`; `stop()` kill nhóm `(-pid, SIGTERM)` → timeout `SIGKILL`; drain stderr parse CC-error → event; crash không chủ đích → `ERROR` (caller Phase 2 gọi lại `start()` với conf mới, không restart mù).
- `apps/backend/src/core/TranscodeManager.ts` — như ProcessManager nhưng cho ffmpeg (PGID riêng, `stdio` pipe cả stdout để đọc `-progress`).
- `apps/backend/src/core/TranscodeConfigGenerator.ts` — preset seed + zod schema + `buildFfmpegArgs()`/`buildPullerArgs()`/`buildCaptureArgs()` thuần túy (không cần ffmpeg thật để test).
- `apps/backend/src/api/transcodeService.ts` — gom nghiệp vụ transcode/puller/capture (preset store + persist, spawn/kill, restart/alert, probe SRT, validate cổng); `server.ts` chỉ còn định tuyến HTTP + lifecycle tsp.
- `src/core/*.test.ts` — 4 + 4 test, chạy không cần tsp thật (fake script `exec sleep`).
- `src/demo-gen.ts` — `npm run gen:demo` in conf DEMO ra terminal.

## Chạy

```sh
cd apps/backend && npm install
npx tsc --noEmit -p tsconfig.json
npm test
npm run gen:demo
```

## Bài học Zombie tái hiện ngay trong test (quan trọng)

Khi verify, `check-zombie.sh` báo 6–7 zombie `esbuild/sleep` với `ppid=1`:

1. **Fake script đầu tiên viết `sleep 30` (không `exec`)** → `sh` (con trực tiếp, Node reap được) chết trước, `sleep` (cháu) mồ côi về PID 1. **Đúng y cơ chế 19k Zombie trong PRD** (`tsp` cha chết → fork con mồ côi). Fix: fake script dùng `exec sleep 30` — bài học ghi thẳng vào comment test.
2. **PID 1 của box dev hiện tại là `opencode`, không reap con mồ côi** (không phải init đúng nghĩa) → zombie cũ không bao giờ mất cho tới khi restart container. Đây là lý do `docker-compose.yml` đã thêm `init: true` (tini) cho service `tsduck`, và Prod phải dùng init/systemd đúng chuẩn.
3. **Test UT1/UT2 ban đầu dùng `sleep @300`** — `sleep` thoát ngay vì arg `@300` không hợp lệ, nên test "stop sạch" là giả (không có process thật để kill). Đã sửa: fake script bỏ qua arg, `exec sleep 60`, test thăm dò `kill(pid, 0)` trước stop và `ESRCH` sau stop — kill nhóm PGID được kiểm chứng thật.

Check Zombie đúng chỗ: **trong container `tsduck` (có tini) hoặc host Prod**, không phải box dev này.
