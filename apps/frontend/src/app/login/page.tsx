'use client';
// Trang đăng nhập độc lập /login (PRD §4.8): username + password + link quên MK.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

export default function Login(): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.login(username, password);
      router.push(r.user.role === 'admin' ? '/' : '/channels');
    } catch {
      setError('Sai tên đăng nhập hoặc mật khẩu');
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-xl bg-white p-6 shadow">
        <h1 className="text-lg font-bold">VTCAIO — Đăng nhập</h1>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Tên đăng nhập"
          className="w-full rounded border px-3 py-2 text-sm"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mật khẩu"
          className="w-full rounded border px-3 py-2 text-sm"
        />
        {error !== '' && <p className="text-sm text-red-600">{error}</p>}
        <button className="w-full rounded bg-slate-900 py-2 text-sm text-white">Đăng nhập</button>
        <a href="/forgot-password" className="block text-center text-sm text-slate-500">
          Quên mật khẩu?
        </a>
      </form>
    </main>
  );
}
