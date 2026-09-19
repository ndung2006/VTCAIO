// TranscodeConfigGenerator.test.ts — argv ffmpeg thuần túy, không cần ffmpeg thật.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEngineAvailable,
  buildCaptureArgs,
  buildFfmpegArgs,
  buildPullerArgs,
  checkOutputPresetRefs,
  defaultPresets,
  isMulticastIPv4,
  isValidOutputGroup,
  loopbackForkLine,
  normalizeChannelTranscode,
  normalizeSourceCapture,
  normalizeSourcePuller,
  parseCapture,
  parseOutput,
  parsePreset,
  parsePuller,
  parseTcStartDelayMs,
  requiredEncoder,
  transcodeInputUrl,
  TranscodeError,
} from './TranscodeConfigGenerator.js';
import type { TranscodePreset } from './types.js';

function presetsById(ids: string[]): TranscodePreset[] {
  const all = defaultPresets();
  return ids.map((id) => {
    const p = all.find((x) => x.id === id);
    if (p === undefined) throw new Error(`thiếu preset seed ${id}`);
    return p;
  });
}

describe('defaultPresets', () => {
  it('đủ 5 preset: 4 video + 1 audio-only, 25fps CBR GOP 50', () => {
    const ps = defaultPresets();
    assert.equal(ps.length, 5);
    const vids = ps.filter((p) => p.video !== null);
    assert.equal(vids.length, 4);
    for (const p of vids) {
      assert.equal(p.video?.codec, 'h264');
      assert.equal(p.video?.fps, 25);
      assert.equal(p.video?.gop, 50);
    }
    const p1080 = ps.find((p) => p.id === 'p1080');
    assert.equal(p1080?.video?.width, 1920);
    assert.equal(p1080?.video?.bitrateKbps, 4000);
    assert.equal(p1080?.audio.bitrateKbps, 192);
    const pa = ps.find((p) => p.id === 'paudio');
    assert.equal(pa?.video, null);
  });
});

describe('input + fork', () => {
  it('input URL đúng dạng query chuẩn UDP protocol', () => {
    const u = transcodeInputUrl(6001);
    assert.equal(u, 'udp://127.0.0.1:6001?overrun_nonfatal=1&fifo_size=1000000&buffer_size=4000000');
  });
  it('loopbackPort ngoài 6000..6099 thì ném', () => {
    assert.throws(() => transcodeInputUrl(7000), TranscodeError);
    assert.throws(() => loopbackForkLine(2004, 9001), TranscodeError);
  });
  it('dòng fork đúng 1 dòng argv cho ConfigGenerator', () => {
    assert.equal(loopbackForkLine(2004, 6001), 'tsp -P zap 2004 -O ip 127.0.0.1:6001');
  });
});

describe('validate IP', () => {
  it('nhận diện multicast 224–239', () => {
    assert.equal(isMulticastIPv4('236.30.233.1'), true);
    assert.equal(isMulticastIPv4('239.1.1.1'), true);
    assert.equal(isMulticastIPv4('192.168.1.1'), false);
    assert.equal(isMulticastIPv4('abc'), false);
  });
  it('output group cấm dải ingest 239.x', () => {
    assert.equal(isValidOutputGroup('236.30.233.1'), true);
    assert.equal(isValidOutputGroup('239.1.1.1'), false);
    assert.equal(isValidOutputGroup('192.168.1.1'), false);
  });
});

describe('buildFfmpegArgs', () => {
  it('1 kênh 720p → srt-listen: đủ -progress, filter scale, libx264 CBR, srt URL', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
    });
    const s = args.join(' ');
    assert.ok(args.includes('-progress') && args.includes('pipe:1'), 'phải có -progress pipe:1');
    assert.ok(s.includes('scale=1280:720'), 'filter scale 720p');
    assert.ok(s.includes('libx264') && s.includes('-b:v 2000k') && s.includes('-maxrate 2000k') && s.includes('-bufsize 4000k'), 'CBR 2 Mbps');
    assert.ok(s.includes('-g 50'), 'GOP 2s');
    assert.ok(s.includes('srt://0.0.0.0:9001?mode=listener&streamid=demo4'), 'srt listen + streamid mặc định tên kênh');
    assert.ok(s.includes('-c:a aac') && s.includes('-ar 48000'), 'audio AAC 48kHz');
  });

  it('nhiều rendition → split filter + map đúng [v0]/[v1]', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      presets: presetsById(['p1080', 'p720']),
      outputs: [
        parseOutput({ type: 'srt-listen', presetId: 'p1080', enabled: true, port: 9001 }),
        parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9002 }),
      ],
    });
    const s = args.join(' ');
    assert.ok(s.includes('split=2'), 'phải split khi >1 rendition');
    assert.ok(s.includes('[v0]') && s.includes('[v1]'), 'map đủ 2 nhánh video');
    assert.ok(s.includes('srt://0.0.0.0:9001') && s.includes('srt://0.0.0.0:9002'), 'đủ 2 srt listen');
  });

  it('srt-caller + passphrase resolve từ secrets, mã hóa URL', () => {
    const args = buildFfmpegArgs({
      channelName: 'vtv1',
      loopbackPort: 6002,
      presets: presetsById(['p720']),
      outputs: [
        parseOutput({ type: 'srt-caller', presetId: 'p720', enabled: true, host: '203.0.113.10', port: 9001, streamId: 'vtv1-hd', passphraseRef: 'vtvgo' }),
      ],
      secrets: { vtvgo: 'mat-khau-rat-dai-12345' },
    });
    const s = args.join(' ');
    assert.ok(s.includes('srt://203.0.113.10:9001?mode=caller&streamid=vtv1-hd&passphrase='), 'caller URL đúng');
  });

  it('passphrase thiếu hoặc ngắn (<16) thì ném', () => {
    const out = { type: 'srt-caller', presetId: 'p720', enabled: true, host: '203.0.113.10', port: 9001, passphraseRef: 'vtvgo' };
    assert.throws(
      () => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: presetsById(['p720']), outputs: [parseOutput(out)], secrets: {} }),
      /thiếu passphrase/,
    );
    assert.throws(
      () => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: presetsById(['p720']), outputs: [parseOutput(out)], secrets: { vtvgo: 'ngan' } }),
      /≥16 ký tự/,
    );
  });

  it('rtmp-push ra -f flv đúng url/key', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'rtmp-push', presetId: 'p720', enabled: true, url: 'rtmp://203.0.113.20/live', streamKey: 'kênh-1' })],
    });
    const i = args.indexOf('-f');
    assert.ok(i >= 0);
    assert.ok(args.includes('flv'));
    assert.ok(args.includes('rtmp://203.0.113.20/live/kênh-1'));
  });

  it('udp-mcast ra udp URL đủ pkt_size/localaddr/ttl', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'udp-mcast', presetId: 'p720', enabled: true, group: '236.30.233.1', port: 7001, localAddr: '192.168.20.200' })],
    });
    assert.ok(args.includes('udp://236.30.233.1:7001?pkt_size=1316&localaddr=192.168.20.200&ttl=1'));
  });

  it('audio-only ra -vn, không có libx264', () => {
    const args = buildFfmpegArgs({
      channelName: 'radio',
      loopbackPort: 6003,
      presets: presetsById(['paudio']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'paudio', enabled: true, port: 9010 })],
    });
    assert.ok(args.includes('-vn'), 'audio-only phải -vn');
    assert.ok(!args.includes('libx264'), 'audio-only không encode video');
    assert.ok(!args.includes('-filter_complex'), 'audio-only không cần filter video');
  });

  it('tick mã hóa mà ref trống thì parseOutput ném (mirror FE)', () => {
    assert.throws(
      () => parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001, passphraseRef: '' }),
      /ref trống/,
    );
  });

  it('output trỏ preset không tick chọn thì checkOutputPresetRefs báo', () => {
    const ok = [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 }] as Parameters<typeof checkOutputPresetRefs>[1];
    assert.equal(checkOutputPresetRefs(['p720'], ok), null);
    const bad = [{ type: 'srt-listen', presetId: 'p1080', enabled: true, port: 9001 }] as Parameters<typeof checkOutputPresetRefs>[1];
    assert.match(checkOutputPresetRefs(['p720'], bad) ?? '', /chưa tick chọn/);
    const off = [{ type: 'srt-listen', presetId: 'p1080', enabled: false, port: 9001 }] as Parameters<typeof checkOutputPresetRefs>[1];
    assert.equal(checkOutputPresetRefs(['p720'], off), null); // output tắt thì bỏ qua
  });

  it('lỗi fail-fast: preset lạ, port trùng, group 239.x, rtmp-in, thiếu output', () => {
    const ps = presetsById(['p720']);
    const listen = (port: number): unknown => ({ type: 'srt-listen', presetId: 'p720', enabled: true, port });
    assert.throws(() => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: ps, outputs: [parseOutput({ type: 'srt-listen', presetId: 'p999', enabled: true, port: 9001 })] }), /không tồn tại/);
    assert.throws(
      () => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: ps, outputs: [parseOutput(listen(9001)), parseOutput(listen(9001))] }),
      /trùng/,
    );
    assert.throws(
      () => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: ps, outputs: [parseOutput({ type: 'udp-mcast', presetId: 'p720', enabled: true, group: '239.9.9.9', port: 7001, localAddr: '192.168.20.200' })] }),
      /239/,
    );
    assert.throws(
      () => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: ps, outputs: [parseOutput({ type: 'rtmp-in', presetId: 'p720', enabled: true, streamKey: 'k' })] }),
      /T3/,
    );
    assert.throws(() => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: ps, outputs: [] }), /≥1 output/);
    assert.throws(() => buildFfmpegArgs({ channelName: 'v', loopbackPort: 6001, presets: [], outputs: [parseOutput(listen(9001))] }), /≥1 preset/);
  });

  it('preset không có output trỏ tới thì KHÔNG sinh nhánh filter (ffmpeg bắt map hết)', () => {
    // Bug thật bắt bằng E2E: nhánh thừa → "Error binding filtergraph inputs/outputs".
    const args = buildFfmpegArgs({
      channelName: 'v',
      loopbackPort: 6001,
      presets: presetsById(['p1080', 'p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
    });
    const s = args.join(' ');
    assert.ok(!s.includes('split='), '1 rendition dùng thì không split');
    assert.ok(s.includes('scale=1280:720'), 'chỉ scale rendition được dùng');
    assert.ok(!s.includes('1920'), 'không nhắc gì tới preset thừa');
    assert.ok(!s.includes('[v1]'), 'không có nhánh [v1] thừa');
  });

  it('preset width lẻ thì parsePreset ném (x264 yêu cầu chẵn)', () => {
    assert.throws(() => parsePreset({ id: 'x', name: 'x', video: { codec: 'h264', width: 853, height: 480, bitrateKbps: 1000, fps: 25, gop: 50, preset: 'veryfast' }, audio: { codec: 'aac', bitrateKbps: 128, sampleRate: 48000, channels: 2 } }), /chẵn/);
  });
});

describe('engine CPU/GPU', () => {
  it('mặc định (bỏ trống) = cpu → libx264 veryfast', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
    });
    const s = args.join(' ');
    assert.ok(s.includes('libx264') && s.includes('veryfast'), 'default phải là cpu/libx264');
    assert.ok(!s.includes('h264_nvenc'));
  });

  it('engine nvenc → h264_nvenc preset p4, giữ CBR/GOP', () => {
    const args = buildFfmpegArgs({
      channelName: 'demo4',
      loopbackPort: 6001,
      engine: 'nvenc',
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
    });
    const s = args.join(' ');
    assert.ok(s.includes('h264_nvenc'), 'phải dùng encoder NVIDIA');
    assert.ok(s.includes('p4'), 'veryfast map sang p4');
    assert.ok(!s.includes('libx264'), 'nvenc không lẫn libx264');
    assert.ok(s.includes('-b:v 2000k') && s.includes('-maxrate 2000k') && s.includes('-g 50'), 'giữ CBR + GOP');
  });

  it('qsv/vaapi giữ chỗ → ném rõ ràng, engine lạ cũng ném', () => {
    const base = { channelName: 'v', loopbackPort: 6001, presets: presetsById(['p720']), outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })] };
    assert.throws(() => buildFfmpegArgs({ ...base, engine: 'qsv' }), /giữ chỗ/);
    assert.throws(() => buildFfmpegArgs({ ...base, engine: 'vaapi' }), /giữ chỗ/);
    assert.throws(() => buildFfmpegArgs({ ...base, engine: 'cuda' as unknown as 'cpu' }), /không hợp lệ/);
  });

  it('normalize: DB cũ thiếu engine → cpu; engine lạ → cpu', async () => {
    assert.equal(normalizeChannelTranscode({ enabled: true, loopbackPort: 6001, presetIds: [], outputs: [] })?.engine, 'cpu');
    assert.equal(normalizeChannelTranscode({ enabled: true, loopbackPort: 6001, presetIds: [], outputs: [], engine: 'nvenc' })?.engine, 'nvenc');
    assert.equal(
      normalizeChannelTranscode({ enabled: true, loopbackPort: 6001, presetIds: [], outputs: [], engine: 'cuda' as unknown as 'cpu' })?.engine,
      'cpu',
    );
  });

  it('assertEngineAvailable: đủ encoder thì qua, thiếu h264_nvenc thì ném kèm hướng dẫn', () => {
    assert.equal(requiredEncoder('cpu'), 'libx264');
    assert.equal(requiredEncoder('nvenc'), 'h264_nvenc');
    assert.doesNotThrow(() => assertEngineAvailable('cpu', ' V..... libx264 libx264 H.264\n'));
    assert.doesNotThrow(() => assertEngineAvailable('nvenc', ' V..... libx264\n V..... h264_nvenc NVIDIA\n'));
    assert.throws(() => assertEngineAvailable('nvenc', ' V..... libx264 libx264 H.264\n'), /Dockerfile.backend-gpu/);
  });
});

describe('input file override (lab/source file)', () => {
  it('inputUrl file → -i file, không ép -f mpegts; UDP mặc định vẫn ép', () => {
    const file = buildFfmpegArgs({
      channelName: 'filech',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
      inputUrl: '/mnt/Data/cap.ts',
    });
    const fi = file.indexOf('-i');
    assert.equal(file[fi + 1], '/mnt/Data/cap.ts');
    assert.equal(file[fi - 1], 'pipe:1'); // không có '-f mpegts' trước -i file (tự detect demuxer)
    // UDP mặc định: -f mpegts đứng ngay trước -i udp://
    const udp = buildFfmpegArgs({
      channelName: 'udpch',
      loopbackPort: 6001,
      presets: presetsById(['p720']),
      outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
    });
    const ui = udp.indexOf('-i');
    assert.equal(udp[ui - 2], '-f');
    assert.equal(udp[ui - 1], 'mpegts');
    assert.ok((udp[ui + 1] ?? '').startsWith('udp://'));
  });

  it('inputUrl rỗng thì ném', () => {
    assert.throws(
      () =>
        buildFfmpegArgs({
          channelName: 'x',
          loopbackPort: 6001,
          presets: presetsById(['p720']),
          outputs: [parseOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 })],
          inputUrl: '  ',
        }),
      /inputUrl rỗng/,
    );
  });
});

describe('puller RTMP→UDP', () => {
  it('argv remux copy ra UDP localhost, giữ -progress', () => {
    const args = buildPullerArgs({ rtmpUrl: 'rtmp://127.0.0.1:1935/live', streamKey: 'dn1', udpPort: 6101 });
    const s = args.join(' ');
    assert.ok(args.includes('-progress') && args.includes('pipe:1'), 'giữ progress để giám sát');
    assert.ok(s.includes('-i rtmp://127.0.0.1:1935/live/dn1'), 'input RTMP đủ url/key');
    assert.ok(args.includes('-c') && args.includes('copy'), 'remux -c copy (nhẹ CPU)');
    assert.ok(s.includes('udp://127.0.0.1:6101?pkt_size=1316'), 'output UDP localhost');
  });

  it('validate: thiếu key, sai port, inputUrl override cho lab', () => {
    assert.throws(() => parsePuller({ rtmpUrl: 'rtmp://x/live', streamKey: '', udpPort: 6101 }), TranscodeError);
    assert.throws(() => parsePuller({ rtmpUrl: 'rtmp://x/live', streamKey: 'k', udpPort: 6001 }), TranscodeError);
    const args = buildPullerArgs({ rtmpUrl: 'rtmp://x/live', streamKey: 'k', udpPort: 6101, inputUrl: '/tmp/in.ts' });
    assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.ts');
  });

  it('normalize DB cũ: thiếu → undefined, sai → undefined (nguồn trực tiếp)', () => {
    assert.equal(normalizeSourcePuller(undefined), undefined);
    assert.equal(normalizeSourcePuller({} as unknown as Parameters<typeof normalizeSourcePuller>[0]), undefined);
    assert.deepEqual(normalizeSourcePuller({ rtmpUrl: 'rtmp://x/live', streamKey: 'k', udpPort: 6101 }), {
      rtmpUrl: 'rtmp://x/live',
      streamKey: 'k',
      udpPort: 6101,
    });
  });
});

describe('normalizeChannelTranscode', () => {
  it('undefined giữ undefined (DB cũ không transcode)', () => {
    assert.equal(normalizeChannelTranscode(undefined), undefined);
  });
  it('DB cũ thiếu presetIds/outputs/engine thì điền default', () => {
    const n = normalizeChannelTranscode({ enabled: true, loopbackPort: 6001 } as unknown as Parameters<typeof normalizeChannelTranscode>[0]);
    assert.deepEqual(n, { enabled: true, loopbackPort: 6001, presetIds: [], outputs: [], engine: 'cpu' });
  });
});

describe('parseTcStartDelayMs', () => {
  it('số dương giữ nguyên; rỗng/chữ/số âm → 1000 (giữ delay chống sốc UDP)', () => {
    assert.equal(parseTcStartDelayMs('1500'), 1500);
    assert.equal(parseTcStartDelayMs(''), 1000);
    assert.equal(parseTcStartDelayMs(undefined), 1000);
    assert.equal(parseTcStartDelayMs('abc'), 1000);
    assert.equal(parseTcStartDelayMs('-5'), 1000);
    assert.equal(parseTcStartDelayMs('0'), 1000);
  });
});

describe('capture agent SDI→UDP', () => {
  it('argv decklink → encode mezzanine → UDP, giữ interlace (không yadif)', () => {
    const presets = defaultPresets();
    const p1080 = presets.find((p) => p.id === 'p1080');
    if (p1080 === undefined) throw new Error('thiếu preset seed p1080');
    const args = buildCaptureArgs({
      device: 'UltraStudio Mini Recorder',
      udpPort: 6201,
      preset: p1080,
    });
    const s = args.join(' ');
    assert.ok(s.includes('-f decklink'), 'input decklink');
    assert.ok(s.includes("-i UltraStudio Mini Recorder"), 'đúng device');
    assert.ok(s.includes('libx264') && s.includes('-b:v 4000k'), 'encode mezzanine theo preset');
    assert.ok(!s.includes('yadif'), 'KHÔNG deinterlace ở agent (giữ interlace cho dưới)');
    assert.ok(s.includes('udp://127.0.0.1:6201?pkt_size=1316'), 'output UDP localhost');
    assert.ok(s.includes('0:a?'), 'audio optional (card có thể không có tiếng embedded)');
  });

  it('cardIndex/formatCode/connection ra argv; audio-only preset bị từ chối', () => {
    const presets = defaultPresets();
    const p1080 = presets.find((p) => p.id === 'p1080');
    const paudio = presets.find((p) => p.id === 'paudio');
    if (p1080 === undefined || paudio === undefined) throw new Error('thiếu preset seed');
    const args = buildCaptureArgs({
      device: 'DeckLink Mini Recorder 4K',
      cardIndex: 1,
      connection: 'sdi',
      formatCode: 'Hi50',
      udpPort: 6202,
      preset: p1080,
    });
    const s = args.join(' ');
    assert.ok(s.includes('-format_code Hi50') && s.includes('-video_input sdi'), 'format + cổng vào');
    assert.ok(s.includes('DeckLink Mini Recorder 4K@1'), 'card thứ N');
    assert.throws(
      () => buildCaptureArgs({ device: 'X', udpPort: 6201, preset: paudio }),
      /cần preset video/,
    );
  });

  it('validate capture: thiếu device, sai port, inputUrl override lab', () => {
    const presets = defaultPresets();
    const p720 = presets.find((p) => p.id === 'p720');
    if (p720 === undefined) throw new Error('thiếu preset seed p720');
    assert.throws(() => parseCapture({ device: '', udpPort: 6201 }), TranscodeError);
    assert.throws(() => parseCapture({ device: 'X', udpPort: 6101 }), TranscodeError);
    const args = buildCaptureArgs({ device: 'X', udpPort: 6201, preset: p720, inputUrl: '/tmp/in.ts' });
    assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.ts');
    assert.equal(normalizeSourceCapture(undefined), undefined);
    const norm = normalizeSourceCapture({ device: 'X', udpPort: 6201 });
    assert.ok(norm !== undefined);
    assert.equal(norm.presetId, 'p1080');
    assert.equal(norm.engine, 'cpu');
  });
});
