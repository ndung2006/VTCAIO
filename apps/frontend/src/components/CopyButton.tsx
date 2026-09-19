// CopyButton — Sao chép link .m3u8 cho VLC/đối tác (PRD §4.7) + tooltip.
'use client';
import { useState } from 'react';

export function CopyButton({ text, label, disabled }: { text: string; label?: string; disabled?: boolean }): React.JSX.Element {
  const [done, setDone] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  const base = label ?? 'Copy';
  return (
    <button
      onClick={copy}
      disabled={disabled === true || text === ''}
      title={done ? 'Đã sao chép' : 'Sao chép'}
      className="shrink-0 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
    >
      {done ? 'Đã sao chép' : base}
    </button>
  );
}
