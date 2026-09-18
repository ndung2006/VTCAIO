# Plugin `vtcmonitor` — Giám sát CC-error cho VTCAIO

> Code sạch, comment rõ, tuân thủ style TSDuck (`ProcessorPlugin`, `TS_REGISTER...`, `option()/help()/info()/warning()/verbose()`).

## File

- `tsplugin_vtcmonitor.cpp` — toàn bộ plugin (1 file như `sample-plugin` official).
- `Makefile` — dùng `tsconfig --cflags/--libs/--so/--plugin` (copy từ sample official).

## Options

| Option | Ý nghĩa | Mặc định |
|---|---|---|
| `-P vtcmonitor --pid N` | Chỉ theo dõi PID N | tất cả PID (trừ null 0x1FFF) |
| `--log-interval N` | Log tiến độ mỗi N packet | 100000 (0 = tắt) |
| `--event-code N` | `signalPluginEvent(N)` mỗi lỗi CC để app libtsduck bắt | 0 = tắt |

## Build & chạy (trong container)

```sh
docker compose up -d --build tsduck
docker compose exec tsduck sh -c "cd /work/plugins/vtcmonitor && make && make install"
docker compose exec tsduck tsp -P vtcmonitor --help
docker compose exec tsduck sh /work/scripts/demo-monitor.sh
```

Kỳ vọng output: dòng `vtcmonitor: total=... packets, cc-errors=...`.
File mẫu test lặp 2 lần có thể báo vài CC-error ở điểm nối — đó là hành vi đúng để test alert.

## Tích hợp VTCAIO

- Chèn vào pipeline Prod trước fork HLS để bắt lỗi sớm:
  `tsp -I ip ... -P vtcmonitor -P zap ... -P fork ... -O hls ...`
- Backend parse `stderr` dòng `CC error pid=...` → đếm sliding-window 10s → Telegram (theo `docs/01-BRAINSTORM.md` §5).
- Bước sau: app C++ dùng `TSProcessor::registerEventHandler` bắt `--event-code` trực tiếp thay vì parse log.

## Giới hạn đã biết (ghi rõ trong code)

Bản này chưa loại trừ packet adaptation-only (CC giữ nguyên là hợp lệ) — tỉ lệ báo thừa thấp, chấp nhận cho cảnh báo sớm. Muốn chính xác tuyệt đối thì thêm `hasPayload()` + discontinuity-indicator (sẽ làm ở bản tiếp theo cùng bạn).
