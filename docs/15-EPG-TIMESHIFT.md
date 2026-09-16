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

## Timeshift SPTS (E2)

- Ranh giới sản phẩm: **SPTS phát trực tiếp, MPTS báo thẳng dùng Trích xuất**.
  Phân biệt bằng PAT thật (`probeProgramCount` đọc chunk mới nhất), không tin
  cấu hình (nguồn 1 kênh vẫn có thể trỏ luồng MPTS).
- `GET /api/timeshift/:channel?in=&out=` (ISO/epoch, tối đa 6h): resolve chunk
  theo mtime → probe → dựng m3u8 ảo trong RAM (`MEDIA-SEQUENCE` theo số chunk,
  `DISCONTINUITY` khi gap > 1.5 chunk, `ENDLIST` vì khoảng đóng) → player tua được.
- Segment trỏ `GET /api/timeshift/chunks?source=&file=&channel=&token|pull=`
  (stream byte, chặn traversal, 404 khi GC đã dọn). Auth: cookie/Bearer như
  thường, hoặc token kênh trên URL (miễn gate, handler kiểm chặt lại).
- Player `LivePlayer` thêm mode `vod` (seekbar + giờ, giữ cleanup chống leak RAM).
- Hết retention/khoảng trống → 400/404 câu rõ ràng, UI hiện nguyên văn.
