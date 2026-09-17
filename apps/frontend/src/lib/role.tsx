'use client';
// Phân quyền UI theo vai backend (admin = full, user = xem + timeshift + trích xuất).
// Bảo mật thật nằm ở API (403); đây chỉ ẩn/hiện giao diện + chặn trang.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from './api';

export function useMe(): { username: string; role: string } | null | undefined {
  const [me, setMe] = useState<{ username: string; role: string } | null | undefined>(undefined);
  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  return me;
}

/** Bọc trang chỉ-admin: chưa rõ → chờ; user thường → màn từ chối + link về Kênh. */
export function RequireAdmin({ children }: { children: React.ReactNode }): React.JSX.Element {
  const me = useMe();
  if (me === undefined) return <p className="p-4 text-sm text-slate-500">Đang kiểm tra quyền…</p>;
  if (me === null || me.role !== 'admin') {
    return (
      <main className="space-y-3 p-4">
        <h1 className="text-xl font-bold">KHÔNG CÓ QUYỀN</h1>
        <p className="text-sm text-slate-600">
          Tài khoản <b>{me?.username ?? '?'}</b> (nhân sự) chỉ được xem kênh, timeshift và trích xuất.
        </p>
        <Link href="/channels" className="inline-block rounded bg-slate-900 px-4 py-2 text-sm text-white">
          Về danh sách Kênh
        </Link>
      </main>
    );
  }
  return <>{children}</>;
}
