'use client';
// Trang chủ: Dashboard giám sát (SystemMonitor) trong khung Sidebar/Header.
import { useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { SystemMonitor } from '@/components/SystemMonitor';
import { HlsHealth } from '@/components/HlsHealth';
import { RequireAdmin } from '@/lib/role';

export default function Home(): React.JSX.Element {
  const [hideMenu, setHideMenu] = useState(false);
  return (
    <RequireAdmin>
      <div className="flex">
        {!hideMenu && <Sidebar />}
        <div className="flex-1">
          <Header onMenu={() => setHideMenu((v) => !v)} />
          <main className="space-y-4 p-4">
            <h1 className="text-xl font-bold">GIÁM SÁT HỆ THỐNG</h1>
            <SystemMonitor />
            <HlsHealth />
          </main>
        </div>
      </div>
    </RequireAdmin>
  );
}
