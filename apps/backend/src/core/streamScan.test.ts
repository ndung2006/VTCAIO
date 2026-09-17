// streamScan.test.ts — Parser PAT/SDT thuần túy (không cần TSDuck).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScanPrograms } from './streamScan.js';

const PAT = '* PAT, TID 0x00, version 1\n    Program:     0 (0x0000)  PID:   16\n    Program:   807 (0x0327)  PID:  100\n    Program:   805 (0x0325)  PID:  200\n';

const SDT =
  '* SDT Actual (0x42), TS id: 1\n' +
  '  - Service: 807 (0x0327), EIT schedule: no, running status: running\n' +
  '    - service_descriptor (0x48):\n' +
  '      service_name: "DONGNAI1"\n' +
  '  - Service: 999 (0x03E7), EIT schedule: no, running status: running\n' +
  '    - service_descriptor (0x48):\n' +
  '      service_name: "Kenh La"\n';

describe('parseScanPrograms', () => {
  it('PAT: loại program 0 (NIT), sắp xếp tăng dần', () => {
    assert.deepEqual(parseScanPrograms(PAT), [
      { serviceId: 805, name: null },
      { serviceId: 807, name: null },
    ]);
  });

  it('gộp tên SDT theo Service id (kể cả SID chỉ có trong SDT)', () => {
    assert.deepEqual(parseScanPrograms(PAT + SDT), [
      { serviceId: 805, name: null },
      { serviceId: 807, name: 'DONGNAI1' },
      { serviceId: 999, name: 'Kenh La' },
    ]);
  });

  it('rỗng → mảng rỗng (không ném)', () => {
    assert.deepEqual(parseScanPrograms('tsp: no signal\n'), []);
  });
});
