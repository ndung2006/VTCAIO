#!/bin/sh
# ==============================================================================
# prod-check.sh — Kiểm tra máy Prod đạt yêu cầu hạ tầng (PRD §11 + §16) TRƯỚC
# khi `docker compose --profile prod up`. Chạy trên HOST Ubuntu (sudo):
#   sudo sh scripts/prod-check.sh
# Exit 0 = đạt; exit 1 + dòng [FAIL] = phải sửa.
# ==============================================================================
set -eu

PASS=0; FAIL=0
ok() { printf '[PASS] %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '[FAIL] %s\n' "$*"; FAIL=$((FAIL + 1)); }

log() { printf '[prod-check] %s\n' "$*"; }

# --- 1. OS + kernel tuning (multicast) ---
if [ -f /etc/os-release ]; then
    log "OS: $(grep PRETTY_NAME /etc/os-release | cut -d= -f2)"
fi

rp=$(cat /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null || echo "?")
if [ "$rp" = "0" ]; then ok "rp_filter=0 (nhận multicast ngoài default gateway)"; else bad "rp_filter=$rp, cần 0 — áp dụng scripts/sysctl-vtc.conf"; fi

rmem=$(cat /proc/sys/net/core/rmem_max 2>/dev/null || echo 0)
if [ "$rmem" -ge 26214400 ]; then ok "rmem_max=$rmem (≥25MB)"; else bad "rmem_max=$rmem, cần ≥26214400 — áp dụng sysctl-vtc.conf"; fi

# --- 2. RAMDisk tmpfs cho HLS của VTCAIO (tách riêng khỏi hệ cũ /media/ramdisk/live) ---
if mount | grep -q " /media/ramdisk/vtcaio .*tmpfs"; then
    ok "tmpfs đã mount tại /media/ramdisk/vtcaio"
else
    bad "/media/ramdisk/vtcaio chưa mount tmpfs — chạy scripts/mount-ramdisk.sh"
fi

# --- 3. Ổ vtcaio + dung lượng trống (tách riêng khỏi /mnt/Data/catchup của hệ cũ) ---
if [ -d /mnt/Data/vtcaio/captures ]; then
    free_pct=$(df -P /mnt/Data/vtcaio/captures | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
    if [ "$free_pct" -lt 85 ]; then ok "captures đã dùng ${free_pct}% (<85%)"; else bad "captures đã dùng ${free_pct}% — dọn trước khi lên sóng"; fi
else
    bad "/mnt/Data/vtcaio/captures chưa tồn tại — mount HDD/SAN trước"
fi
if [ -d /opt/vtcaio/conf/sources ]; then
    ok "conf dir /opt/vtcaio/conf/sources tồn tại"
else
    bad "/opt/vtcaio/conf/sources chưa tồn tại — mkdir trước khi up backend"
fi

# --- 4. Docker ---
if command -v docker >/dev/null 2>&1; then ok "docker: $(docker --version)"; else bad "chưa cài docker"; fi

# --- 5. GPU NVIDIA (chỉ khi dùng image transcode GPU: VTC_GPU=1) ---
if [ "${VTC_GPU:-0}" = "1" ]; then
    if command -v nvidia-smi >/dev/null 2>&1; then
        ok "nvidia-smi driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
        log "GPU model: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1) (floor docs/16: Turing+, driver ≥550 — GTX 770/Kepler không dùng được)"
    else
        bad "VTC_GPU=1 nhưng thiếu nvidia-smi — cài driver NVIDIA host trước"
    fi
    if command -v nvidia-container-runtime >/dev/null 2>&1; then
        ok "nvidia-container-runtime đã cài (docker thấy được GPU)"
    else
        bad "thiếu nvidia-container-runtime — cài NVIDIA Container Toolkit trước"
    fi
    log "CHECK tay (GPU): card GeForce giới hạn ~3-5 session NVENC đồng thời — đếm kênh nvenc (xem docs/16 §3.2). Card datacenter (T4/L4/A2) không giới hạn."
else
    log "GPU: bỏ qua (VTC_GPU!=1 — image CPU chỉ cần libx264). Muốn transcode nvenc thì VTC_GPU=1 sh scripts/prod-check.sh"
fi

# --- 6. Danh sách kiểm tra bằng tay (không tự động được) ---
log "CHECK tay: IP multicast đã về dải 239.x.x.x (RFC 2365)?"
log "CHECK tay: firewall mở 8082 (nginx VTCAIO), 18081 (API VTCAIO)? Hệ cũ giữ 80 + 18080."
log "CHECK tay: port 18081 + 8082 + 8083 còn trống (ss -ltnp | grep -E '18081|8082|8083')?"
log "CHECK tay: .env.prod đã điền JWT secret + admin pass mạnh?"
log "CHECK tay: Telegram bot token + chat ID tổ trực?"
# --- 7. Transcode SRT/RTMP (docs/16 §10 — chỉ khi bật truyền dẫn) ---
# KHÔNG check tự động port 9000-9199/7000-7099 còn trống: hệ đang chạy giữ
# các port đó nên check máy sống là FAIL oan — kiểm tra tay lúc deploy.
log "CHECK tay (transcode): firewall UDP 9000:9199 (SRT listen) + UDP 7000:7099 (mcast-out 236.30.x) đã mở?"
log "CHECK tay (transcode): VTC_SRT_PASSPHRASES đã đặt (mỗi ref ≥16 ký tự)?"
log "CHECK tay (transcode): đối tác push RTMP thì MTX_PUBLISH_PASS đã đổi + mediamtx up (1935/TCP)?"

printf '[prod-check] PASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
