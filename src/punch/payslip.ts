// The month's pay estimate as a printable page (stage 5b, docs/punch.md → My
// hours): "Download for the month" on the Pay card opens it in a new window
// and the phone's print sheet saves it as a PDF — the same way the manager
// app's PDF exports work. Every figure comes from myMonthFigures (the one
// payroll copy, src/lib/payroll.ts), exactly what the Pay card shows; no
// second calculation. Marked as an estimate before deductions.
import { tr, uiLocale } from '@/lib/i18n';
import { esc } from '@/lib/utils';
import { histSite } from './core';
import { money, type MonthFigures } from './figures';

export function payslipHtml(f: MonthFigures, key: string, name: string): string {
  const [y, m] = key.split('-').map(Number), loc = uiLocale();
  const month = new Date(y, m - 1, 1).toLocaleDateString(loc, { month: 'long', year: 'numeric' });
  const showPay = f.ov == null;
  const rows = f.shifts.filter(sh => sh.h > 0).map(sh => {
    const site = sh.entries.map(histSite).find(Boolean) || '';
    return `<tr><td>${esc(sh.date.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'numeric' }))}</td>`
      + `<td dir="auto">${esc(site)}</td><td>${esc((sh.inT || '--:--') + ' – ' + (sh.outT || '--:--'))}</td>`
      + `<td>${sh.h.toFixed(2)}</td>${showPay ? `<td>${esc(money(sh.pay))}</td>` : ''}</tr>`;
  }).join('');
  const line = (l: string, v: string, cls = '') => `<tr class="${cls}"><td>${esc(l)}</td><td>${esc(v)}</td></tr>`;
  const sums = [
    line(tr('Days worked'), String(f.days)),
    line(tr('Hours worked'), f.hours.toFixed(2)),
    line(tr('Regular {h}h', { h: f.regH.toFixed(1) }), ''),
    f.otH > 0 ? line(tr('Overtime {h}h', { h: f.otH.toFixed(1) }), '') : '',
    f.shabH > 0 ? line(tr('Shabbat {h}h', { h: f.shabH.toFixed(1) }), '') : '',
    line(tr('Total'), money(f.total), 'tot'),
    f.travel > 0 ? line(tr('Total with travel ({t})', { t: money(f.travel) }), money(f.total + f.travel)) : '',
  ].join('');
  const title = tr('Pay estimate') + ' — ' + month;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;padding:20px;color:#111;max-width:760px;margin:0 auto}h2{margin:0 0 4px}p{margin:0 0 14px;color:#555}
table{width:100%;border-collapse:collapse;margin-bottom:16px}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}th{background:#f0f0f0}
.sum td:last-child{text-align:right;width:40%}.tot td{font-weight:bold;background:#f6f6f6}.note{font-size:12px;color:#666}</style></head>
<body><h2>${esc(title)}</h2><p dir="auto">${esc(name)}</p>
<table><thead><tr>${[tr('Date'), tr('Site'), tr('In – out'), tr('Hours')].map(h => `<th>${esc(h)}</th>`).join('')}${showPay ? `<th>${esc(tr('Pay'))}</th>` : ''}</tr></thead><tbody>${rows}</tbody></table>
<table class="sum" id="payslipSum" data-total="${f.total.toFixed(2)}"><tbody>${sums}</tbody></table>
<div class="note">${esc(tr('An estimate before deductions — your payslip is the final figure.'))}</div></body></html>`;
}

/** Opens the month's estimate in a new window and the print sheet (Save as PDF). */
export function openPayslip(f: MonthFigures, key: string, name: string) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(payslipHtml(f, key, name));
  win.document.close();
  window.setTimeout(() => { try { win.print(); } catch { /* closed */ } }, 400);
}
