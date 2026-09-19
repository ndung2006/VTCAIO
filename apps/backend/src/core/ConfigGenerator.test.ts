// ConfigGenerator.test.ts — Test không cần tsp thật (thuần logic sinh conf).
// Chạy: npm test  (tsx --test src/core/*.test.ts)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, generateConfText, normalizeInputKind, splitInputArgs } from './ConfigGenerator.js';

describe('ConfigGenerator', () => {
  it('sinh MPTS 2 kênh live + record_all (đúng PRD §3.1)', () => {
    const gen = generateConfText({
      id: 'DEMO',
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: true,
      channels: [
        { name: 'demo4', serviceId: 4, isLive: true },
        { name: 'demo5', serviceId: 5, isLive: true },
      ],
    });
    assert.equal(gen.liveCount, 2);
    // Định dạng @file TSDuck 3.44: mỗi dòng đúng 1 argv (đo trên máy thật 15/09/2026).
    const lines = gen.content.split('\n').filter((l) => l !== '');
    assert.deepEqual(lines.slice(0, 6), ['-I', 'file', '/tmp/vtc-demo/input.ts', '--repeat', '-P', 'vtcmonitor']);
    assert.ok(lines.includes('fork'));
    assert.ok(lines.includes('tsp -P zap 4 -O hls --duration 5 --live 5 --playlist /media/ramdisk/live/demo4/index.m3u8 /media/ramdisk/live/demo4/segment.ts'));
    assert.ok(lines.includes('tsp -P zap 5 -O hls --duration 5 --live 5 --playlist /media/ramdisk/live/demo5/index.m3u8 /media/ramdisk/live/demo5/segment.ts'));
    assert.ok(!gen.content.includes('"'), 'không ngoặc kép trong file máy đọc');
    assert.ok(!gen.content.split('\n').some((l) => l.startsWith('#')), 'không comment trong file máy đọc');
    assert.deepEqual(lines.slice(-5), ['-O', 'hls', '--duration', '60', '/mnt/Data/catchup/captures/DEMO/catchup.ts']);
    // Nguyên tắc vàng: không bao giờ sinh --max-duration.
    assert.ok(!gen.content.includes('max-duration'));
  });

  it('VTC_MULTICAST_IFACE tự gắn cho mọi input ip (explicit thắng, file miễn)', () => {
    const base = {
      id: 'M',
      input: 'ip 239.1.1.1:5000',
      recordAll: false,
      channels: [{ name: 'm1', serviceId: 11, isLive: true }],
    };
    delete process.env['VTC_MULTICAST_IFACE'];
    assert.ok(!generateConfText(base).content.split('\n').includes('--local-address'));
    process.env['VTC_MULTICAST_IFACE'] = '172.37.0.200';
    try {
      const lines = generateConfText(base).content.split('\n');
      assert.deepEqual(lines.slice(0, 6), ['-I', 'ip', '239.1.1.1:5000', '--local-address', '172.37.0.200', '-P']);
      const explicit = generateConfText({ ...base, input: 'ip 239.1.1.1:5000 --local-address 10.0.0.9' });
      const count = explicit.content.split('\n').filter((l) => l === '--local-address').length;
      assert.equal(count, 1); // explicit giữ nguyên, không gắn đè
      assert.ok(explicit.content.includes('10.0.0.9') && !explicit.content.includes('172.37.0.200'));
      const fileIn = generateConfText({ ...base, input: 'file /tmp/a.ts' });
      assert.ok(!fileIn.content.split('\n').includes('--local-address'));
    } finally {
      delete process.env['VTC_MULTICAST_IFACE'];
    }
  });

  it('splitInputArgs tách input, tôn trọng ngoặc kép', () => {
    assert.deepEqual(splitInputArgs('ip 239.1.1.1:5000'), ['ip', '239.1.1.1:5000']);
    assert.deepEqual(splitInputArgs('ip 239.1.1.1:5000 --local-address 192.168.1.2'), [
      'ip',
      '239.1.1.1:5000',
      '--local-address',
      '192.168.1.2',
    ]);
    assert.deepEqual(splitInputArgs('file "/tmp/my video/input.ts" --repeat'), [
      'file',
      '/tmp/my video/input.ts',
      '--repeat',
    ]);
  });

  it('chặn input kiểu URL VLC (udp://...)', () => {
    assert.throws(
      () =>
        generateConfText({
          id: 'X',
          input: 'udp://239.1.1.1:5000',
          recordAll: true,
          channels: [{ name: 'v1', serviceId: 1, isLive: true }],
        }),
      /trông như URL/,
    );
  });

  it('chặn serviceId 0 (đặt trước cho NIT, zap thoát ngay)', () => {
    assert.throws(
      () =>
        generateConfText({
          id: 'X',
          input: 'file /tmp/a.ts',
          recordAll: true,
          channels: [{ name: 'v1', serviceId: 0, isLive: true }],
        }),
      /1\.\.65535/,
    );
  });

  it('recordAll=false sinh -O drop', () => {
    const gen = generateConfText({
      id: 'LIVE',
      input: 'ip 239.69.69.10:1234',
      recordAll: false,
      channels: [{ name: 'DongNai1', serviceId: 2004, isLive: true }],
    });
    const lines = gen.content.split('\n').filter((l) => l !== '');
    assert.deepEqual(lines.slice(-2), ['-O', 'drop']);
  });

  it('chặn conf vô nghĩa (0 live + record false)', () => {
    assert.throws(
      () =>
        generateConfText({ id: 'EMPTY', input: 'file /tmp/a.ts', recordAll: false, channels: [] }),
      ConfigError,
    );
  });

  it('chặn tên kênh có dấu cách (vỡ fork quote)', () => {
    assert.throws(
      () =>
        generateConfText({
          id: 'X',
          input: 'file /tmp/a.ts',
          recordAll: true,
          channels: [{ name: 'kenh xau', serviceId: 1, isLive: true }],
        }),
      ConfigError,
    );
  });

  it('normalizeInputKind: thiếu → ip; lạ → ném', () => {
    assert.equal(normalizeInputKind(undefined), 'ip');
    assert.equal(normalizeInputKind('ip'), 'ip');
    assert.equal(normalizeInputKind('sdi'), 'sdi');
    assert.throws(() => normalizeInputKind('dvb' as never), ConfigError);
  });

  it('inputKind sdi/hdmi: encoded + UDP agent 62xx thì sinh conf (mở Encode)', () => {
    const sdi = {
      id: 'SDI1',
      inputKind: 'sdi' as const,
      liveCatchupFrom: 'encoded' as const,
      input: 'ip 127.0.0.1:6201',
      recordAll: true,
      channels: [{ name: 'sdi1', serviceId: 807, isLive: true }],
    };
    const gen = generateConfText(sdi);
    assert.ok(gen.content.includes('tsp -P zap 807'), 'kênh SDI zap/conf như nguồn thường');
    // Thiếu encoded → ném (baseband không ra trực tiếp được)
    assert.throws(() => generateConfText({ ...sdi, liveCatchupFrom: 'ingest' }), /bắt buộc liveCatchupFrom=encoded/);
    // Input không phải UDP agent → ném
    assert.throws(() => generateConfText({ ...sdi, input: 'ip 239.1.1.1:5000' }), /UDP của capture agent/);
    assert.throws(() => generateConfText({ ...sdi, input: 'ip 127.0.0.1:6101' }), /UDP của capture agent/);
    assert.throws(() => generateConfText({ ...sdi, inputKind: 'hdmi', input: 'ip 239.1.1.1:5000' }), /UDP của capture agent/);
    // ip tường minh vẫn chạy như cũ
    const genIp = generateConfText({ ...sdi, inputKind: 'ip', liveCatchupFrom: 'ingest', input: 'ip 239.1.1.1:5000' });
    assert.ok(genIp.content.includes('-I'));
  });

  it('liveCatchupFrom: ip khóa ingest; giá trị lạ thì ném', () => {
    const base = {
      id: 'IP1',
      input: 'ip 239.1.1.1:5000',
      recordAll: true,
      channels: [{ name: 'c1', serviceId: 1, isLive: true }],
    };
    // thiếu = ingest (DB cũ) vẫn chạy
    assert.ok(generateConfText(base).content.includes('-I'));
    assert.ok(generateConfText({ ...base, liveCatchupFrom: 'ingest' }).content.includes('-I'));
    // ip + encoded khóa Phase 1
    assert.throws(() => generateConfText({ ...base, liveCatchupFrom: 'encoded' }), /khóa ở Phase 1/);
    assert.throws(
      () => generateConfText({ ...base, liveCatchupFrom: 'sau' } as never),
      /không hợp lệ/,
    );
  });
});
