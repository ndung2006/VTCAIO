'use client';
//=============================================================================
// Trang trích xuất (PRD §6): form In/Out + bảng lịch sử + tải/xóa.
// Validate client (Out>In, ≤6h) — backend chặn cứng lần nữa, không tin client.
// Poll lịch sử mỗi 3s để thấy PROCESSING → SUCCESS/ERROR mà không reload.
// Xóa có modal xác nhận (xóa file vật lý, không khôi phục).
//=============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { api, type Source } from '@/lib/api';

const MAX_HOURS = 6;

interface ExportJob {
  id: string;
  channelName: string;
  serviceId: number;
  inPoint: number;
  outPoint: number;
  status: 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'ERROR';
  fileName: string;
  size: number | null;
  error?: string;
}

interface ChannelOpt {
  key: string;
  label: string;
  channelName: string;
  sourceId: string;
  serviceId: number;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function fmtSize(b: number | null): string {
  if (b === null) return '—';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
}

/** ISO → giá trị input datetime-local (giờ local trình duyệt). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ExportsPage(): React.JSX.Element {
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [sel, setSel] = useState('');
  const [inp, setInp] = useState('');
  const [outp, setOutp] = useState('');
  const [msg, setMsg] = useState('');
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [confirmDel, setConfirmDel] = useState<ExportJob | null>(null);
  const prefilled = useRef(false);

  useEffect(() => {
    api
      .sources()
      .then((ss: Source[]) =>
        setChannels(
          ss.flatMap((s) =>
            s.channels.map((c) => ({
              key: `${s.id}:${c.name}`,
              label: `${c.name} (${s.id})`,
              channelName: c.name,
              sourceId: s.id,
              serviceId: c.serviceId,
            })),
          ),
        ),
      )
      .catch(() => setChannels([]));
  }, []);

  // Prefill 1 lần từ EPG (?channel=&in=&out=) — đọc window trực tiếp để khỏi
  // Suspense boundary (useSearchParams bắt buộc bọc Suspense).
  useEffect(() => {
    if (prefilled.current || channels.length === 0) return;
    prefilled.current = true;
    const q = new URLSearchParams(window.location.search);
    const ch = q.get('channel') ?? '';
    const a = q.get('in') ?? '';
    const b = q.get('out') ?? '';
    if (ch !== '') {
      const opt = channels.find((c) => c.channelName === ch);
      if (opt !== undefined) setSel(opt.key);
    }
    if (a !== '') setInp(toLocalInput(a));
    if (b !== '') setOutp(toLocalInput(b));
    if (ch !== '' || a !== '' || b !== '') setMsg('Đã điền sẵn từ chương trình EPG — kiểm tra lại rồi bấm Trích xuất.');
  }, [channels]);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/exports', { credentials: 'include' });
      if (r.ok) setJobs((await r.json()) as ExportJob[]);
    } catch {
      /* backend chưa chạy */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [reload]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setMsg('');
    const opt = channels.find((c) => c.key === sel);
    if (opt === undefined) return setMsg('Hãy chọn kênh.');
    const a = new Date(inp).getTime();
    const b = new Date(outp).getTime();
    if (!(b > a)) return setMsg('Out-point phải lớn hơn In-point.');
    if (b - a > MAX_HOURS * 3600 * 1000) {
      return setMsg(
        'Hệ thống chỉ hỗ trợ trích xuất tối đa 6 tiếng mỗi lần để đảm bảo an toàn tài nguyên I/O máy chủ. Vui lòng chia nhỏ khoảng thời gian.',
      );
    }
    const r = await fetch('/api/exports', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelName: opt.channelName,
        sourceId: opt.sourceId,
        serviceId: opt.serviceId,
        inPoint: new Date(inp).toISOString(),
        outPoint: new Date(outp).toISOString(),
      }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return setMsg(j.error ?? 'Gửi yêu cầu thất bại');
    }
    setMsg('Đã nhận yêu cầu — đang xử lý ngầm, bảng bên dưới sẽ tự cập nhật.');
    void reload();
  };

  const remove = async (): Promise<void> => {
    if (confirmDel === null) return;
    await fetch(`/api/exports/${confirmDel.id}`, { method: 'DELETE', credentials: 'include' });
    setConfirmDel(null);
    void reload();
  };

  return (
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <h1 className="text-xl font-bold">TRÍCH XUẤT LƯU CHIỂU</h1>
          <form onSubmit={submit} className="max-w-md space-y-3 rounded-xl bg-white p-4 shadow">
            <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full rounded border px-3 py-2 text-sm">
              <option value="">— Chọn kênh —</option>
              {channels.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <input type="datetime-local" value={inp} onChange={(e) => setInp(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" />
            <input type="datetime-local" value={outp} onChange={(e) => setOutp(e.target.value)} className="w-full rounded border px-3 py-2 text-sm" />
            {msg !== '' && <p className="text-sm text-slate-600">{msg}</p>}
            <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white">Thực hiện trích xuất</button>
          </form>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Lịch sử trích xuất</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1">Kênh</th>
                  <th>In → Out</th>
                  <th>Trạng thái</th>
                  <th>Kích thước</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="py-1.5">{j.channelName}</td>
                    <td>
                      {fmtTime(j.inPoint)} → {fmtTime(j.outPoint)}
                    </td>
                    <td>
                      {j.status === 'SUCCESS' && <span className="text-green-600">Hoàn thành</span>}
                      {(j.status === 'QUEUED' || j.status === 'PROCESSING') && (
                        <span className="text-amber-600">Đang xử lý</span>
                      )}
                      {j.status === 'ERROR' && (
                        <span className="text-red-600" title={j.error ?? ''}>
                          Lỗi
                        </span>
                      )}
                    </td>
                    <td>{fmtSize(j.size)}</td>
                    <td className="space-x-2 text-right">
                      {j.status === 'SUCCESS' && (
                        <a href={`/api/exports/${j.id}/download`} className="rounded bg-slate-900 px-3 py-1 text-white">
                          Tải về
                        </a>
                      )}
                      {(j.status === 'SUCCESS' || j.status === 'ERROR') && (
                        <button onClick={() => setConfirmDel(j)} className="rounded bg-slate-200 px-3 py-1">
                          Xóa
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length === 0 && <p className="py-2 text-sm text-slate-500">Chưa có tác vụ nào.</p>}
          </div>
        </main>
      </div>

      {confirmDel !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl bg-white p-5 shadow">
            <p className="text-sm font-semibold">Xóa file trích xuất?</p>
            <p className="mt-1 text-sm text-slate-600">
              Hành động này sẽ xóa file vật lý {confirmDel.fileName} và không thể khôi phục.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="rounded bg-slate-200 px-4 py-1.5 text-sm">
                Hủy
              </button>
              <button onClick={remove} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white">
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
