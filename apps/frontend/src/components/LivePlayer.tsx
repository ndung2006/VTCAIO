'use client';
//=============================================================================
// LivePlayer — Trình phát HLS Live (PRD §4.3/4.7).
//  - hls.js khi browser không native (mọi Chrome/Firefox), gán src trực tiếp
//    khi Safari phát được application/vnd.apple.mpegurl.
//  - CỰC KỲ QUAN TRỌNG: cleanup hls.destroy() + xóa src video tag mỗi khi
//    streamUrl đổi hoặc unmount — nếu không, chuyển ~10 kênh là tab Chrome
//    cắn hàng GB RAM và văng "Aw, Snap!".
//  - Controls tự làm (Play/Pause, Mute, Fullscreen), KHÔNG seekbar vì là Live.
//=============================================================================
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export function LivePlayer({
  streamUrl,
  onFatal,
  mode = 'live',
  className = '',
}: {
  streamUrl: string;
  /** Gọi khi lỗi fatal (VD token hết hạn) để trang cha cấp link mới. */
  onFatal?: () => void;
  /** live: ẩn seekbar. vod (timeshift/xem lại): seekbar + giờ. */
  mode?: 'live' | 'vod';
  /** Class ngoài cùng (VD giới hạn rộng khung video). */
  className?: string;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true); // autoplay chỉ được khi mute
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0); // 0..1000 (chỉ vod)
  const [times, setTimes] = useState({ cur: 0, dur: 0 });

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    setError('');
    setProgress(0);
    setTimes({ cur: 0, dur: 0 });
    let hls: Hls | null = null;
    let cleanupNative: (() => void) | null = null;

    if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
      // Safari native (không có sự kiện fatal chi tiết như hls.js — lỗi src là hết hạn token).
      const onNativeError = (): void => {
        setError('Không tải được luồng (có thể link đã hết hạn) — thử tải lại trang.');
        onFatal?.();
      };
      video.addEventListener('error', onNativeError);
      cleanupNative = () => video.removeEventListener('error', onNativeError);
      video.src = streamUrl;
      void video.play().catch(() => setPlaying(false));
    } else if (Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 15 }); // buffer ngắn cho live trễ thấp
      const fatalCb = onFatal;
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (!data.fatal) return;
        // Token hết hạn (403 segment) cũng là fatal — để trang cha cấp link mới.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) fatalCb?.();
        setError(`HLS lỗi: ${data.type}/${data.details}`);
      });
      // Chỉ play khi đã có manifest — play sớm hơn dễ báo lỗi giả + sai nút.
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
    } else {
      setError('Trình duyệt không hỗ trợ HLS');
    }

    // Cleanup khi đổi kênh/unmount: hủy instance + xả buffer RAM browser.
    return () => {
      cleanupNative?.();
      hls?.destroy();
      hls = null;
      video.removeAttribute('src');
      video.load(); // ép browser nhả buffer chunk .ts cũ
    };
  }, [streamUrl, onFatal]);

  // VOD: theo dõi tiến trình để vẽ seekbar (live không cần).
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || mode !== 'vod') return;
    const tick = (): void => {
      const dur = video.duration;
      const cur = video.currentTime;
      setTimes({ cur, dur: Number.isFinite(dur) ? dur : 0 });
      setProgress(Number.isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 1000) : 0);
    };
    video.addEventListener('timeupdate', tick);
    video.addEventListener('loadedmetadata', tick);
    return () => {
      video.removeEventListener('timeupdate', tick);
      video.removeEventListener('loadedmetadata', tick);
    };
  }, [mode, streamUrl]);

  const seek = (v: number): void => {
    const video = videoRef.current;
    if (video === null) return;
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0) video.currentTime = (v / 1000) * dur;
  };

  const togglePlay = (): void => {
    const v = videoRef.current;
    if (v === null) return;
    if (v.paused) {
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const toggleMute = (): void => {
    const v = videoRef.current;
    if (v === null) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const goFullscreen = (): void => {
    const wrap = videoRef.current?.parentElement;
    if (wrap === null || wrap === undefined) return;
    if (document.fullscreenElement !== null) void document.exitFullscreen();
    else void wrap.requestFullscreen();
  };

  return (
    <div className={className}>
      <div className="vtc-video-wrap">
        <video ref={videoRef} muted={muted} playsInline />
      </div>
      {mode === 'vod' ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">{fmtClock(times.cur)}</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={progress}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Tua"
            className="flex-1"
          />
          <span className="font-mono text-xs text-slate-500">{fmtClock(times.dur)}</span>
        </div>
      ) : (
        <p className="mt-2 text-xs font-semibold text-red-600">LIVE</p>
      )}
      {error !== '' && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button onClick={togglePlay} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={toggleMute} className="rounded bg-slate-200 px-4 py-2 text-sm">
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button onClick={goFullscreen} className="rounded bg-slate-200 px-4 py-2 text-sm">
          Fullscreen
        </button>
      </div>
    </div>
  );
}
