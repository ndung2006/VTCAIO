//=============================================================================
// middleware.ts — Route guard Frontend (PRD §4.8 D.1).
// Mọi path /dashboard, /sources, /channels, /exports, /channel/*, / (trừ /login)
// thiếu cookie vtc_token → redirect /login. Verify chữ ký JWT do backend làm
// (API nào cũng gate 401 nên không lọt được dù qua được middleware).
//=============================================================================
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED = ['/', '/dashboard', '/sources', '/channels', '/exports', '/channel', '/admin', '/account', '/epg'];

const PUBLIC = ['/login', '/forgot-password', '/reset-password'];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const needGuard = PROTECTED.some((p) => (p === '/' ? pathname === '/' : pathname.startsWith(p)));
  if (needGuard && req.cookies.get('vtc_token') === undefined) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
// Lưu ý: /api/* do backend gate 401 JSON trực tiếp — middleware không chặn để
// SSE/EventSource nhận đúng lỗi thay vì bị redirect 302 về trang login.
