# B5 — API core (CRUD + start/stop + preview-conf + SSE)

> `tsc` sạch, `npm test` **13/13 xanh** (4 Config + 4 Process + 5 API). Zero runtime dependency.

## Chạy

```sh
cd apps/backend && npm install
npm run dev          # :8080 — PORT=8081 npm run dev để đổi port
curl localhost:8080/health
```

## Endpoints (xem `src/api/server.ts`)

| Method | Route | Ghi chú |
|---|---|---|
| GET | `/health` | `{ok:true}` |
| GET/POST | `/api/sources` | list / tạo `{id,input,channels,recordAll}` |
| GET/PUT/DELETE | `/api/sources/:id` | sửa/xóa chỉ khi STOPPED |
| GET | `/api/sources/:id/preview-conf` | xem conf trước khi start (debug MPTS) |
| POST | `/api/sources/:id/start` | ghi conf + `tsp @conf` → `{pid, conf}` + hẹn spawn ffmpeg kênh transcode |
| POST | `/api/sources/:id/stop` | kill nhóm PGID (diệt ffmpeg trước, tsp sau) |
| GET | `/api/system/stream` | SSE 2s `{cpu,ram_used,disk_percent,network:{tx,rx}}` |
| GET/POST | `/api/presets` | list / tạo preset transcode (chi tiết docs/16 §8.3) |
| PUT/DELETE | `/api/presets/:id` | sửa (kênh chạy không ảnh hưởng) / xóa (đang dùng thì 400) |
| PUT | `/api/sources/:id/channels/:name/transcode` | `{transcode}` hai tầng: cấu trúc khi RUNNING → 400, endpoint → hot-restart ffmpeg |
| POST | `/api/sources/:id/channels/:name/transcode-start` | start tay ffmpeg (source phải RUNNING) |
| POST | `/api/sources/:id/channels/:name/transcode-stop` | stop tay ffmpeg (không động tsp) |
| POST | `/api/sources/:id/channels/:name/srt-test` | `{port}` → caller bắt tay 8s vào srt-listen của kênh |
| GET | `/api/transcode/status` | snapshot mọi ffmpeg `{key,pid,fps,bitrateKbps,stale,crashes}` |

Ví dụ nhanh:

```sh
curl -X POST localhost:8080/api/sources -H 'content-type: application/json' -d \
 '{"id":"DEMO","input":"file /tmp/vtc-demo/input.ts --repeat","recordAll":true,"channels":[{"name":"demo4","serviceId":4,"isLive":true}]}'
curl localhost:8080/api/sources/DEMO/preview-conf
curl -X POST localhost:8080/api/sources/DEMO/start
curl -N localhost:8080/api/system/stream   # Ctrl+C để thoát
curl -X POST localhost:8080/api/sources/DEMO/stop
```

## Thiết kế

- `store.ts` in-memory (thay bằng Prisma+Postgres ở Phase 2b, không sửa `server.ts`).
- `system.ts` đọc `node:os` + `/proc/net/dev` + `df` (thay `systeminformation` sau).
- Mọi lỗi trả JSON `{error}` với mã 400/404/500 đúng nghĩa; config xấu (tên kênh, sid) bị chặn 400 ngay lúc tạo/sửa, không đợi tới start.
- Crash không chủ đích → `ERROR` + Telegram + **auto-restart sau 5s** (`restartDelayMs`) với conf mới nhất; stop tay/xóa record thì không restart.
- Chưa có auth — là bước tiếp theo (B6: bcrypt + JWT HttpOnly + `verifyAuth` + `middleware.ts`).

## Verify

`src/api/api.test.ts` chạy server thật trên port ngẫu nhiên: health, CRUD, preview-conf khớp ConfigGenerator, start/stop bằng fake tsp (`exec sleep`, kill nhóm thật), SSE đọc 1 event `data:`.
