// transcode.test.ts — validate form FE (mirror backend, không gọi mạng).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateChannelTranscode, validateOutput } from './transcode.js';

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
    assert.match(validateOutput({ type: 'rtmp-push', presetId: 'p720', enabled: true, url: 'rtmp://x/live' }) ?? '', /streamKey/);
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
