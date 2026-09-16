// timeshift.test.ts — PAT parse + playlist ảo + probe (fake tsp, không cần tín hiệu).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { buildTimeshiftPlaylist, parsePatPrograms, probeProgramCount, TimeshiftError } from './timeshift.js';

const PAT1 = `* PAT, TID 0x00 (0), PID 0x0000 (0)
  Version: 6, sections: 1, total size: 16 bytes
  - Section 0:
    TS id:   30663 (0x77C7)
    Program:     1 (0x0001)  PID:   32 (0x0020)
`;
const PAT2 = `${PAT1}    Program:     2 (0x0002)  PID:   33 (0x0021)
`;

describe('timeshift', () => {
  it('parsePatPrograms đếm đúng program', () => {
    assert.deepEqual(parsePatPrograms(PAT1), [1]);
    assert.deepEqual(parsePatPrograms(PAT2), [1, 2]);
    assert.deepEqual(parsePatPrograms('không có gì'), []);
  });

  it('playlist: sequence theo số chunk, gap thì DISCONTINUITY + ENDLIST', () => {
    const out = buildTimeshiftPlaylist(
      [
        { file: 'catchup-000010.ts', mtimeMs: 1000 },
        { file: 'catchup-000011.ts', mtimeMs: 61000 },
        { file: 'catchup-000050.ts', mtimeMs: 500000 },
      ],
      'token=T&exp=1',
    );
    assert.ok(out.includes('#EXT-X-MEDIA-SEQUENCE:10'));
    assert.ok(out.includes('catchup-000010.ts?token=T&exp=1'));
    assert.ok(out.includes('#EXT-X-DISCONTINUITY'));
    assert.ok(out.trimEnd().endsWith('#EXT-X-ENDLIST'));
  });

  it('rỗng thì ném TimeshiftError', () => {
    assert.throws(() => buildTimeshiftPlaylist([], 'q=1'), TimeshiftError);
  });

  it('URI endpoint đầy đủ: sequence từ file=, query nối bằng &', () => {
    const out = buildTimeshiftPlaylist(
      [
        {
          file: '/api/timeshift/chunks?source=TMS&file=catchup_00007.ts&channel=tsShift',
          mtimeMs: 1000,
        },
      ],
      'token=T&exp=1',
    );
    assert.ok(out.includes('#EXT-X-MEDIA-SEQUENCE:7'));
    assert.ok(
      out.includes(
        '/api/timeshift/chunks?source=TMS&file=catchup_00007.ts&channel=tsShift&token=T&exp=1',
      ),
    );
  });

  it('probe: fake tsp in PAT → đếm được; treo → timeout TimeshiftError', async () => {
    const fake = '/tmp/vtc-fake-tsp-probe.sh';
    writeFileSync(fake, '#!/bin/sh\nprintf "Program:     1 (0x0001)  PID:   32\\n"\nexit 0\n', 'utf8');
    chmodSync(fake, 0o755);
    assert.deepEqual(await probeProgramCount(fake, '/tmp/x.ts', 5000), [1]);
    const hanging = '/tmp/vtc-fake-tsp-hang.sh';
    writeFileSync(hanging, '#!/bin/sh\nsleep 30\n', 'utf8');
    chmodSync(hanging, 0o755);
    await assert.rejects(() => probeProgramCount(hanging, '/tmp/x.ts', 100), TimeshiftError);
  });
});
