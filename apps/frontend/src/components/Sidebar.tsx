'use client';
//=============================================================================
// Sidebar — Dark theme, 2 khối: danh sách kênh (cuộn dọc) + menu quản lý.
// Kênh lấy từ /api/sources (mỗi source chứa N channel MPTS).
//=============================================================================
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type Source } from '@/lib/api';
import { useMe } from '@/lib/role';

export function Sidebar(): React.JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const path = usePathname();
  const me = useMe();
  const isAdmin = me?.role === 'admin';

  useEffect(() => {
    api.sources().then(setSources).catch(() => setSources([]));
  }, [path]);

  return (
    <aside className="flex h-screen w-64 flex-col bg-slate-900 text-slate-200">
      <div className="p-4 font-bold text-white">VTC Catchup</div>
      <div className="flex-1 overflow-y-auto px-2">
        <p className="px-2 text-xs uppercase text-slate-400">Kênh</p>
        {sources.flatMap((s) =>
          s.channels.map((c) => {
            const href = `/channel/${encodeURIComponent(c.name)}`;
            const active = path === href;
            return (
              <Link
                key={`${s.id}:${c.name}`}
                href={href}
                className={`block rounded px-2 py-1.5 text-sm ${active ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`}
              >
                {c.name}
                <span className={`ml-2 text-xs ${s.status === 'RUNNING' ? 'text-green-400' : 'text-slate-500'}`}>
                  ●
                </span>
              </Link>
            );
          }),
        )}
      </div>
      <nav className="border-t border-slate-700 p-2 text-sm">
        {isAdmin && (
          <Link href="/" className="block rounded px-2 py-1.5 hover:bg-slate-800">
            Giám sát
          </Link>
        )}
        {isAdmin && (
          <Link href="/sources" className="block rounded px-2 py-1.5 hover:bg-slate-800">
            Nguồn
          </Link>
        )}
        <Link href="/channels" className="block rounded px-2 py-1.5 hover:bg-slate-800">
          Kênh
        </Link>
        {isAdmin && (
          <Link href="/epg" className="block rounded px-2 py-1.5 hover:bg-slate-800">
            EPG
          </Link>
        )}
        <Link href="/exports" className="block rounded px-2 py-1.5 hover:bg-slate-800">
          Trích xuất
        </Link>
        {isAdmin && (
          <Link href="/admin" className="block rounded px-2 py-1.5 hover:bg-slate-800">
            Quản trị
          </Link>
        )}
      </nav>
    </aside>
  );
}
