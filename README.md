# VTCAIO — Hệ thống Lưu chiểu & Giám sát Phát sóng trực tuyến
(Hệ thống Catchup và xem lại các kênh phát sóng của VTC)

> Monorepo rebuild từ PRD 17 phần. Mục tiêu: **1 Source = 1 Process 24/7, không Zombie, không rò RAM.**

## Cấu trúc thư mục

```
VTCAIO/
├── README.md                    # File này
├── docs/
│   ├── 01-BRAINSTORM.md         # Nghiên cứu + brainstorm chi tiết (ĐỌC TRƯỚC)
│   └── 02-ROADMAP.md            # Kế hoạch 6 Phase để bắt đầu code
├── apps/
│   ├── backend/src/
│   │   ├── core/                # ConfigGenerator, ProcessManager (Phase 1)
│   │   ├── db/                  # Prisma schema (Phase 2)
│   │   ├── api/                 # REST + SSE (Phase 2)
│   │   └── jobs/                # Garbage Collector (Phase 3)
│   └── frontend/src/
│       ├── app/                 # Next.js App Router
│       ├── components/          # LivePlayer, Charts
│       └── hooks/
├── storage/
│   ├── ramdisk/                 # Dev giả lập /media/ramdisk/live (Prod mount tmpfs)
│   └── captures/                # Dev giả lập /mnt/Data/catchup/captures (Prod mount HDD)
├── scripts/                     # sysctl tuning, ramdisk mounter (Phase 6)
└── docker-compose.yml           # (Phase 6)
```

## Nguyên tắc vàng (từ bài học 19.044 Zombie)

1. **TUYỆT ĐỐI KHÔNG dùng `--max-duration`** để cắt file. Cắt file = `-O hls --duration 60 --live 0`.
2. **Mỗi Source 1 tiến trình `tsp @xxx.conf` duy nhất**, chạy 24/7.
3. **Kill phải kill cả nhóm:** `detached: true` + `process.kill(-pid, 'SIGTERM')`.
4. **Frontend chuyển kênh phải `hls.destroy()`** + xóa `src` video tag.
5. **Export chạy async**, chỉ mark success khi `exit code === 0`, fail thì `unlink` file dở.

## Đọc tiếp

- `docs/01-BRAINSTORM.md` — toàn bộ phân tích, rủi ro, câu hỏi mở, 12 ý tưởng cải tiến.
- `docs/02-ROADMAP.md` — checklist từng Phase 1→6, việc đầu tiên nên code là gì.
- `docs/03-DEMO-CLI.md` → `docs/12-YEU-CAU-HE-THONG.md` — demo, API, auth, jobs, exporter, deploy, yêu cầu HW/OS/SW.

## Chạy nhanh (không cần server mạnh)

```sh
cd apps/backend && npm install && npm run dev    # :8080
cd apps/frontend && npm install && npm run dev   # :3000
docker compose --profile demo up -d --build      # cần Docker: demo TSDuck
```

## Dev paths (thống nhất để code không lệch Prod)

| Mục đích | Production | Dev (trong repo này) |
|---|---|---|
| HLS Live | `/media/ramdisk/live/[CHANNEL_ID]/` | `./storage/ramdisk/live/[CHANNEL_ID]/` |
| Catchup chunk | `/mnt/Data/catchup/captures/[SOURCE_ID]/` | `./storage/captures/[SOURCE_ID]/` |
| tsp conf | `/opt/vtc/conf/sources/[SOURCE_ID].conf` | `./storage/conf/sources/[SOURCE_ID].conf` |
| Export output | `/mnt/Data/catchup/exports/` | `./storage/exports/` |
