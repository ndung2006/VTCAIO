// transcode.test.ts — validate form FE (mirror backend, không gọi mạng).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCapture, validateChannelTranscode, validateOutput, validatePuller } from './transcode.js';
import type { ChannelTranscode } from './transcode.js';

const listen = (port: number): Parameters<typeof validateOutput>[0] => ({
  type: 'srt-listen',
  presetId: 'p720',
  enabled: true,
  port,
});

describe('validateOutput', () => {
  it('srt-listen đúng dải qua; sai dải báo lỗi', () => {
    assert.equal(validateOutput(listen(9001)), null);
    assert.match(validateOutput(listen(8000)) ?? '', /9000/);
  });
  it('udp-mcast cấm 239.x + bắt localAddr', () => {
    const base = { type: 'udp-mcast', presetId: 'p720', enabled: true, port: 7001, localAddr: '192.168.20.200' } as const;
    assert.equal(validateOutput({ ...base, group: '236.30.233.1' }), null);
    assert.match(validateOutput({ ...base, group: '239.9.9.9' }) ?? '', /239/);
    const { localAddr: _omit, ...noIface } = { ...base, group: '236.30.233.1' };
    assert.match(validateOutput(noIface) ?? '', /localAddr/);
  });
  it('srt-caller/rtmp-push bắt đủ trường', () => {
    assert.match(
      validateOutput({ type: 'srt-caller', presetId: 'p720', enabled: true, port: 9001 }) ?? '',
      /host/,
    );
    assert.match(validateOutput({ type: 'rtmp-push', presetId: 'p720', enabled: true }) ?? '', /url/);
    assert.equal(validateOutput({ type: 'rtmp-push', presetId: 'p720', enabled: true, url: 'rtmp://x/live/a.stream' }), null);
  });

  it('tick mã hóa mà ref trống thì chặn ở form', () => {
    assert.match(
      validateOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001, passphraseRef: '' }) ?? '',
      /ref trống/,
    );
    assert.equal(validateOutput({ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001, passphraseRef: 'vtvgo' }), null);
    assert.equal(validateOutput(listen(9001)), null); // không tick = qua
  });
});

describe('validatePuller', () => {
  it('đúng qua; thiếu key / sai port / thiếu url đều báo', () => {
    assert.equal(validatePuller(undefined), null);
    assert.equal(
      validatePuller({ rtmpUrl: 'rtmp://127.0.0.1:1935/live', streamKey: 'k', udpPort: 6101 }),
      null,
    );
    assert.match(validatePuller({ rtmpUrl: 'rtmp://x/live', streamKey: '', udpPort: 6101 }) ?? '', /streamKey/);
    assert.match(validatePuller({ rtmpUrl: 'rtmp://x/live', streamKey: 'k', udpPort: 6001 }) ?? '', /udpPort/);
    assert.match(validatePuller({ rtmpUrl: '', streamKey: 'k', udpPort: 6101 }) ?? '', /rtmpUrl/);
  });
});

describe('validateChannelTranscode', () => {
  const good = {
    enabled: true,
    loopbackPort: 6001,
    presetIds: ['p720'],
    outputs: [listen(9001)],
  };
  it('khối đúng qua hết', () => {
    assert.equal(validateChannelTranscode(good), null);
  });

  it('output trỏ preset chưa tick thì báo', () => {
    assert.match(
      validateChannelTranscode({ ...good, outputs: [{ type: 'srt-listen', presetId: 'p1080', enabled: true, port: 9001 }] }) ?? '',
      /chưa tick chọn/,
    );
  });
  it('thiếu preset / thiếu output / trùng port đều báo', () => {
    assert.match(validateChannelTranscode({ ...good, presetIds: [] }) ?? '', /preset/);
    assert.match(validateChannelTranscode({ ...good, outputs: [] }) ?? '', /output/);
    assert.match(
      validateChannelTranscode({ ...good, outputs: [listen(9001), listen(9001)] }) ?? '',
      /trùng/,
    );
    assert.match(validateChannelTranscode({ ...good, loopbackPort: 7000 }) ?? '', /loopbackPort/);
  });
});

describe('validateCapture', () => {
  it('đúng qua; thiếu device / sai port đều báo', () => {
    assert.equal(validateCapture(undefined), null);
    assert.equal(validateCapture({ device: 'UltraStudio Mini Recorder', udpPort: 6201 }), null);
    assert.match(validateCapture({ device: '', udpPort: 6201 }) ?? '', /device/);
    assert.match(validateCapture({ device: 'X', udpPort: 6101 }) ?? '', /udpPort/);
  });
});

describe('validateOutput hls', () => {
  it('hls chỉ cần presetId, không đòi port/group', () => {
    assert.equal(
      validateOutput({ type: 'hls', presetId: 'p720', enabled: true }),
      null,
    );
  });
});

describe('validateChannelTranscode recordPresetId', () => {
  const base: ChannelTranscode = {
    enabled: true,
    loopbackPort: 6001,
    presetIds: ['p720'],
    outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 }],
  };
  const presets = [
    { id: 'p720', name: '720p', video: { codec: 'h264', width: 1280, height: 720, bitrateKbps: 2000, fps: 25, gop: 50, preset: 'veryfast' }, audio: { codec: 'aac', bitrateKbps: 128, sampleRate: 48000, channels: 2 } },
    { id: 'paudio', name: 'Audio', video: null, audio: { codec: 'aac', bitrateKbps: 128, sampleRate: 48000, channels: 2 } },
  ] as Parameters<typeof validateChannelTranscode>[1];
  it('đúng qua; trỏ preset chưa tick / audio-only đều báo', () => {
    assert.equal(validateChannelTranscode({ ...base, recordPresetId: 'p720' }, presets), null);
    assert.match(validateChannelTranscode({ ...base, recordPresetId: 'p1080' }, presets) ?? '', /chưa tick chọn/);
    assert.match(
      validateChannelTranscode({ ...base, presetIds: ['p720', 'paudio'], recordPresetId: 'paudio' }, presets) ?? '',
      /cần preset video/,
    );
  });
});
