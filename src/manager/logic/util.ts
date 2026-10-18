// Small helpers of the manager app (from schedule-manager.html).
export { esc } from '../../lib/utils';

// SheetJS (Excel read and write, ~900 KB) is loaded only when an Excel
// export or import needs it, not with the page.
let xlsxLoading: Promise<void> | null = null;
export function loadXlsx(): Promise<void> {
  if (typeof (window as unknown as {XLSX?: unknown}).XLSX !== 'undefined') return Promise.resolve();
  return xlsxLoading || (xlsxLoading = new Promise<void>((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    sc.onload = () => res();
    sc.onerror = () => { xlsxLoading = null; sc.remove(); rej(new Error('Excel library not loaded')); };
    document.head.appendChild(sc);
  }));
}

export function getSundayOfWeek(d: Date): Date { const c = new Date(d); c.setDate(c.getDate() - c.getDay()); c.setHours(0,0,0,0); return c; }
export function toMins(t: string | null | undefined): number | null { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
/** A shift's hours; one that ends at or before its start crosses midnight. */
export function calcHours(s: string | null | undefined, e: string | null | undefined): number {
  if (!s || !e) return 0;
  const sm = toMins(s)!, em = toMins(e)!;
  return em <= sm ? (1440 - sm + em) / 60 : (em - sm) / 60;
}
// Formats a stored 'YYYY-MM-DD' date string (e.g. w.startDate) as
// 'DD/MM/YYYY' for display; anything else is left as it is.
export { fmtDMY } from '../worker';
