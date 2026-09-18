# Demo B1 — Chạy TSDuck đúng cách trong 5 phút

> Mục tiêu: 1 process `tsp` chạy liên tục, vừa ra Live HLS vừa ghi Catchup, **không Zombie**.

## 1. Build & vào container (Ubuntu 22.04 + TSDuck chính thức)

```sh
cd /workspace/VTCAIO
docker compose up -d --build tsduck
docker compose exec tsduck tsp --version
```

## 2. Chạy demo Live + Catchup (file mẫu tsduck.io)

```sh
docker compose exec tsduck sh /work/scripts/demo-cli.sh
# Mở terminal khác xem output:
docker compose exec tsduck ls -lh /media/ramdisk/live/demo/
docker compose exec tsduck cat /media/ramdisk/live/demo/index.m3u8
docker compose exec tsduck ls -lh /mnt/Data/catchup/captures/DEMO/
```

Chỉ Live (không ghi đĩa):

```sh
docker compose exec tsduck sh /work/scripts/demo-cli.sh --live-only
```

Dừng: `Ctrl+C` trong terminal chạy demo (SIGINT dừng cả cha lẫn fork con).

## 3. Chứng minh không Zombie (chạy trên HOST)

```sh
sh scripts/check-zombie.sh
# kỳ vọng: tsp_processes=... zombie=0
sh scripts/check-zombie.sh --watch
```

Start/Stop 10 lần rồi check lại — `zombie` phải luôn `0`.
Hệ cũ sai ở `--max-duration 60` (tự sát cha mỗi phút) → con `fork` mồ côi.

## 4. Ánh xạ sang VTCAIO thật

| Demo | Prod (MPTS multicast) |
|---|---|
| `-I file --repeat input.ts` | `-I ip 239.x.x.x:port` |
| `-P zap 5` | `-P zap <service_id từng kênh>` |
| `-P fork "tsp ... -O hls .../segment.ts"` | 1 fork/kênh `is_live=true` |
| `-O hls --duration 60 --live 0 captures/...` | `is_record_all=true`, ngược lại `-O drop` |
| `SERVICE_ID=5 sh demo-cli.sh` | `ConfigGenerator` sinh `.conf` theo Source |

## 5. Xử lý sự cố

- `curl tải thất bại`: kiểm tra mạng container, hoặc tải tay file `.ts` vào `storage/`.
- HLS lâu ra segment đầu: thêm `--max-input-packets 1000` (đã có sẵn, theo issue #405).
- `symbol tspNewProcessor not found` với `tsplugin_hls.so`: bạn đang gọi `tsp -P hls` trong nhánh fork — `hls` là **output**, phải dùng `-O hls`, không phải `-P hls`.
