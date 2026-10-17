// The client's signed month (docs/hours-review.md → Signing the month): the
// month's days drawn as A4 pages (150 dpi JPEG images) with the signature on
// the last one; the `hours` function's `sign` wraps them into one PDF and
// stores it with the client's documents. Only what the screen shows a client:
// its workers' names, the days, the shifts, the hours and each day's state —
// never pay, rates, suppliers, GPS, files or tokens.
import { tr, uiLocale } from '@/lib/i18n';
import { dayState, monthStart, STATES, type DayRow, type HoursData } from './hours';

const W = 1240, H = 1754, M = 90, ROW = 36;
const FONT = 'Heebo, "Segoe UI", Arial, sans-serif';
const SIG_H = 330; // the signature block at the end

function img(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
}

/** The pages as base64 JPEGs (no data: prefix), the signature drawn on the last one. */
export async function signedMonthPages(data: HoursData, days: DayRow[], signature: string, signer: string, at = new Date()): Promise<string[]> {
  const sig = await img(signature);
  const name = (id: string) => (data.workers || []).find(w => w.id === id)?.name || '';
  const owner = data.owner ? [data.owner.name, data.owner.object].filter(Boolean).join(' · ') : '';
  const month = monthStart(data.month).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
  const total = days.reduce((t, r) => t + r.hours, 0);
  const cols = [M, M + 240, M + 580, M + 800, M + 910]; // date, worker, shifts, hours, state
  const pages: string[] = [];
  let c = document.createElement('canvas'), g = c.getContext('2d')!, y = 0;

  const text = (s: string, x: number, yy: number, size = 22, weight = 400, color = '#10213a', max?: number) => {
    g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color;
    g.fillText(s, x, yy, max);
  };
  const line = (yy: number, color = '#c9d3e0') => { g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); g.moveTo(M, yy); g.lineTo(W - M, yy); g.stroke(); };
  const finish = () => {
    text(tr('Page {n}', { n: pages.length + 1 }), W - M - 90, H - 50, 18, 400, '#6b7a90');
    pages.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
  };
  const newPage = () => {
    c = document.createElement('canvas'); c.width = W; c.height = H;
    g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.textBaseline = 'alphabetic';
    text(tr('Monthly hours'), M, M + 20, 34, 700);
    text(month, M, M + 64, 24, 600, '#33445c');
    if (owner) text(owner, M, M + 100, 22, 400, '#33445c');
    y = M + 150;
    [tr('Date'), tr('Worker'), tr('Shifts'), tr('Hours'), tr('Status')].forEach((h, i) => text(h, cols[i], y, 19, 700, '#6b7a90'));
    y += 14; line(y, '#10213a'); y += ROW;
  };

  newPage();
  for (const r of days) {
    if (y > H - M - 60) { finish(); newPage(); }
    const st = STATES[dayState(data, r).st];
    text(r.date.toLocaleDateString(uiLocale(), { weekday: 'short', day: '2-digit', month: 'short' }), cols[0], y, 21);
    text(name(r.workerId), cols[1], y, 21, 600, '#10213a', 330);
    text(r.shifts.map(s => (s.inT || '--:--') + '–' + (s.outT || '--:--')).join(', '), cols[2], y, 21, 400, '#10213a', 210);
    text(r.hours.toFixed(2), cols[3], y, 21);
    text(tr(st.pill), cols[4], y, 19, 600, '#33445c', W - M - cols[4]);
    line(y + 12);
    y += ROW;
  }
  if (y > H - M - 60 - SIG_H) { finish(); newPage(); }
  y += 10;
  text(tr('Total: {h}h', { h: total.toFixed(2) }) + ' · ' + tr('{n} days', { n: days.length }), M, y, 24, 700);
  y += 60;
  text(tr('I approve the hours of this month.'), M, y, 22);
  y += 20;
  const sh = 160, sw = Math.min(520, sig.width * (sh / sig.height));
  g.drawImage(sig, M, y, sw, sh);
  y += sh + 8; g.strokeStyle = '#10213a'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(M, y); g.lineTo(M + 520, y); g.stroke();
  y += 34;
  text(tr('Signed by {name}', { name: signer }) + ' · ' + at.toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }), M, y, 20, 400, '#33445c');
  finish();
  return pages;
}
