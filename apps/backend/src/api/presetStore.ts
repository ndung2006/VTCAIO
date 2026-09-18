//=============================================================================
// presetStore.ts — Kho preset transcode (docs/16 §3.1, §8.1).
// In-memory Map + persist presets.db.json (giống pattern sources.db.json:
// atomic write tmp+rename, boot seed default nếu trống).
// Sửa preset không ảnh hưởng kênh đang chạy (argv snapshot lúc start ffmpeg).
//=============================================================================

import { parsePreset } from '../core/TranscodeConfigGenerator.js';
import type { TranscodePreset } from '../core/types.js';

export class PresetStore {
  private readonly presets = new Map<string, TranscodePreset>();

  listPresets(): TranscodePreset[] {
    return [...this.presets.values()];
  }

  getPreset(id: string): TranscodePreset | undefined {
    return this.presets.get(id);
  }

  /** Tạo mới (validate zod, id duy nhất). */
  createPreset(p: TranscodePreset): TranscodePreset {
    const v = parsePreset(p);
    if (this.presets.has(v.id)) throw new Error(`Preset ${v.id} đã tồn tại`);
    this.presets.set(v.id, v);
    return v;
  }

  /** Sửa (validate zod, id trên path phải khớp body nếu body có id). */
  updatePreset(id: string, p: TranscodePreset): TranscodePreset {
    if (this.presets.get(id) === undefined) throw new Error(`Preset ${id} không tồn tại`);
    const v = parsePreset({ ...p, id });
    this.presets.set(id, v);
    return v;
  }

  deletePreset(id: string): void {
    if (this.presets.get(id) === undefined) throw new Error(`Preset ${id} không tồn tại`);
    this.presets.delete(id);
  }

  /** Seed default (chỉ điền id còn thiếu — không đè preset operator đã sửa). */
  seedDefaults(ps: TranscodePreset[]): void {
    for (const p of ps) {
      if (!this.presets.has(p.id)) this.presets.set(p.id, parsePreset(p));
    }
  }

  /** Nạp toàn bộ từ file persist (bản hỏng thì bỏ qua từng cái). */
  replaceAll(ps: unknown): void {
    if (!Array.isArray(ps)) return;
    const next = new Map<string, TranscodePreset>();
    for (const p of ps) {
      try {
        const v = parsePreset(p);
        next.set(v.id, v);
      } catch {
        // preset hỏng thì bỏ qua
      }
    }
    this.presets.clear();
    for (const [k, v] of next) this.presets.set(k, v);
  }
}
