# Phase 4 — Frontend Next.js (Dashboard + Live + Auth guard)

> `tsc` sạch (strict), `npm test` 2/2, `next build` OK 5 routes.

## Cấu trúc (`apps/frontend/src/`)

- `app/layout.tsx` — khung xám `bg-slate-50`; `app/page.tsx` — dashboard giám sát.
- `app/channel/[id]/page.tsx` — **Live view PRD §4.7**: tiêu đề IN HOA + Stream Link Box + nút Copy (tooltip "Đã sao chép") + player 16:9.
- `app/login/page.tsx` — form độc lập (PRD §4.8), lỗi chung chung.
- `app/sources/page.tsx` — CRUD nguồn + kênh nhúng (validate trùng tên instant ở client, chặn cứng ở API) + form puller RTMP / capture SDI + badge trạng thái puller/capture.
- `app/channels/page.tsx` — tồn kho mọi kênh (tìm kiếm, bật/tắt Live, HLS age/stale, cảnh báo trùng tên, nút Link kéo luồng pull, cột TĐ trạng thái ffmpeg), link trong Sidebar.
- `app/transcode/page.tsx` — CRUD preset encode (docs/16).
- `components/TranscodePanel.tsx` — tab Truyền dẫn trong trang kênh: toggle/engine/loopback, preset multi-select, bảng outputs (SRT/RTMP/UDP), tick mã hóa, nút Test, status poll 5s.
- `app/epg/page.tsx` — quản lý EPG (map kênh, đồng bộ tay, xem lịch ngày, Xuất EPG).
- `app/channel/[id]/page.tsx` — split-view: player Live + panel EPG (now-playing, Xem timeshift, Trích xuất prefill, Xuất EPG).
- `app/exports/page.tsx` — tối thiểu Phase 4 (form export validate Out>In, ≤6h ở client; API async Phase 5) + prefill từ EPG (`?channel=&in=&out=`).
- `components/LivePlayer.tsx` — mode `live` (ẩn seekbar) / `vod` (seekbar + giờ); Safari native cũng tự cấp link khi lỗi.
- `components/LivePlayer.tsx` — **hls.js + lifecycle chống leak**: Safari native thì gán `src`; còn lại `Hls.isSupported()` + `attachMedia`; cleanup `hls.destroy()` + `removeAttribute('src')` + `load()` mỗi khi `streamUrl` đổi. Controls tự làm (Play/Pause, Mute, Fullscreen), không seekbar vì Live.
- `components/SystemMonitor.tsx` — SSE `/api/system/stream` (EventSource, unmount thì close), RadialBar CPU/RAM/DISK + AreaChart Tx(đỏ)/Rx(xanh).
- `components/Sidebar.tsx` (dark, kênh + menu) + `Header.tsx` (avatar dropdown logout) + `CopyButton.tsx`.
- `lib/api.ts` — fetch `credentials:'include'` (cookie HttpOnly đi kèm); `hlsUrl()` từ `NEXT_PUBLIC_HLS_BASE`.
- `lib/monitor.ts` — ngưỡng màu + cửa sổ trượt (có test).
- `middleware.ts` — thiếu cookie `vtc_token` → redirect `/login` (trừ `/api/*` để backend trả 401 JSON đúng nghĩa cho SSE/fetch; verify chữ ký do backend gate).

## Chạy

```sh
cd apps/frontend && npm install
cp .env.example .env   # VTC_API_ORIGIN trỏ backend :8080
npm run dev            # :3000 — /api rewrite về backend (cùng origin, khỏi CORS)
```

Backend phải chạy (`apps/backend: npm run dev`) để login/SSE/sources có dữ liệu.

## Lưu ý

- Next 14 bản vá mới nhất (không dùng bản dính cảnh báo bảo mật).
- `next.config.js` rewrite `/api/:path*` → backend nên cookie đi cùng origin; Prod thay bằng Nginx.
- HLS `NEXT_PUBLIC_HLS_BASE`: dev `http://localhost:8081/hls` (service `demo-hls` serve `./storage/ramdisk`, vì `next dev` không serve `/hls`) — Prod `/hls` cùng origin qua Nginx + anti-hotlink.
