// A timesheet file (Excel / CSV) for "Send hours for approval": the rows of the
// picked worker, to check and send like rows typed by hand. Columns by their
// header: Date, In, Out (English or Hebrew); an optional Worker column (a name
// or an ID / passport number) lets one sheet hold several workers.
import { loadScript, XLSX_URL } from '@/lib/backend';
import { tr } from '@/lib/i18n';
import type { SWorker } from './api';

export interface SheetRow { worker: string; date: string; inTime: string; outTime: string }

export async function parseTimesheetFile(file: File): Promise<SheetRow[]> {
  await loadScript(XLSX_URL);
  let buf: ArrayBuffer;
  try { buf = await file.arrayBuffer(); } catch { throw new Error(tr('Could not read the file')); }
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/["'׳״.]/g, ''));
  const col = (names: string[]) => head.findIndex(h => names.includes(h));
  const di = col(['date', 'תאריך']), ii = col(['in', 'start', 'כניסה']), oi = col(['out', 'end', 'יציאה']), wi = col(['worker', 'name', 'id', 'עובד', 'שם', 'תז']);
  if (di < 0) throw new Error(tr('No Date column (expected Date, In, Out)'));
  const p2 = (n: string | number) => String(n).padStart(2, '0');
  const day = (v: unknown) => {
    if (v instanceof Date) return v.getFullYear() + '-' + p2(v.getMonth() + 1) + '-' + p2(v.getDate());
    const t = String(v || '').trim();
    let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) return m[3] + '-' + p2(m[2]) + '-' + p2(m[1]);
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);
    return '';
  };
  const time = (v: unknown) => {
    if (v instanceof Date) return p2(v.getHours()) + ':' + p2(v.getMinutes());
    if (typeof v === 'number' && v >= 0 && v < 1) { const mins = Math.round(v * 1440); return p2(Math.floor(mins / 60) % 24) + ':' + p2(mins % 60); }
    const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})/);
    return m ? p2(m[1]) + ':' + m[2] : '';
  };
  return rows.slice(1).filter(r => String(r[di] ?? '').trim() !== '').map(r => ({
    worker: wi >= 0 ? String(r[wi] || '').trim() : '', date: day(r[di]),
    inTime: ii >= 0 ? time(r[ii]) : '', outTime: oi >= 0 ? time(r[oi]) : '',
  }));
}

/** Does a sheet's Worker cell name this worker (its name, or its ID number)? An empty cell does. */
export function timesheetRowIsFor(cell: string, w: SWorker): boolean {
  if (!cell) return true;
  const norm = (v: unknown) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const c = norm(cell);
  return c === norm(w.name) || (!!w.docId && c === norm(w.docId)) || c === norm((w.docGiven || '') + (w.docSurname || ''));
}
