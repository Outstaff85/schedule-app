// My Hours (docs/portals.md): a month (this one and the 11 before it);
// with "sees pay" the month's pay per own worker (a Data Table; plates on a
// phone); the Detail and Summary exports (Excel or a print page); sending
// shifts for the firm owner's approval (typed rows or a timesheet file) and
// the batches already sent with their status.
import * as React from 'react';
import { toast } from 'sonner';
import { IconCircleCheck, IconCircleX, IconClock, IconFileSpreadsheet, IconFileTypePdf, IconPlus, IconSend, IconTrash } from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { esc, cn } from '@/lib/utils';
import { loadScript, XLSX_URL } from '@/lib/backend';
import { isDailyPay, localYMD } from '@/lib/payroll';
import { Figures, Section } from '@/components/shared/section';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SENT_KEY, queryClient, supplierCall, useSentHours, useSupplierData, type HoursBatch, type SupplierData, type SWorker } from './api';
import { payRows, summaryRows, workerMonthShifts, type PayRow } from './money';
import { parseTimesheetFile, timesheetRowIsFor } from './timesheet';
import { getUi, setUi, useUi } from './store';

const monthOf = (i: number) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() - i, 1); };
const h1 = (h: number) => tr('{h}h', { h: h.toFixed(1) });

export function Hours() {
  const { d } = useSupplierData();
  const ui = useUi();
  const m = monthOf(ui.month), year = m.getFullYear(), month = m.getMonth();
  return (
    <div data-testid="hours" className="grid gap-4">
      <div className="grid max-w-80 gap-1.5">
        <Label htmlFor="hoursMonth">{tr('Month')}</Label>
        <Select value={String(ui.month)} onValueChange={v => setUi({ month: Number(v) })}>
          <SelectTrigger id="hoursMonth" data-testid="hours-month-pick"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Array.from({ length: 12 }, (_, i) => <SelectItem key={i} value={String(i)}>{monthOf(i).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {d.showPay && <PayTable d={d} year={year} month={month} />}
      <Exports d={d} year={year} month={month} />
      <SendHours d={d} />
      <SentHours d={d} />
    </div>
  );
}

// ── The month's pay (only with "sees pay"): hours, days, the worker's rate, pay, my commission ──
function PayTable({ d, year, month }: { d: SupplierData; year: number; month: number }) {
  const rows = React.useMemo(() => payRows(d, year, month), [d, year, month]);
  const tot = (k: 'hours' | 'pay' | 'commission' | 'days') => rows.reduce((t, r) => t + r[k], 0);
  const columns = React.useMemo<DataColumn<PayRow>[]>(() => [
    { id: 'worker', header: tr('Worker'), accessorFn: r => r.w.name, sortFn: 'alphanumeric' },
    { id: 'hours', header: tr('Hours'), accessorFn: r => r.hours, cell: c => c.row.original.hours.toFixed(1), meta: { num: true } },
    { id: 'days', header: tr('Days'), accessorFn: r => r.days, meta: { num: true } },
    { id: 'rate', header: tr('Rate'), accessorFn: r => r.rate, enableSorting: false, meta: { num: true } },
    { id: 'pay', header: tr('Pay'), accessorFn: r => r.pay, cell: c => '₪' + c.row.original.pay.toFixed(0), meta: { num: true } },
    { id: 'commission', header: tr('My commission'), accessorFn: r => r.commission, cell: c => <span className="text-ok">₪{c.row.original.commission.toFixed(0)}</span>, meta: { num: true } },
  ], []);
  return (
    <Section label={tr('Pay')} count={rows.length}>
      <div data-testid="pay-table">
        {!rows.length ? <div className="text-sm text-faint">{tr('No hours this month')}</div> : (
          <>
            <Figures items={[
              { key: 'hours', label: tr('Hours'), value: h1(tot('hours')) },
              { key: 'pay', label: tr('Pay'), value: '₪' + tot('pay').toFixed(0) },
              { key: 'commission', label: tr('My commission'), value: '₪' + tot('commission').toFixed(0), color: 'var(--green)' },
            ]} />
            <DataTable
              columns={columns}
              data={rows}
              rowId={r => r.w.id}
              footer={[tr('Total'), tot('hours').toFixed(1), String(tot('days')), '', '₪' + tot('pay').toFixed(0), '₪' + tot('commission').toFixed(0)]}
              card={r => (
                <Plate key={r.w.id} data-pay-row={r.w.id} title={r.w.name}
                  sub={h1(r.hours) + ' · ' + (r.days === 1 ? tr('1 day') : tr('{n} days', { n: r.days })) + ' · ' + r.rate + ' · ' + tr('Pay') + ' ₪' + r.pay.toFixed(0)}
                  right={<b className="text-ok">₪{r.commission.toFixed(0)}</b>} />
              )}
            />
          </>
        )}
      </div>
    </Section>
  );
}

// ── Exports ──
function printPage(title: string, heading: string, head: string[], rows: (string | number)[][]) {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title>
    <style>body{font-family:Arial,sans-serif;padding:20px;color:#111}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 10px}th{background:#f0f0f0}</style>
    </head><body><h2>${esc(heading)}</h2>
    <table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html); win.document.close(); setTimeout(() => win.print(), 400);
}
async function xlsx(): Promise<boolean> {
  try { await loadScript(XLSX_URL); return true; } catch { toast.error(tr('Excel library not loaded')); return false; }
}
function writeBook(aoa: unknown[][], sheet: string, file: string) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  XLSX.writeFile(wb, file);
}

/** Detail: the worker's shifts that month — Date / In / Out / Hours and the total. */
async function exportDetail(d: SupplierData, workerId: string, year: number, month: number, format: 'excel' | 'pdf') {
  const w = d.workers.find(x => x.id === workerId);
  if (!w) { toast.error(tr('Pick a worker first')); return; }
  const shifts = workerMonthShifts(d.punches, workerId, year, month);
  const total = shifts.reduce((s, x) => s + x.hours, 0);
  const rows = shifts.map(s => [s.date.toLocaleDateString('en-GB'), s.inTime, s.outTime, s.hours.toFixed(2)]);
  if (format === 'excel') {
    if (!(await xlsx())) return;
    writeBook([['Date', 'In', 'Out', 'Hours'].map(h => tr(h)), ...rows, ['', '', tr('Total'), total.toFixed(2)]], tr('Hours'),
      'hours-' + w.name.replace(/\s+/g, '_') + '-' + year + '-' + String(month + 1).padStart(2, '0') + '.xlsx');
  } else {
    const label = new Date(year, month, 1).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
    printPage(tr('Hours') + ' — ' + w.name, w.name + ' — ' + label, [tr('Date'), tr('In'), tr('Out'), tr('Hours')], rows);
  }
  toast.success(tr('Hours exported'));
}
/** Summary: per worker with hours that month, its commission and rate. */
async function exportSummary(d: SupplierData, year: number, month: number, format: 'excel' | 'pdf') {
  const rows = summaryRows(d, year, month);
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const title = tr('My hours — payable summary');
  if (format === 'excel') {
    if (!(await xlsx())) return;
    writeBook([['Worker', 'Hours', 'Commission', 'Total'].map(h => tr(h)), ...rows.map(r => [r.label, r.hours.toFixed(2), r.rate, r.total.toFixed(2)]), ['', '', tr('Total'), grand.toFixed(2)]],
      tr('Summary'), 'my-hours-summary.xlsx');
  } else {
    printPage(title, title, [tr('Worker'), tr('Hours'), tr('Commission'), tr('Total')], rows.map(r => [r.label, r.hours.toFixed(2), r.rate, r.total.toFixed(2)]));
  }
  toast.success(tr('Summary exported'));
}

const workerOptions = (ws: SWorker[]) => ws.map(w => ({ value: w.id, label: w.name, hint: w.docId || undefined }));

function Exports({ d, year, month }: { d: SupplierData; year: number; month: number }) {
  const ui = useUi();
  const wid = ui.exportWorker || d.workers[0]?.id || '';
  return (
    <Section label={tr('Export')}>
      <div className="mb-2 grid max-w-80 gap-1.5">
        <Label htmlFor="exportWorker">{tr('Worker (for detailed export)')}</Label>
        <Combobox id="exportWorker" options={workerOptions(d.workers)} value={wid} onChange={v => setUi({ exportWorker: v })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void exportDetail(d, wid, year, month, 'excel')}><IconFileSpreadsheet className="size-[18px]" />{tr('Detail (Excel)')}</Button>
        <Button onClick={() => void exportDetail(d, wid, year, month, 'pdf')}><IconFileTypePdf className="size-[18px]" />{tr('Detail (PDF)')}</Button>
        <Button onClick={() => void exportSummary(d, year, month, 'excel')}><IconFileSpreadsheet className="size-[18px]" />{tr('Summary (Excel)')}</Button>
        <Button onClick={() => void exportSummary(d, year, month, 'pdf')}><IconFileTypePdf className="size-[18px]" />{tr('Summary (PDF)')}</Button>
      </div>
    </Section>
  );
}

// ── Send hours for approval (supplierSubmitHours → one pending batch for the owner) ──
// A daily-paid worker (payMode, sent with "sees pay") needs only a date: empty
// times count as one day, 08:00–16:00 — the same as the manager app.
const MANUAL_DAY_SHIFT = ['08:00', '16:00'];

/** A new row takes the day after the last row (today for the first one). */
export function addSendRow() {
  const rows = getUi().sendRows, last = rows.length && rows[rows.length - 1].date;
  let date = localYMD(new Date());
  if (last) { const x = new Date(last + 'T12:00'); x.setDate(x.getDate() + 1); date = localYMD(x); }
  setUi({ sendRows: [...rows, { date, inTime: '', outTime: '' }], badRows: [] });
}

function SendHours({ d }: { d: SupplierData }) {
  const ui = useUi();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const wid = ui.sendWorker || d.workers[0]?.id || '';
  const w = d.workers.find(x => x.id === wid);
  const daily = isDailyPay(w);
  const setRow = (i: number, p: Partial<{ date: string; inTime: string; outTime: string }>) =>
    setUi(s => ({ sendRows: s.sendRows.map((r, j) => (j === i ? { ...r, ...p } : r)), badRows: s.badRows.filter(b => b !== i) }));

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (!w) { toast.error(tr('Pick a worker first')); return; }
    let rows;
    try { rows = await parseTimesheetFile(file); } catch (e) { toast.error((e as Error).message || tr('Could not read the file'), { duration: 6000 }); return; }
    const mine = rows.filter(r => timesheetRowIsFor(r.worker, w)), others = rows.length - mine.length;
    if (!mine.length) {
      toast.error(others ? tr('No rows for {0} in this file ({1} row(s) of other workers)', { 0: w.name, 1: others }) : tr('No rows for {0} in this file', { 0: w.name }), { duration: 6000 });
      return;
    }
    setUi(s => ({ sendRows: [...s.sendRows, ...mine.map(r => ({ date: r.date, inTime: r.inTime, outTime: r.outTime }))], badRows: [] }));
    toast.success(others
      ? tr('{0} shift(s) loaded for {1} — check them and send; {2} row(s) of other workers: pick that worker and load the file again', { 0: mine.length, 1: w.name, 2: others })
      : tr('{0} shift(s) loaded for {1} — check them and send', { 0: mine.length, 1: w.name }), { duration: 7000 });
  };

  const submit = async () => {
    const rows = getUi().sendRows;
    if (!rows.length) { toast.error(tr('Add at least one shift')); return; }
    // A row that can't be sent is explained, never dropped silently.
    const bad = rows.map((r, i) => ((!r.date || (!daily && (!r.inTime || !r.outTime)) || (!!r.inTime !== !!r.outTime)) ? i : -1)).filter(i => i >= 0);
    if (bad.length) {
      setUi({ badRows: bad });
      const r = rows[bad[0]];
      toast.error(tr('Shift {0}: {1}', { 0: bad[0] + 1, 1: !r.date ? tr('pick a date') : !daily ? tr('enter the in and out times — this worker is paid by the hour') : tr('enter both times, or leave both empty for a whole day') }));
      return;
    }
    const entries = rows.map(r => {
      let inTime = r.inTime, outTime = r.outTime;
      if (!inTime && !outTime && daily) [inTime, outTime] = MANUAL_DAY_SHIFT;
      const [y, mo, dd] = r.date.split('-');
      return { date: dd + '/' + mo + '/' + y, inTime, outTime };
    });
    setBusy(true);
    try {
      const r = await supplierCall<{ count?: number }>({ action: 'supplierSubmitHours', workerId: wid, clientId: (w && w.clientIds || [])[0] || '', entries });
      if (r.error) { toast.error(r.error); return; }
      toast.success(tr('{0} shift(s) sent for review', { 0: r.count ?? entries.length }));
      setUi({ sendRows: [], badRows: [] });
      void queryClient.invalidateQueries({ queryKey: SENT_KEY });
    } catch (e) { toast.error(tr('Failed: {0}', { 0: (e as Error).message })); }
    finally { setBusy(false); }
  };

  return (
    <Section label={tr('Send hours for approval')}>
      <div data-testid="send-hours" className="grid gap-2">
        <div className="grid max-w-80 gap-1.5">
          <Label htmlFor="sendWorker">{tr('Worker')}</Label>
          <Combobox id="sendWorker" options={workerOptions(d.workers)} value={wid} onChange={v => setUi({ sendWorker: v, badRows: [] })} />
        </div>
        <p className="text-[11px] text-faint">{daily ? tr('Paid by the day: a date is enough — with no times it counts as one day (08:00–16:00).') : tr('Date, in and out for each shift.')}</p>
        {ui.sendRows.map((r, i) => (
          <div key={i} data-send-row={i} data-bad={ui.badRows.includes(i) ? '1' : undefined}
            className={cn('grid grid-cols-[1.4fr_1fr_1fr_auto] items-center gap-1.5 rounded-[14px]', ui.badRows.includes(i) && 'outline outline-1 outline-[var(--red)]')}>
            <DatePicker value={r.date} onChange={v => setRow(i, { date: v })} />
            <Input type="time" aria-label={tr('In')} title={tr('In')} value={r.inTime} onChange={e => setRow(i, { inTime: e.target.value })} />
            <Input type="time" aria-label={tr('Out')} title={tr('Out')} value={r.outTime} onChange={e => setRow(i, { outTime: e.target.value })} />
            <Button size="icon-sm" aria-label={tr('Remove')} title={tr('Remove')} onClick={() => setUi(s => ({ sendRows: s.sendRows.filter((_, j) => j !== i), badRows: [] }))}><IconTrash className="size-4" /></Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button onClick={addSendRow}><IconPlus className="size-[18px]" />{tr('Add shift')}</Button>
          <Button title={tr('Columns: Date, In, Out (and Worker — a name or ID number — for a sheet of several workers)')} onClick={() => fileRef.current?.click()}>
            <IconFileSpreadsheet className="size-[18px]" />{tr('Load from Excel')}
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden data-testid="timesheet-file"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void loadFile(f); }} />
          <Button variant="primary" disabled={busy} onClick={() => void submit()} data-testid="send-hours-btn"><IconSend className="size-[18px]" />{tr('Send for approval')}</Button>
        </div>
      </div>
    </Section>
  );
}

// ── Sent for approval: each batch with its status (amber sent, green approved, red rejected) ──
const status = () => ({
  pending: { label: tr('Sent for review'), variant: 'warn', color: 'var(--amber)', icon: <IconClock /> },
  approved: { label: tr('Approved'), variant: 'ok', color: 'var(--green)', icon: <IconCircleCheck /> },
  rejected: { label: tr('Rejected'), variant: 'bad', color: 'var(--red)', icon: <IconCircleX /> },
} as const);

function SentHours({ d }: { d: SupplierData }) {
  const q = useSentHours();
  const nameOf = (id?: string) => d.workers.find(w => w.id === id)?.name || '';
  const list: HoursBatch[] = q.data || [];
  return (
    <Section label={tr('Sent for approval')} count={q.data ? list.length : undefined}>
      <div data-testid="sent-hours">
        {q.isError ? <div className="text-xs text-faint">{tr('Could not load')}</div>
          : !q.data ? null
          : <PagedList items={list} empty={<div className="text-xs text-faint">{tr('Nothing sent yet')}</div>} render={(b, i) => {
            const rows = b.entries || [], all = status(), s = all[b.status || 'pending'] || all.pending;
            const when = b.status === 'pending' || !b.status ? b.uploadedAt : b.decidedAt;
            return (
              <Plate key={b.id || i} size="sm" color={s.color}
                title={tr('{0} · {1} shift(s): {2}{3}', { 0: nameOf(rows[0] && rows[0].workerId), 1: rows.length, 2: (rows[0] || {}).date || '', 3: rows.length > 1 ? ' – ' + rows[rows.length - 1].date : '' })}
                right={<Badge variant={s.variant} className="font-sans">{s.icon}{s.label}{when ? ' · ' + new Date(when).toLocaleDateString('en-GB') : ''}</Badge>} />
            );
          }} />}
      </div>
    </Section>
  );
}
