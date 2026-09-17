# 15 — EPG đối tác + Timeshift SPTS

## EPG ingest (E1)

- Nguồn: `VTC_EPG_BASE_URL` + `VTC_EPG_API_KEY` (X-API-Key). Worker poll mỗi
  `VTC_EPG_SYNC_MINUTES` (mặc định 10) + nút Đồng bộ ngay (`POST /api/admin/epg-sync`).
- Cửa sổ mặc định: 2 ngày trước → 7 ngày sau (`VTC_EPG_PAST_DAYS/FUTURE_DAYS`).
- So batch `updatedAt` theo cặp kênh+ngày (đối tác dùng 1 mốc cho cả ngày);
  mới hơn thì thay cả ngày — chương trình vắng mặt = đã xoá (đúng spec §6).
- Map kênh: `partnerChannelId` trong ChannelConfig (số nguyên ≥1, duy nhất).
  Sửa ở trang EPG (đòi nguồn STOPPED). Tra ID ở `GET /api/epg/partner-channels`.
- Store JSON `epg.db.json` cạnh `sources.db.json` (vài MB với 44 kênh × 10 ngày).
- Đọc: `GET /api/epg/schedule?channel=<tên-local>&date=YYYY-MM-DD`,
  `GET /api/epg/status`, Xuất EPG = tải JSON ngày đang xem.
- Danh mục public cho VTVgo có thêm `epgId` (cộng, không phá schema cũ).

## Timeshift luôn lọc SID, không probe (E2)

- Ranh giới sản phẩm: playlist **luôn gắn `?sid=<serviceId>`**, endpoint chunks
  lọc đúng 1 chương trình bằng `tsp -P zap` rồi pipe ra. SPTS = passthrough
  (đúng pipeline live `-P zap` chạy 24/7), MPTS = lọc. SID validate 1..65535 lúc
  tạo nguồn (+ nút Quét luồng), mismatch 400.
- Bài học 17/09/2026 (Prod): bản đầu probe PAT bằng `tsp` spawn theo click để
  phân biệt SPTS/MPTS — treo request không lý do dưới tải (exit/timer mất tích
  dù loop sống, curl timeout 20-40s với 0 byte, mọi bước lẻ đo riêng đều nhanh).
  Bỏ probe khỏi đường request → playlist chỉ còn resolve chunks (87ms) + stat +
  build, không spawn gì → hết treo theo thiết kế. `probeProgramCount` giữ lại
  làm utility có test (không dùng trong request nóng).
- `GET /api/timeshift/:channel?in=&out=` (ISO/epoch, tối đa 6h): resolve chunk
  theo mtime → dựng m3u8 ảo trong RAM (`MEDIA-SEQUENCE` theo số chunk,
  `DISCONTINUITY` khi gap > 1.5 chunk, `ENDLIST` vì khoảng đóng) → player tua được.
- Segment trỏ `GET /api/timeshift/chunks?source=&file=&channel=&sid=&token|pull=`
  (stream, chặn traversal, 404 khi GC đã dọn). Auth: cookie/Bearer như
  thường, hoặc token kênh trên URL (miễn gate, handler kiểm chặt lại).
  `sid` phải khớp serviceId của channel trong cấu hình (400 nếu lệch — chống xem
  ké program khác cùng mux); zap pipe có timeout 60s + kill khi client ngắt.
- Lưới an toàn giữ lại: mọi lỗi lạ trong dựng playlist → 500 + log,
  không bao giờ để treo câm (log warn). Container chạy `init: true` (tini) để thu dọn
  tiến trình `tsp` con (trước đó zombie tồn từ boot).
- Player `LivePlayer` thêm mode `vod` (seekbar + giờ, giữ cleanup chống leak RAM).
- Hết retention/khoảng trống → 400/404 câu rõ ràng, UI hiện nguyên văn.

## Split-view trang kênh (E3)

- `/channel/[id]`: player Live cố định + panel EPG (date picker mặc định ngày
  mới nhất có lịch, highlight ĐANG PHÁT, nút **Xem** → timeshift vod ngay trong
  trang + nút **Về Live**, **Trích xuất** → sang `/exports` prefill sẵn kênh +
  In/Out (đọc query, không cần Suspense), **Xuất EPG** tải JSON ngày).
- Kênh chưa map EPG: chỉ hiện player (không báo lỗi, không đòi hỏi).
