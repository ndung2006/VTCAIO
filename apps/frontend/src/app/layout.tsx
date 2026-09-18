import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'VTCAIO' };

// Layout: Sidebar dark + Header light + Workspace xám (PRD §4.1).
// Trang /login render riêng (không sidebar) — xử lý trong từng page.
export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="vi">
      <body className="bg-slate-50">{children}</body>
    </html>
  );
}
