#!/bin/sh
# ==============================================================================
# gen-conf.sh — Sinh tsp .conf theo Source (MPTS), đúng PRD §3.1 + fix Zombie.
# POSIX sh. Đây là bản shell của ConfigGenerator (logic PORT 1-1 với Node).
#
# ĐỊNH DẠNG (bài học 15/09/2026, đo trên TSDuck 3.44 thật): `@file` hiểu mỗi
# DÒNG là 1 argv — ghi `-I ip ...` chung dòng là tsp nhai từng ký tự. Vì vậy
# mỗi argument 1 dòng, không comment, không ngoặc kép (chuỗi fork là 1 dòng).
#
# Quy tắc:
#   - 1 Source = 1 file .conf = 1 process tsp @conf chạy 24/7.
#   - TUYỆT ĐỐI KHÔNG --max-duration. Cắt chunk = -O hls --live 0.
#   - Mỗi kênh is_live=true sinh 1 fork HLS con trên RAMDisk.
#   - Kênh có field thứ 4 loopbackPort (6000-6099) sinh thêm 1 fork SPTS ra
#     UDP loopback cho ffmpeg (PORT 1-1 với Node: channel.transcode.enabled +
#     loopbackPort — docs/16 §2). Trống/0 = không transcode.
#   - serviceId 1..65535 (0 đặt trước cho NIT).
#
# Dùng:
#   sh scripts/gen-conf.sh --source DEMO --input "file /tmp/vtc-demo/input.ts --repeat" \
#     --channel ch1:5:1 --channel ch2:6:1 --record-all 1
#   sh scripts/gen-conf.sh --source TS8 --input "ip 239.69.69.10:1234" \
#     --channel "DongNai1:2004:1" --channel "LaoCai:2005:1" --record-all 1
#   sh scripts/gen-conf.sh --source TS8 --input "ip 239.69.69.10:1234" \
#     --channel "DongNai1:2004:1:6001" --record-all 1   # kênh 2004 bật transcode
#   cat storage/conf/DEMO.conf
#
# SONG SONG VỚI HỆ CŨ: path live/capture lấy từ ENV (PORT 1-1 với Node
# ConfigGenerator: VTC_LIVE_DIR / VTC_CAPTURE_DIR). Trong container VTCAIO
# ENV đã là /media/ramdisk/vtcaio + /mnt/Data/vtcaio/captures; chạy tay
# ngoài container mà thiếu ENV thì fallback về path VTCAIO dưới đây.
# ==============================================================================
set -eu

# Đường live/capture (đồng bộ với Node qua ENV, fallback về path VTCAIO).
VTC_LIVE_DIR="${VTC_LIVE_DIR:-/media/ramdisk/vtcaio}"
VTC_CAPTURE_DIR="${VTC_CAPTURE_DIR:-/mnt/Data/vtcaio/captures}"

SOURCE=""; INPUT=""; RECORD_ALL=1
CHANNELS=""
INPUT_KIND="ip"
LIVE_CATCHUP_FROM="ingest"

log() { printf '[gen-conf] %s\n' "$*"; }
die() { printf '[gen-conf][ERROR] %s\n' "$*" >&2; exit 1; }
usage() {
    echo "Usage: $0 --source ID --input \"...\" [--input-kind ip|sdi|hdmi] [--live-catchup-from ingest|encoded] [--channel name:sid:is_live[:loopbackPort]]... [--record-all 0|1]"
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --source) SOURCE="${2:-}"; shift 2;;
        --input) INPUT="${2:-}"; shift 2;;
        --input-kind) INPUT_KIND="${2:-}"; shift 2;;
        --live-catchup-from) LIVE_CATCHUP_FROM="${2:-}"; shift 2;;
        --channel) CHANNELS="$CHANNELS ${2:-}"; shift 2;;
        --record-all) RECORD_ALL="${2:-}"; shift 2;;
        -h|--help) usage;;
        *) die "arg lạ: $1";;
    esac
done

[ -n "$SOURCE" ] || usage
[ -n "$INPUT" ] || usage

# PORT 1-1 với Node normalizeInputKind + guard (docs/16 §18).
# sdi/hdmi ĐƯỢC PHÉP ở shell vì conf tsp của nguồn agent-UDP giống hệt IP
# (chỉ khác ý nghĩa vận hành) — nhưng bắt buộc sau-encode + input UDP agent.
case "$INPUT_KIND" in
    ""|ip) INPUT_KIND="ip";;
    sdi|hdmi) ;;
    *) die "input-kind '$INPUT_KIND' không hợp lệ (ip|sdi|hdmi)";;
esac
# PORT 1-1 với Node: ip khóa ingest ở Phase 1 (docs/16 §0).
# sdi/hdmi bắt buộc encoded (baseband không ra trực tiếp) + input UDP agent 62xx.
case "$LIVE_CATCHUP_FROM" in
    ""|ingest) LIVE_CATCHUP_FROM="ingest";;
    encoded)
        case "$INPUT_KIND" in
            ip) die "live-catchup-from=encoded (sau transcode) khóa ở Phase 1 — GHI + Live IP đi đường gốc";;
        esac
        ;;
    *) die "live-catchup-from '$LIVE_CATCHUP_FROM' không hợp lệ (ingest|encoded)";;
esac
case "$INPUT_KIND" in
    sdi|hdmi)
        [ "$LIVE_CATCHUP_FROM" = "encoded" ] || die "nguồn $(printf '%s' "$INPUT_KIND" | tr 'a-z' 'A-Z') bắt buộc --live-catchup-from encoded"
        agent_port=$(printf '%s' "$INPUT" | sed 's/^ip 127.0.0.1://')
        case "$agent_port" in
            ''|*[!0-9]*) agent_port="x";;
        esac
        if [ "$agent_port" = "x" ] || [ "$agent_port" -lt 6200 ] || [ "$agent_port" -gt 6299 ]; then
            die "input nguồn $INPUT_KIND phải là UDP của capture agent (VD \"ip 127.0.0.1:6201\", cổng 6200..6299)"
        fi
        ;;
esac

OUT="storage/conf/${SOURCE}.conf"
mkdir -p "$(dirname "$OUT")"

live_count=0
for c in $CHANNELS; do
    # format name:sid:is_live — name không chứa dấu cách khi dùng shell demo
    is_live=$(printf '%s' "$c" | awk -F: '{print $3}')
    if [ "$is_live" = "1" ]; then live_count=$((live_count + 1)); fi
done

if [ "$live_count" -eq 0 ] && [ "$RECORD_ALL" != "1" ]; then
    die "Source $SOURCE vô nghĩa: 0 kênh live + record_all=0 (chỉ còn -O drop). Từ chối sinh conf."
fi

{
    # Mỗi argument 1 dòng (xem đầu file). Input tách theo khoảng trắng.
    printf -- '-I\n'
    # shellcheck disable=SC2086
    for w in $INPUT; do printf -- '%s\n' "$w"; done
    # Card multicast mặc định (PORT 1-1 với Node): VTC_MULTICAST_IFACE, explicit thắng.
    case "$INPUT" in
        ip\ *--local-address*) ;;
        ip\ *) [ -n "${VTC_MULTICAST_IFACE:-}" ] && printf -- '--local-address\n%s\n' "$VTC_MULTICAST_IFACE" ;;
    esac
    printf -- '-P\nvtcmonitor\n'
    # Fork HLS từng kênh (chuỗi lệnh là 1 dòng = 1 argv, không quote):
    for c in $CHANNELS; do
        name=$(printf '%s' "$c" | awk -F: '{print $1}')
        sid=$(printf '%s' "$c" | awk -F: '{print $2}')
        is_live=$(printf '%s' "$c" | awk -F: '{print $3}')
        if [ "$is_live" = "1" ]; then
            printf -- '-P\nfork\ntsp -P zap %s -O hls --duration 5 --live 5 --playlist %s/%s/index.m3u8 %s/%s/segment.ts\n' \
                "$sid" "$VTC_LIVE_DIR" "$name" "$VTC_LIVE_DIR" "$name"
        fi
    done
    # Fork loopback transcode (PORT 1-1 với Node, sau fork HLS — docs/16 §2):
    for c in $CHANNELS; do
        name=$(printf '%s' "$c" | awk -F: '{print $1}')
        sid=$(printf '%s' "$c" | awk -F: '{print $2}')
        is_live=$(printf '%s' "$c" | awk -F: '{print $3}')
        loopback=$(printf '%s' "$c" | awk -F: '{print $4}')
        if [ "$is_live" = "1" ] && [ -n "$loopback" ] && [ "$loopback" != "0" ]; then
            case "$loopback" in
                ''|*[!0-9]*) die "kênh $name: loopbackPort '$loopback' phải là số 6000..6099 (trống/0 = không transcode)";;
            esac
            if [ "$loopback" -lt 6000 ] || [ "$loopback" -gt 6099 ]; then
                die "kênh $name: loopbackPort $loopback ngoài 6000..6099 (UDP nội bộ tsp→ffmpeg)"
            fi
            printf -- '-P\nfork\ntsp -P zap %s -O ip 127.0.0.1:%s\n' "$sid" "$loopback"
        fi
    done
    if [ "$RECORD_ALL" = "1" ]; then
        # VoD (không --live): giữ toàn bộ segment. --live N tự xóa cũ, --live 0 bị cấm từ 3.44.
        printf -- '-O\nhls\n--duration\n60\n%s/%s/catchup.ts\n' "$VTC_CAPTURE_DIR" "$SOURCE"
    else
        printf -- '-O\ndrop\n'
    fi
} > "$OUT"

log "wrote $OUT (live_channels=$live_count record_all=$RECORD_ALL)"
cat "$OUT"
