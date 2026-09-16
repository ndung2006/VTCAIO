//=============================================================================
// epg/store.ts — Lưu lịch EPG ra JSON (cùng pattern sources/exports.db.json).
// Thay CẢ NGÀY khi lô mới hơn (vắng mặt = đã xoá, đúng đặc tả §6 API đối tác).
// Quy mô: 44 kênh × ~60 ct × 10 ngày ≈ 26k bản ghi — JSON vài MB, đủ cho v1.
//=============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EpgDay } from './types.js';

export class EpgError extends Error {}

export class EpgStore {
  private readonly days = new Map<string, EpgDay>(); // key `${partnerId}|${date}`
  private readonly file: string | null;

  constructor(storeFile?: string) {
    this.file = storeFile ?? null;
    this.load();
  }

  private static key(partnerChannelId: number, date: string): string {
    return `${partnerChannelId}|${date}`;
  }

  private load(): void {
    if (this.file === null) return;
    try {
      if (!existsSync(this.file)) return;
      const arr = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(arr)) return;
      for (const d of arr) {
        const day = d as EpgDay;
        if (typeof day.partnerChannelId === 'number' && typeof day.date === 'string') {
          this.days.set(EpgStore.key(day.partnerChannelId, day.date), day);
        }
      }
    } catch {
      // file hỏng thì bắt đầu trắng
    }
  }

  save(): void {
    if (this.file === null) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.days.values()], null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // không chặn nghiệp vụ
    }
  }

  getDay(partnerChannelId: number, date: string): EpgDay | undefined {
    return this.days.get(EpgStore.key(partnerChannelId, date));
  }

  /** Ghi đè cả ngày. Trả true nếu là dữ liệu mới (lô mới hơn hoặc chưa có). */
  setDay(day: EpgDay): boolean {
    const k = EpgStore.key(day.partnerChannelId, day.date);
    const cur = this.days.get(k);
    const isNew = cur === undefined || day.updatedAt > cur.updatedAt;
    this.days.set(k, day);
    return isNew;
  }

  /** Các ngày đang có của 1 kênh đối tác (để UI chấm ngày có lịch). */
  datesOf(partnerChannelId: number): { date: string; updatedAt: string; count: number }[] {
    const out: { date: string; updatedAt: string; count: number }[] = [];
    for (const d of this.days.values()) {
      if (d.partnerChannelId === partnerChannelId) {
        out.push({ date: d.date, updatedAt: d.updatedAt, count: d.programs.length });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Xóa ngày cũ hơn keepDays (GC lịch). Trả số ngày đã xóa. */
  pruneOlderThan(cutoffDate: string): number {
    let n = 0;
    for (const [k, d] of this.days) {
      if (d.date < cutoffDate) {
        this.days.delete(k);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.days.size;
  }
}
