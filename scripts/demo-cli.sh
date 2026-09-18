#!/bin/sh
# ==============================================================================
# VTCAIO Demo B1 — TSDuck CLI đúng cách (Live HLS + Catchup song song)
# POSIX sh (chạy được trên Alpine/sh và Ubuntu/bash).
#
# Cách dùng ĐÚNG (1 process 24/7, không --max-duration):
#   tsp -I file <input.ts> -P zap <SID> -P fork "<HLS con>" -O hls <catchup>
#
# Cách SAI của hệ cũ (gây 19k Zombie — KHÔNG làm theo):
#   tsp --max-duration 60 ... -P fork ...   # tự sát cha mỗi phút -> con mồ côi
#
# Chạy trong Docker Ubuntu 22.04:
#   docker compose up -d --build tsduck
#   docker compose exec tsduck sh /work/scripts/demo-cli.sh
#   docker compose exec tsduck sh /work/scripts/demo-cli.sh --live-only
# =============================================================================
set -eu

# --- Cấu hình (đổi được qua biến môi trường) ---
SAMPLE_URL="${SAMPLE_URL:-https://tsduck.io/streams/test-patterns/test-3packets-04-05-06.ts}"
WORK_DIR="${WORK_DIR:-/tmp/vtc-demo}"
INPUT_TS="$WORK_DIR/input.ts"
LIVE_DIR="${LIVE_DIR:-/media/ramdisk/live/demo}"
CAP_DIR="${CAP_DIR:-/mnt/Data/catchup/captures/DEMO}"
SERVICE_ID="${SERVICE_ID:-5}"

LIVE_ONLY=0
if [ "${1:-}" = "--live-only" ]; then
    LIVE_ONLY=1
fi

log() { printf '[vtc-demo] %s\n' "$*"; }
die() { printf '[vtc-demo][ERROR] %s\n' "$*" >&2; exit 1; }

# --- 0. Kiểm tra tsp ---
command -v tsp >/dev/null 2>&1 || die "chưa có lệnh tsp. Hãy chạy trong container tsduck."
log "tsp version: $(tsp --version 2>&1 | head -n 1)"

# --- 1. Chuẩn bị thư mục (RAMDisk HLS + HDD catchup) ---
mkdir -p "$WORK_DIR" "$LIVE_DIR" "$CAP_DIR"
log "LIVE_DIR=$LIVE_DIR CAP_DIR=$CAP_DIR SERVICE_ID=$SERVICE_ID"

# --- 2. Tải file mẫu (chỉ tải 1 lần, cache lại) ---
if [ ! -s "$INPUT_TS" ]; then
    log "downloading sample: $SAMPLE_URL"
    if command -v curl >/dev/null 2>&1; then
        curl -fL -o "$INPUT_TS" "$SAMPLE_URL" || die "curl tải thất bại"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$INPUT_TS" "$SAMPLE_URL" || die "wget tải thất bại"
    else
        die "cần curl hoặc wget để tải file mẫu"
    fi
else
    log "reuse cached input: $INPUT_TS"
fi
ls -lh "$INPUT_TS"

# --- 3. Chạy demo ---
# LƯU Ý TSDuck:
#  - -P zap <SID>: lọc 1 service từ MPTS (theo PRD dùng service_id).
#  - -P fork "tsp ... -O hls ...": nhánh Live HLS 5s/segment trên RAMDisk.
#    fork là packet-plugin: mỗi packet đi qua cả nhánh con lẫn pipeline chính.
#  - -O hls --live 0: nhánh chính ghi catchup, tự cắt segment, KHÔNG chết process.
#  - --max-input-packets/--max-flushed-packets nhỏ: giảm trễ HLS (issue #405).
if [ "$LIVE_ONLY" -eq 1 ]; then
    log "mode=live-only (không ghi catchup)"
    # shellcheck disable=SC2086
    exec tsp \
        -I file --repeat "$INPUT_TS" \
        -P zap "$SERVICE_ID" \
        -O hls \
            --duration 5 --live 5 \
            --playlist "$LIVE_DIR/index.m3u8" \
            "$LIVE_DIR/segment.ts"
else
    log "mode=live+catchup (1 process, 2 nhánh)"
    log "xem playlist tại: $LIVE_DIR/index.m3u8"
    log "chunk catchup tại: $CAP_DIR/catchup_%05d.ts"
    log "nhấn Ctrl+C để dừng (KHÔNG dùng --max-duration)"
    # Nhánh fork con cũng là 1 lệnh tsp độc lập — tsp cha quản lý qua pipe,
    # dừng cha (SIGTERM/SIGINT) là dừng cả con, không Zombie.
    # shellcheck disable=SC2086
    exec tsp \
        --max-input-packets 1000 --max-flushed-packets 1000 \
        -I file --repeat "$INPUT_TS" \
        -P zap "$SERVICE_ID" \
        -P fork "tsp -P zap $SERVICE_ID -O hls --duration 5 --live 5 --playlist $LIVE_DIR/index.m3u8 $LIVE_DIR/segment.ts" \
        -O hls --duration 60 --live 0 \
            "$CAP_DIR/catchup_%05d.ts"
fi
