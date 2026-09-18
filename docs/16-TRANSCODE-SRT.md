# 16 — TRANSCODE + SRT + RTMP + UDP MULTICAST OUT (Tài liệu chuẩn)

> Trạng thái: **ĐÃ CHỐT KIẾN TRÚC** — tài liệu duy nhất làm chuẩn khi code.
> Tổng hợp từ toàn bộ brainstorm + 4 hiệu chỉnh vận hành + review đối chiếu code (6 lỗi đã sửa, 5 điểm đã bổ sung).
> Ngày chốt: 2026-09-18.

---

## 0. Tiền đề đã chốt

1. VTCAIO đã có hệ GHI riêng → đường GHI chỉ làm buffer cho Timeshift/Trích xuất.
2. GHI + Live HLS **mặc định TRƯỚC transcode**. Phase 1 **khóa cứng**, chưa cho chọn "sau transcode" (tránh phụ thuộc vòng tròn, vỡ Timeshift/GC). UI ẩn hoàn toàn toggle này; API từ chối nếu client cố gửi.
3. **Timeshift + Trích xuất luôn theo đường GHI** (đọc file `.ts` trên đĩa), không theo Live, không theo transcode.
4. Cấu hình theo cách nghĩ **Elemental** (Live Event → Preset → Output) nhưng chỉ lấy subset (xem §7).
5. Test trước bằng **ffmpeg CPU**: 4 renditions video + 1 audio-only, tất cả **25fps, H.264 High + AAC-LC 48kHz stereo, CBR, GOP 2s**.

---

## 1. Kiến trúc pipeline tổng thể

```text
Nguồn vào (multicast MPTS / SRT push-in / RTMP push-in)
 │
 ▼
TSDuck ingest — 1 Source = 1 process 24/7, nhẹ CPU (giữ nguyên ProcessManager)
 ├── GHI (trước transcode) ──> chunk 60s ──> Timeshift + Trích xuất
 ├── Live HLS gốc ──> RAMDisk ──> web nội bộ / preview
 └── fork SPTS ──> UDP loopback 127.0.0.1:60xx (điểm cách ly, §2)
        │
        ▼
     FFmpeg — 1 process / 1 kênh (decode 1 lần, encode N lần)
      ├── 4 renditions video + 1 audio-only
      ├── SRT listener (ta mở cổng, ngoài kéo) + SRT caller (ta đẩy sang VTVgo)
      ├── RTMP push (đẩy sang họ) / RTMP server nhận push (MediaMTX sidecar)
      └── UDP multicast out (kiểm tra nội bộ LAN, §6)
```

### Nguyên tắc bất di bất dịch

- **P1 — Cách ly sinh tồn:** tsp không bao giờ chết theo ffmpeg và ngược lại khi crash. Chỉ lệnh Stop/đổi cấu trúc chủ động mới diệt cả cụm.
- **P2 — ffmpeg không đọc multicast trực tiếp:** luôn qua UDP loopback để giữ giám sát CC-error của `vtcmonitor` ở tầng ingest.
- **P3 — 1 ffmpeg / 1 kênh:** decode 1 lần, encode N lần. Tuyệt đối không spawn nhiều ffmpeg cho cùng 1 kênh.

---

## 2. Nhánh cách ly: TSDuck fork → UDP loopback

### 2.1. Dòng fork cần thêm vào ConfigGenerator

Hiện tại `ConfigGenerator.ts` chỉ sinh fork HLS live. Khi `channel.transcode.enabled = true`, sinh thêm:

```text
-P
fork
tsp -P zap <SID> -O ip 127.0.0.1:<loopback_port>
```

- `<loopback_port>` lấy từ dải loopback (§10), 1 kênh = 1 port, cấp phát theo kênh, validate không trùng.
- Chỉ sinh khi transcode của kênh đó được bật (xem quyết định thay thế ở §2.3).

### 2.2. Chống sốc bộ đệm (UDP không có flow-control)

- ffmpeg khởi chậm hơn tsp vài ms là rớt header đầu → `corrupt header`, không decode được.
- Input ffmpeg dùng dạng URL query (chuẩn của UDP protocol, đã chốt sau review):

```text
-i "udp://127.0.0.1:60xx?overrun_nonfatal=1&fifo_size=1000000&buffer_size=4000000"
```

- Khởi động theo readiness (thấy flow PAT ổn định) với fallback delay ~1s sau khi tsp lên. `TranscodeManager` có tham số `startDelayMs` để tune.

### 2.3. QUYẾT ĐỊNH: pre-generate fork loopback hay sinh theo cờ

Bật/tắt transcode làm đổi file conf của tsp (thêm/bớt dòng fork) → thay đổi **cấu trúc**, bắt buộc restart tsp. Có 2 phương án, **chốt 1 khi viết spec T2**:

- **Phương án A (khuyến nghị):** luôn sinh sẵn fork loopback cho mọi kênh live, kể cả khi chưa bật transcode. Gửi UDP vào port chết khi không dùng — tốn không đáng kể. Lợi: mọi thay đổi transcode về sau đều là hot-update (chỉ restart ffmpeg), không bao giờ phải restart tsp vì lý do transcode.
- **Phương án B:** chỉ sinh fork khi `transcode.enabled = true`. Bật/tắt = restart tsp (gián đoạn GHI+Live ngắn). Tiết kiệm 1 fork process/kênh.

---

## 3. Transcode (ffmpeg)

### 3.1. Preset (seed sẵn 5 dòng, lưu DB, dùng lại)

| Preset | Video | Audio |
|---|---|---|
| 1080p | 1920×1080, 25fps, H.264 ~4 Mbps, GOP 50 | AAC-LC 48kHz stereo 192k |
| 720p | 1280×720, 25fps, H.264 ~2 Mbps, GOP 50 | AAC-LC 48kHz stereo 128k |
| 480p | 854×480, 25fps, H.264 ~1.2 Mbps, GOP 50 | AAC-LC 48kHz stereo 128k |
| 360p | 640×360, 25fps, H.264 ~800 Kbps, GOP 50 | AAC-LC 48kHz stereo 128k |
| Audio-Only | `-vn` (bỏ hình) | AAC-LC 48kHz stereo 128k |

- Audio-Only phục vụ nghe nền mobile + kênh radio, rất nhẹ CPU, đi chung process ffmpeg của kênh (không process riêng), SRT listener dùng port riêng như rendition video.
- Sửa preset không ảnh hưởng kênh đang chạy (snapshot argv lúc start).

### 3.2. Tham số chung + Engine CPU/GPU

- Filter: `yadif` (deinterlace) → `fps=25` ép cứng → `scale`. Filter giữ CPU cho mọi engine ở Phase 1 (đúng, chỉ chưa tối ưu upload GPU — để phase GPU sau).
- Encode: **CBR** (`-maxrate = -b:v`, `-bufsize = 2×bitrate`), `-g 50` (GOP 2s @25fps), H.264 High — giữ nguyên mọi engine.
- **Engine chọn được ở tầng kênh** (`ChannelTranscode.engine`, vì GPU là thuộc tính của máy, không phải của preset):
  - `cpu` (MẶC ĐỊNH): `libx264 -preset veryfast`. Chạy mọi máy, tốn 3–5 core/kênh 4 renditions.
  - `nvenc` (NVIDIA): `h264_nvenc`, preset x264 dịch sang p1–p7 (veryfast → p4).
    - Image: `Dockerfile.backend-gpu` (CUDA runtime + ffmpeg static có nvenc) — deploy bằng `docker-compose.transcode-gpu.yml`, **thay** backend CPU (không chạy 2 backend cùng lúc, cùng bind 18081 host-network).
    - Host cần: driver NVIDIA + NVIDIA Container Toolkit (`VTC_GPU=1 sh scripts/prod-check.sh` để kiểm tra).
    - **GPU floor (bắt buộc): GPU Turing trở lên** (GTX 1650 Super / RTX series / T4 / L4 / A2…), driver ≥550, CUDA 12. Lý do: preset p1–p7 chỉ có từ NVENC SDK 11 / GPU Turing+; card cũ hơn dùng tên preset cũ (slow/medium/fast/hp/hq…) — không nằm trong hỗ trợ Phase 1.
    - **GTX 770 (Kepler, 2013) — KHÔNG DÙNG ĐƯỢC (quyết định 18/09/2026, ở lại CPU):**
      1. Driver kẹt ở nhánh legacy 470.xx — CUDA 12 không nhận kiến trúc Kepler.
      2. ffmpeg mới (image GPU) không init được NVENC trên driver 470 (lệch NVENC API) → `h264_nvenc` mở lên là fail, đúng vào lớp fail-fast đã code.
      3. Không hiểu preset p1–p7 (đời Kepler chỉ hiểu tên preset cũ) → argv nvenc của ta chạy là lỗi.
      4. GeForce đời này giới hạn ~2–3 session NVENC — không đủ 4 renditions + audio của 1 kênh.
      5. NVENC Gen1 chất lượng kém hơn x264 veryfast cùng bitrate — đẩy lên VTVgo thiệt chất lượng, tốn ~230W vô ích.
      → Kết luận: rút GTX 770 khỏi quy hoạch transcode. Muốn GPU thì mua card Turing+ (cũ rẻ: GTX 1650 Super / RTX 2060; datacenter: T4).
    - Fail-fast 2 lớp: build image verify `h264_nvenc` có mặt; runtime `assertEngineAvailable()` (check `ffmpeg -encoders`) trước khi start kênh GPU — thiếu thì báo rõ, không spawn mù.
    - **Giới hạn session NVENC:** card GeForce tiêu dùng giới hạn ~3–5 phiên encode đồng thời (cần patch driver mới mở) — đếm số kênh/rendition nvenc. Card datacenter (T4/L4/A2) không giới hạn. Vượt giới hạn ffmpeg báo `No NVENC capable devices` / `out of memory` → chuyển bớt kênh sang cpu hoặc thêm card.
  - `qsv`/`vaapi` (Intel): giữ chỗ trong type, generator báo "chưa hỗ trợ" — dùng `cpu` hoặc `nvenc`.
- Sửa `TranscodeConfigGenerator.ts` sinh argv trực tiếp, **không dùng fluent-ffmpeg** (đúng pattern `spawn()` hiện tại của ProcessManager).

### 3.3. Sizing + ràng buộc MPTS (QUY TẮC SẮT)

- 4 renditions ≈ **3–5 core CPU / kênh** (veryfast).
- **Số đo thực 18/09/2026** (container 6 CPU, libx264 veryfast CBR, full 4 renditions + audio-only):
  - Nguồn lab 1080i (testsrc): **~3.3 core/kênh**, fps tổng ~49.
  - File .ts THẬT (DN1, SID 807: H.264 1080i25 + MP2 stereo): **~5.0 core/kênh**, fps ~31. yadif deinterlace đúng (đầu ra progressive 25fps cả 3 rendition), MP2 decode → AAC không lỗi. File kéo về đủ 1080/720/480 + AAC, audio-only không lẫn hình.
  - Kết luận sizing: nội dung thật interlaced nằm ở TRẦN quy tắc 3–5 core. Quy hoạch máy Prod lấy **5 core/kênh**, không lấy số lab.
- 1 Source MPTS nhiều kênh: mỗi kênh bật transcode = 1 fork + 1 ffmpeg + N outputs. VD 5 kênh × 5 outputs = 25 luồng encode ≈ 15–25 core.
- 1 Source MPTS nhiều kênh: mỗi kênh bật transcode = 1 fork + 1 ffmpeg + N outputs. VD 5 kênh × 5 outputs = 25 luồng encode ≈ 15–25 core.
- **Phase 1: bật transcode từng kênh một** (`channel.transcode.enabled`), không bật cả source. Dashboard hiện warning CPU trước khi bật kênh thứ N; fps encode < 25 = máy yếu → giảm profile hoặc tách node transcode riêng. Tuyệt đối không transcode chung máy ingest khi CPU burst (rung luồng gốc → CC-error giả).

---

## 4. SRT — 2 chiều (kênh truyền dẫn chính)

| Chiều | VTCAIO | Đối tác | Cần gì |
|---|---|---|---|
| Ngoài kéo ta | **listener** `srt://0.0.0.0:90xx?mode=listener` | caller trỏ vào IP/port ta | Ta cấp IP + port + streamid + passphrase; mở inbound UDP |
| Ta đẩy sang họ | **caller** `srt://<ip-ho>:port?mode=caller&streamid=...` | listener | Xin họ IP/port/streamid/passphrase; ta chỉ cần outbound |

- **1 port = 1 rendition = 1 kết nối tại 1 thời điểm** (quy ước an toàn Phase 1; SRT listener về lý thuyết chịu được nhiều caller nhưng chưa dùng).
- Port cấp theo kênh, không cho tự gõ tự do. `streamid = tên kênh`.
- Passphrase ≥16 ký tự **bắt buộc ở Prod** (test nội bộ được tắt). `rendezvous` chỉ khi cả 2 bên cùng NAT khó.
- Backend chạy `network_mode: host` → SRT listener mở port trực tiếp trên host, không cần port mapping (§11 firewall).
- **QUY TẮC VẬN HÀNH (đo thực tế ffmpeg 8.1, 18/09/2026): output SRT listener CHẶN ở bước mở cho tới khi caller đầu tiên kết nối.** Hệ quả:
  1. Kênh có N srt-listen output cần ĐỦ N caller thì ffmpeg mới bắt đầu encode — thiếu 1 caller là cả cụm đứng (kể cả output multicast/RTMP khác, vì ffmpeg mở outputs tuần tự).
  2. Chỉ tạo srt-listen cho rendition THỰC SỰ có bên kéo (VTVgo/monitor). Rendition chỉ kiểm tra nội bộ → dùng UDP multicast (không chặn).
  3. Lỗi I/O ở 1 output giết cả process ffmpeg (ngữ nghĩa ffmpeg) → crash → restart theo §9.2, có Telegram.
  4. Dashboard phân biệt 3 trạng thái: `waiting` (sống quá 30s chưa có frame — thường là chờ caller), `stale` (đã chạy rồi đứng fps), còn lại là chạy.
  5. Nút srt-test chỉ chứng minh BẮT TAY (handshake) — bằng chứng luồng có dữ liệu là `fps > 0` trên dashboard. Tác dụng phụ hay: bấm Test cũng "mồi" cho ffmpeg đang chờ caller bắt đầu chạy.

---

## 5. RTMP — 2 chiều (phụ, SRT là chính)

- **Nhận push:** dựng **MediaMTX** (1 binary Go, nhẹ) làm RTMP server sidecar, mỗi kênh 1 stream-key + whitelist IP + auth. Cần định nghĩa service `mediamtx` trong compose + đường giao tiếp với backend (ghi rõ khi làm T3).
- **Đẩy đi:** ffmpeg `-f flv rtmp://<ip-ho>/live/<key>` + retry/backoff.
- RTMP chịu mất gói kém SRT → chỉ dùng khi đối tác bắt buộc.

---

## 6. UDP multicast out (kiểm tra nội bộ LAN)

- Lấy **sau transcode** (đúng cái đang phát đi xa). Default rendition **720p** cho nhẹ.
- Thêm 1 output vào cùng process ffmpeg:

```text
-f mpegts "udp://236.30.233.1:6000?pkt_size=1316&localaddr=192.168.20.200&ttl=1"
```

- **Dải IP output riêng** (`236.x`) — không bao giờ trùng dải ingest (`239.x`) → chống vòng lặp tự thu lại chính mình. Validate cấm trùng group:port với ingest.
- Card phát ra nhập **IP của card** (`localaddr`; xem bằng `ip addr` trên máy phát), **cấm bỏ trống khi máy nhiều NIC**. TTL default 1 (giữ trong LAN).
- Kiểm tra bằng `ffplay udp://...` hoặc `tsp -I ip ... -P bitrate_monitor`. Switch cần IGMP snooping.
- Mặc định **TẮT**, bật khi test, dashboard hiện badge "đang phát multicast" để khỏi quên tắt.

---

## 7. Ánh xạ Elemental (subset — chỉ lấy từng này)

| Elemental | VTCAIO | Ghi chú |
|---|---|---|
| Live Event | Kênh (input đã có từ Source/SID) | Không nhập lại input |
| Preset | 4 video + 1 audio-only (lưu DB, dùng lại) | Sửa preset không ảnh hưởng kênh đang chạy |
| Stream Assembly | Encode settings 1 rendition | video {codec,res,bitrate,fps,gop} + audio {codec,bitrate} |
| Output Group | SRT group + RTMP group + UDP-mcast group | Phase 1 chỉ cần SRT group chạy thật |

Không làm: Schedule, MPTS mux/statmux, DRM, caption, pre/post script, failover input.

---

## 8. Data model / API / UI tối thiểu

### 8.1. Schema

```text
Preset {
  id, name,
  video { codec, width, height, bitrate, fps, gop, preset },
  audio { codec, bitrate, sampleRate, channels }
}
Channel.transcode { enabled, presetIds[] }
Channel.outputs[] {
  type: srt-listen | srt-caller | rtmp-push | rtmp-in | udp-mcast,
  port | group, streamId | streamKey, passphraseRef,
  localAddr, ttl, enabled
}
```

### 8.2. Phân tầng thay đổi (QUYẾT ĐỊNH sau review)

- **Tầng cấu trúc** (bật/tắt transcode theo kênh → đổi conf tsp): đi đường `updateSource()` hiện tại — phải stop source trước. (Trừ khi chọn Phương án A ở §2.3 thì tầng này biến mất.)
- **Tầng endpoint** (thêm/bớt/sửa SRT-RTMP-UDP out, passphrase, presetIds): đi đường **hot-update kiểu `updateMeta()`** — không stop source, chỉ restart riêng ffmpeg.
- Passphrase lưu reference, không lưu plaintext vào DB thường.

### 8.3. API

- `GET/POST /api/presets`, `PUT/DELETE /api/presets/:id`
- `PUT /api/channels/:id/transcode` (validate: trùng port, dải multicast, passphrase; phân tầng cấu trúc/endpoint như §8.2)
- `POST /api/channels/:id/srt-test` (chạy ~10s, báo RTT/loss)
- `GET /api/transcode/status` (fps/bitrate/rtt/kết nối từng output)
- Phase 1 API từ chối `ghi = sau-transcode` (trả lỗi rõ, không im lặng).

### 8.4. UI

- Trang `/transcode` (CRUD preset).
- Tab "Truyền dẫn" trong trang chi tiết kênh: toggle, dropdown preset multi-select, bảng outputs, nút Test, badge trạng thái.
- **Ẩn hoàn toàn** toggle "ghi trước/sau transcode" ở Phase 1.
- Badge "đang phát multicast" khi udp-mcast bật; warning CPU trước khi bật thêm kênh.

---

## 9. Quản lý process (TranscodeManager)

### 9.1. Tách vòng đời (áp dụng Hiệu chỉnh 1)

- `TranscodeManager` quản lý ffmpeg là **process group riêng**, độc lập PGID với tsp.
- Crash → restart độc lập (B chết → restart mình B; A chết → kill B → restart A ổn định → gọi lại B có delay).
- **Stop/đổi cấu trúc chủ động → kill cả cụm** (`kill(-pgid)` từng group) cho sạch.
- Kế thừa pattern hiện tại: `detached: true`, `SIGTERM → chờ killTimeoutMs → SIGKILL`, `init: true` (tini) chống zombie.

### 9.2. Quy tắc restart riêng cho ffmpeg (khác tsp)

Auto-restart của tsp nằm ở `server.ts` (noRestart Set + pendingRestarts Map + delay 5s). FFmpeg cần luật riêng:

- Crash → restart delay **2s** (không phải 5s như tsp).
- Crash liên tục **>3 lần/5 phút** → dừng hẳn + Telegram, không restart vô hạn.
- tsp crash → theo flow hiện tại, kèm kill ffmpeg trước rồi mới restart tsp.

### 9.3. Giám sát ffmpeg (áp dụng sau sửa Lỗi 5)

- `ProcessManager` hiện tại: `stdio: ['ignore','ignore','pipe']` (vứt stdout).
- `TranscodeManager` **phải** dùng `stdio: ['ignore','pipe','pipe']`: stdout cho `-progress pipe:1` (fps/bitrate), stderr cho error log. (Phương án dự phòng: `-progress udp://127.0.0.1:XXX` — phức tạp hơn, để sau.)
- `fps = 0` quá 15s → stale → restart + Telegram. Alert **"ffmpeg transcode down" ưu tiên cao nhất**.
- Dashboard: CPU node, fps/bitrate/rendition, SRT RTT/loss/retransmit, số caller đang kéo, badge multicast.

---

## 10. Quy hoạch port/IP (chuẩn duy nhất)

| Mục đích | Dải | Ghi chú |
|---|---|---|
| UDP loopback nội bộ | `127.0.0.1:6000–6099` | tsp → ffmpeg, 1 kênh 1 port |
| UDP multicast output | `236.30.x.x:7000–7099` | sau transcode, kiểm tra LAN (không dùng port 600x để dễ đọc log) |
| SRT listener | `9000–9199` | 1 port = 1 rendition = 1 kết nối (Phase 1) |
| RTMP | `1935` | MediaMTX sidecar |
| API backend | `18081` | giữ nguyên, không đụng hệ cũ 18080 |

- Dải multicast ingest (`239.x`) và output (`236.x`) không bao giờ giao nhau; validate cứng bằng zod + check chéo trong `prod-check`.

---

## 11. Công nghệ (giữ stack, thêm đúng thứ thiếu)

- **BE (Node 20 + TS, raw `node:http`, giữ nguyên):** mở rộng `ProcessManager` → `TranscodeManager` mới (spawn argv trực tiếp, không fluent-ffmpeg); thêm duy nhất **`zod`** (share schema BE↔FE, validate port/multicast/passphrase); ffmpeg static (`libx264`+`libsrt`); `srt-tools` (test/healthcheck); `ffprobe` cho nút Preview; JSON store thêm `presets.db.json` theo đúng pattern atomic write (tmp+rename) hiện tại.
- **FE (Next 14 + Tailwind, giữ nguyên):** form thuần useState (khớp style repo — không thêm react-hook-form); thêm **`zod`** share rule validate với backend (`src/lib/transcode.ts`: preset/output/channel schema + `tcApi` client); trang `/transcode` CRUD preset; component `TranscodePanel` (tab Truyền dẫn trong trang kênh: toggle, engine, loopback, preset multi-select, bảng outputs, nút Test, status poll 5s); dùng `recharts`/`hls.js`/SSE sẵn có cho status.
- **Infra — QUYẾT ĐỊNH sau review:** Phase 1 **gộp ffmpeg + srt-tools vào cùng image backend** (1 container = tsp + ffmpeg + node, spawn trực tiếp). **Không** tạo container transcode riêng (container riêng thì `spawn()` không với tới). Tách node transcode riêng để Phase sau khi cần scale.
  - Máy CPU: `Dockerfile.backend` (ffmpeg stock Ubuntu: libx264 + srt) + `docker-compose.catchup.yml`.
  - Máy GPU NVIDIA: `Dockerfile.backend-gpu` (CUDA runtime + ffmpeg static có h264_nvenc) + `docker-compose.transcode-gpu.yml` (thay backend CPU).
- Không thêm: GPU/NVENC, fluent-ffmpeg, Prometheus, Wowza/SRS cluster, jest/vitest (giữ `node:test`).

### Bổ sung hạ tầng SRT (từ review)

- `prod-check.sh`: kiểm tra port SRT 9000–9199 chưa bị chiếm; kiểm tra `ufw allow 9000:9199/udp`.
- `.env.prod.example`: thêm `VTC_SRT_PORT_MIN`, `VTC_SRT_PORT_MAX`, `VTC_SRT_PASSPHRASE`.

---

## 12. Migration `sources.db.json`

- `SourceConfig` hiện chưa có field transcode. Khi thêm `channel.transcode` + `channel.outputs[]`:
- Boot đọc DB cũ (thiếu field) **không được crash**: `loadPersisted()`/`restore()` merge default `transcode.enabled = false`, `outputs = []`.
- Viết unit test cho đường migration này.

---

## 13. Test plan cho code mới (giữ convention repo)

- Unit: `TranscodeConfigGenerator` sinh đúng argv (mock thuần, không cần ffmpeg thật).
- Unit: `TranscodeManager` spawn/kill/restart (fake script `exec sleep 60`, giống `ProcessManager.test.ts`).
- Integration: API preset CRUD + transcode start/stop (server thật port random, fake binary).
- Tất cả dùng `node:test` + `node:assert/strict`. Không thêm framework test.
- Không được làm vỡ 85 BE tests + 8 FE tests hiện có.

---

## 14. Rủi ro lớn nhất

| Rủi ro | Cách né |
|---|---|
| Bật hàng loạt → nổ CPU, giật cả ingest | Bật từng kênh, warning CPU >85% phải xác nhận tay |
| Listener trần (không passphrase/whitelist) | Bắt passphrase + streamid + whitelist ở Prod |
| Trùng group ingest/output → vòng lặp | Dải riêng + validate cứng |
| 1 port nhiều bên kéo | 1 port = 1 kết nối (Phase 1); nhiều bên thì nhiều port |
| Trôi A/V sau chạy dài | wallclock timestamps, monitor drift, restart bảo trì định kỳ |
| RTMP/SRT rớt mạng kéo chết ghi | Tách PGID (§9.1) — đây là lý do tồn tại của TranscodeManager riêng |

---

## 15. Roadmap

- **T0:** xin VTVgo: chiều nào, mấy kênh, port/streamid/passphrase hoặc RTMP URL+key, IP whitelist 2 chiều.
- **T1 (test tay, chưa UI):** 1 kênh → ffmpeg 4 renditions + audio-only → 4 SRT listen + 1 UDP-mcast → VLC/ffplay kéo thử 24h, ghi CPU/fps/RTT. Verify cú pháp URL query UDP (§2.2) trên ffmpeg trong image.
  - KẾT QUẢ E2E 18/09/2026 (ffmpeg 8.1, file 720p25 GOP 2s, container 6 CPU): chuỗi đầy đủ file → yadif/fps/scale → libx264 CBR → SRT listen → caller kéo → giải mã được H.264 1280×720 25fps + AAC; `fps=137` ở 720p veryfast; progress `-progress pipe:1` parse được qua TranscodeManager. Phát hiện và sửa 1 bug thật: nhánh filter của preset không có output trỏ tới làm ffmpeg lỗi `Error binding filtergraph` (generator giờ chỉ sinh nhánh cho preset được dùng).
  - LƯU Ý MÔI TRƯỜNG: UDP (nhất là multicast) trong Docker dev không đáng tin để test (mất gói/SPS-PPS) — E2E dùng file input (`inputUrl` override); UDP loopback verify lại trên máy Prod (rmem 25MB).
- **T2:** preset DB + API + UI + nút Test + Telegram. Chốt Phương án A/B ở §2.3.
- **T3:** caller/push sang VTVgo thật + RTMP 2 chiều + firewall/port planning.
  - ĐÃ XONG (infra, không cần VTVgo): MediaMTX sidecar (`mediamtx/mediamtx.yml` + `docker-compose.mediamtx.yml`, RTMP :1935, publish user/pass, image ghim `v1.9.3`) — up độc lập cùng backend CPU/GPU để đối tác test push. Bảng cổng docs/13 §0 + check tay prod-check §7 đã có.
  - CÒN LẠI (cần thông tin VTVgo T0): puller ffmpeg đọc RTMP từ mediamtx vào pipeline (generator hiện báo `rtmp-in triển khai ở T3`), caller/push thật, whitelist IP 2 chiều.
- **T4:** cứng hóa (rotation passphrase, stats dashboard, tách node transcode, doc liên thông).

### Còn chờ bạn chốt để ra spec code T1

1. Kênh test đầu tiên (tên + SID + nguồn multicast).
2. Test nội bộ hay đấu VTVgo thật ngay.
3. Passphrase ngay từ T1 hay để T3.
