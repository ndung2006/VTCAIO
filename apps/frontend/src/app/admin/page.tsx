'use client';
// Trang Quản trị: kiểm tra kênh cảnh báo Telegram + sao lưu/phục hồi cấu hình.
// Mọi API đã gate JWT ở backend; middleware chặn chưa login.
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { RequireAdmin } from '@/lib/role';
import { api } from '@/lib/api';

export default function AdminPage(): React.JSX.Element {
  const [tgConfigured, setTgConfigured] = useState<boolean | null>(null);
  const [statusErr, setStatusErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [pubPreview, setPubPreview] = useState('');

  const loadStatus = async (): Promise<void> => {
    try {
      const s = await api.notifyStatus();
      setTgConfigured(s.configured);
      setStatusErr('');
    } catch (err) {
      setTgConfigured(null);
      setStatusErr(err instanceof Error ? err.message : 'Không gọi được API');
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const testNotify = async (): Promise<void> => {
    setBusy(true);
    setMsg('Đang gửi tin thử…');
    try {
      const r = await api.notifyTest();
      if (r.configured) {
        setMsg(`Đã bắn tin thử (kết quả: ${r.result}). Kiểm tra Telegram của trực ca.`);
      } else {
        setMsg('Đã ghi tin thử ra log (kết quả: logged) — chưa cấu hình VTC_TELEGRAM_BOT_TOKEN/VTC_TELEGRAM_CHAT_ID nên chưa gửi Telegram thật.');
      }
      setTgConfigured(r.configured);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Bắn tin thử thất bại');
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async (): Promise<void> => {
    setMsg('');
    try {
      const bak = await api.configBackup();
      const blob = new Blob([JSON.stringify(bak, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vtc-sources-backup-${bak.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Sao lưu thất bại');
    }
  };

  const restoreFile = async (f: File): Promise<void> => {
    setMsg('');
    try {
      const parsed = JSON.parse(await f.text()) as { sources?: unknown[] };
      if (!Array.isArray(parsed.sources)) return setMsg('File không đúng định dạng (thiếu sources[]).');
      const r = await api.configRestore(parsed.sources);
      setMsg(`Phục hồi thành công ${r.count} nguồn (trạng thái STOPPED — vào trang Nguồn để Start).`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Phục hồi thất bại');
    }
  };

  return (
    <RequireAdmin>
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <h1 className="text-xl font-bold">QUẢN TRỊ HỆ THỐNG</h1>
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Kênh cảnh báo Telegram</h2>
            <p className="text-sm text-slate-600">
              Trạng thái:{' '}
              {tgConfigured === null ? (
                statusErr === '' ? (
                  'Đang kiểm tra…'
                ) : (
                  <span className="text-red-600">
                    Không gọi được API backend ({statusErr}) — kiểm tra Backend còn Running và biến
                    VTC_API_ORIGIN của Frontend.
                  </span>
                )
              ) : tgConfigured ? (
                'Đã cấu hình (crash/CC-error/HLS stale sẽ bắn về nhóm trực)'
              ) : (
                'Chưa cấu hình — cảnh báo đang ghi ra log file'
              )}
            </p>
            <button
              onClick={() => void testNotify()}
              disabled={busy}
              className="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Đang gửi…' : 'Bắn tin thử'}
            </button>
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Tích hợp VTVgo (đối tác kéo luồng)</h2>
            <p className="text-sm text-slate-600">
              Danh mục kênh máy đọc ở <code className="font-mono">/api/public/channels</code>, xác thực bằng
              header <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> (key trong
              VTC_PARTNER_KEYS ở backend). Chỉ kênh được <b>tích cột VTVgo</b> ở trang Kênh mới lên
              danh mục. Link kéo luồng từng kênh tạo ở trang Kênh (nút Link kéo).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="flex-1 break-all rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-600">
                {typeof window === 'undefined' ? '' : `${window.location.origin}/api/public/channels`}
              </code>
              <button
                onClick={() => {
                  setMsg('');
                  api
                    .publicChannels()
                    .then((j) =>
                      setPubPreview(
                        `${j.channels.length} kênh: ${j.channels.map((c) => c.name).join(', ') || '—'}`,
                      ),
                    )
                    .catch((err: unknown) => setMsg(err instanceof Error ? err.message : 'Xem trước thất bại'));
                }}
                className="rounded bg-slate-200 px-4 py-2 text-sm"
              >
                Xem trước danh mục
              </button>
            </div>
            {pubPreview !== '' && <p className="mt-2 text-sm text-slate-600">{pubPreview}</p>}
            <p className="mt-2 text-xs text-slate-500">
              Chi tiết cho phía VTVgo: docs/14-VTVGO.md (endpoint, header, hết hạn, thu hồi).
            </p>
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Sao lưu / Phục hồi cấu hình nguồn</h2>
            <p className="text-sm text-slate-600">
              Tải file JSON chứa toàn bộ nguồn + kênh để lưu ngoài. Phục hồi yêu cầu mọi nguồn đang
              STOPPED (tránh đè cấu hình lúc đang chạy).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={downloadBackup} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
                Tải file sao lưu
              </button>
              <label className="cursor-pointer rounded bg-slate-200 px-4 py-2 text-sm">
                Chọn file phục hồi
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f !== undefined) void restoreFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Nhân sự (tài khoản xem)</h2>
            <UsersCard />
          </div>
        </main>
      </div>
    </div>
    </RequireAdmin>
  );
}

function UsersCard(): React.JSX.Element {
  const [users, setUsers] = useState<{ username: string; email: string; role: string }[]>([]);
  const [msg, setMsg] = useState('');
  const [u, setU] = useState('');
  const [e, setE] = useState('');
  const [p, setP] = useState('');

  const reload = useCallback(async () => {
    try {
      setUsers(await api.adminUsers());
    } catch {
      setUsers([]);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault();
    setMsg('');
    try {
      await api.adminCreateUser(u.trim(), e.trim(), p, 'user');
      setMsg(`Đã tạo nhân sự ${u.trim()} (vai xem).`);
      setU('');
      setE('');
      setP('');
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Tạo thất bại');
    }
  };

  const remove = async (username: string): Promise<void> => {
    if (!window.confirm(`Xóa nhân sự ${username}?`)) return;
    setMsg('');
    try {
      await api.adminDeleteUser(username);
      setMsg(`Đã xóa ${username}.`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Xóa thất bại');
    }
  };

  const resetPw = async (username: string): Promise<void> => {
    const np = window.prompt(`Mật khẩu mới cho ${username} (≥ 8 ký tự):`);
    if (np === null || np === '') return;
    setMsg('');
    try {
      await api.adminSetPassword(username, np);
      setMsg(`Đã đặt lại mật khẩu cho ${username} — báo họ đăng nhập lại.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Đặt lại thất bại');
    }
  };

  return (
    <div>
      {msg !== '' && <p className="mb-2 rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
      <table className="w-full text-sm">
        <tbody>
          {users.map((x) => (
            <tr key={x.username} className="border-t">
              <td className="py-1.5 font-mono">{x.username}</td>
              <td className="text-slate-500">{x.email}</td>
              <td>{x.role === 'admin' ? 'quản trị' : 'nhân sự'}</td>
              <td className="space-x-2 text-right">
                {x.role !== 'admin' && (
                  <>
                    <button onClick={() => void resetPw(x.username)} className="rounded bg-slate-200 px-3 py-1">
                      Đặt lại MK
                    </button>
                    <button
                      onClick={() => void remove(x.username)}
                      className="rounded bg-red-100 px-3 py-1 text-red-700"
                    >
                      Xóa
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={create} className="mt-3 flex flex-wrap gap-2">
        <input
          value={u}
          onChange={(ev) => setU(ev.target.value)}
          placeholder="Tên đăng nhập"
          className="w-36 rounded border px-2 py-1.5 text-sm"
        />
        <input
          value={e}
          onChange={(ev) => setE(ev.target.value)}
          placeholder="Email"
          type="email"
          className="w-48 rounded border px-2 py-1.5 text-sm"
        />
        <input
          value={p}
          onChange={(ev) => setP(ev.target.value)}
          placeholder="Mật khẩu ≥ 8 ký tự"
          type="password"
          className="w-44 rounded border px-2 py-1.5 text-sm"
        />
        <button className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white">Thêm nhân sự</button>
      </form>
      <p className="mt-2 text-xs text-slate-500">
        Nhân sự chỉ xem kênh, timeshift, trích xuất. Mọi cấu hình/giám sát/quản trị đều chặn 403 ở API.
      </p>
    </div>
  );
}
