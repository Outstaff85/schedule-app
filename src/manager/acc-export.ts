// The Accounting exports (docs/accounting.md → Exports), moved from the page in
// stage 6e: they write the tables accounting.ts builds — never a second
// calculation. Excel through SheetJS (the page's loadXlsx), PDF as a print page
// in a new window, CSV as a download.
import { localYMD } from '@/lib/payroll';
import { esc } from '@/lib/utils';
import { tr, uiLocale } from '@/lib/i18n';
import type { ManagerBridge } from './bridge';
import { accountantSheets, payableAoa, periodLabel, salaryExportAoa, salaryMonthOf, type ApprovalDoc } from './accounting';

const PRINT_CSS = 'body{font-family:Arial,sans-serif;padding:20px;color:#111}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}th{background:#f0f0f0}tfoot td{font-weight:bold}';

/** A print page in a new window (the old pages' PDF). */
function printPage(api: ManagerBridge, title: string, html: string): boolean {
  const win = window.open('', '_blank');
  if (!win) { api.toast(tr('Pop-up blocked — allow pop-ups to export PDF')); return false; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><h2>${esc(title)}</h2>${html}</body></html>`);
  win.document.close(); setTimeout(() => win.print(), 400);
  return true;
}
const fileTag = (period: string) => (period.startsWith('m:') ? period.slice(2) : period + '-' + localYMD(new Date()));

async function book(api: ManagerBridge, sheets: [string, (string | number)[][]][], file: string): Promise<boolean> {
  const X = await api.xlsx();
  if (!X) { api.toast(tr('Excel library not loaded')); return false; }
  const wb = X.utils.book_new();
  sheets.forEach(([name, aoa]) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), name));
  X.writeFile(wb, file);
  return true;
}

/** The salary export of a period (`onlyIds`: the ticked workers): Excel, PDF or CSV — one row per shift. */
export async function exportSalary(api: ManagerBridge, format: 'excel' | 'pdf' | 'csv', period: string, onlyIds?: string[] | null): Promise<void> {
  const aoa = salaryExportAoa(api.accData(), period, onlyIds);
  const fname = 'salary-' + fileTag(period);
  if (format === 'excel') { if (!await book(api, [[tr('Salary'), aoa]], fname + '.xlsx')) return; }
  else if (format === 'pdf') {
    const [head, ...rest] = aoa, rows = rest.slice(0, -1), tot = rest[rest.length - 1];
    const title = tr('Salary — {period}', { period: periodLabel(period, tr, uiLocale()) });
    if (!printPage(api, title, `<table style="font-size:12px"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => '<tr>' + r.map(v => `<td>${esc(String(v))}</td>`).join('') + '</tr>').join('')}</tbody>
      <tfoot><tr><td colspan="6">${esc(tr('Total'))}</td><td>${esc(tot[6])}</td><td></td><td>${esc(tot[8])}</td><td></td></tr></tfoot></table>`)) return;
  } else {
    const csv = aoa.slice(0, -1).map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = fname + '.csv'; a.click(); URL.revokeObjectURL(url);
  }
  api.toast(tr('Salary exported!'));
}

/** The accountant's workbook for a period: Summary, Shifts and, for a month, Hours approvals (read afresh). */
export async function exportAccountant(api: ManagerBridge, period: string, firmName: string): Promise<void> {
  const month = salaryMonthOf(period);
  let approvals: ApprovalDoc[] | null = null;
  if (month) { try { approvals = await api.hourApprovals(month, true); } catch { approvals = null; } }
  const s = accountantSheets(api.accData(), period, approvals, firmName, uiLocale());
  const sheets: [string, (string | number)[][]][] = [[tr('Summary'), s.summary], [tr('Shifts'), s.shifts]];
  if (s.approvals) sheets.push([tr('Hours approvals'), s.approvals]);
  if (!await book(api, sheets, 'accountant-' + fileTag(period) + '.xlsx')) return;
  api.toast(tr('Accountant report exported'));
}

/** A summary the tab already computed ({label, hours, rate, total}) to Excel or PDF. */
export async function exportPayable(api: ManagerBridge, rows: { label: string; hours: number; rate: string; total: number }[], title: string, filename: string, format: 'excel' | 'pdf'): Promise<void> {
  const aoa = payableAoa(rows, tr);
  if (format === 'excel') { if (!await book(api, [[tr('Summary'), aoa]], filename + '.xlsx')) return; }
  else {
    const [head, ...rest] = aoa, body = rest.slice(0, -1), tot = rest[rest.length - 1];
    if (!printPage(api, title, `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${body.map(r => `<tr>${r.map(v => `<td>${esc(String(v))}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">${esc(tr('Total'))}</td><td>${esc(tot[3])}</td></tr></tfoot></table>`)) return;
  }
  api.toast(tr('Summary exported'));
}
