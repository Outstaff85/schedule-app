// The small windows around a worker (docs/workers.md), drawn in React into the
// page's overlays (stage 6c-2): the notices sheet, Add document, Upload hours
// and Export hours. They close like every window (a tap outside, a swipe down
// on a phone — the page's overlay) and go back to the window that opened them.
import * as React from 'react';
import { IconFileSpreadsheet, IconFileTypePdf, IconId, IconPlus, IconTrash, IconUpload } from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { FormSection } from '@/components/ui/form';
import { Plate } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import type { HoursBatch, HoursEntry, ManagerBridge, WorkerHead } from './bridge';
import { HoursStatusChip, TiIcon, WorkerHeadLine } from './worker-head';
import { WORKER_DOC_TYPES } from './worker';
import { isHoursDate } from './logic/dates';

function Title({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-lg font-bold text-ink" data-testid="window-title">{children}</div>;
}
function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className="mb-3 grid gap-1.5"><Label>{label}</Label>{children}</div>;
}

// ── The notices sheet: who, a plate per notice with its action, "Open worker card" ──
export function NoticesSheet({ wid, head, api }: { wid: string; head: WorkerHead; api: ManagerBridge }) {
  return (
    <div data-testid="notices-sheet" data-wid={wid}>
      <WorkerHeadLine head={head} />
      <Section label={tr('Notices')} count={head.notices.length}>
        {head.notices.length ? head.notices.map((n, i) => (
          <Plate key={i} data-testid="notice" className="mb-1.5" size="sm" color={n.lvl === 'red' ? 'var(--red)' : 'var(--amber)'} icon={<TiIcon name={n.icon} />}
            title={n.title} sub={n.detail}
            right={n.acts.length ? (
              <span className="flex gap-1">
                {n.acts.map(a => (
                  <Button key={a.label} size="sm" data-testid="notice-act" data-wa={a.wa || undefined} className={cn(a.wa && '!text-ok')} onClick={e => { e.stopPropagation(); a.run(); }}><TiIcon name={a.icon} className="size-4" />{a.label}</Button>
                ))}
              </span>
            ) : undefined} />
        )) : <div className="rounded-[14px] border border-dashed border-white/20 px-3 py-4 text-center text-sm text-ink-2">{tr('No notices')}</div>}
      </Section>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" data-testid="notices-open-card" onClick={() => { api.closeModal('noticesOverlay'); api.openCard(wid); }}><IconId className="size-[18px]" />{tr('Open worker card')}</Button>
      </div>
    </div>
  );
}

// ── Add document: type, an optional expiry, several files, uploaded in parallel ──
export function DocUpload({ wid, api }: { wid: string; api: ManagerBridge }) {
  const w = api.record(wid);
  const [type, setType] = React.useState('contract');
  const [expiry, setExpiry] = React.useState('');
  const [files, setFiles] = React.useState<File[]>([]);
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (!w) return null;
  const submit = async () => {
    if (!files.length) { setStatus(tr('Choose at least one file')); return; }
    setBusy(true);
    setStatus(tr('Preparing {0} file{1}…', { 0: files.length, 1: files.length > 1 ? 's' : '' }));
    try {
      const prepared = await Promise.all(files.map(f => api.fileForStorage(f)));
      const loaded = new Array(prepared.length).fill(0), totals = new Array(prepared.length).fill(0);
      const tick = () => { const t = totals.reduce((a, b) => a + b, 0); setStatus(tr('Uploading… {0}%', { 0: t ? Math.round(100 * loaded.reduce((a, b) => a + b, 0) / t) : 0 })); };
      const results = await Promise.all(prepared.map((f, i) => api.uploadWorkerFile(
        { action: 'saveWorkerFile', workerId: wid, fileBase64: f.b64, fileName: f.fileName, mimeType: f.mediaType },
        (l, t) => { loaded[i] = l; totals[i] = t; tick(); })));
      const failed = results.filter(r => !r || r.error);
      const now = new Date().toISOString();
      const added = results.map((r, i) => (r && r.ok ? { id: 'd' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6), type, name: prepared[i].fileName,
        fileId: r.id, url: r.url, mediaType: prepared[i].mediaType, uploadedAt: now, expiry } : null)).filter(Boolean) as NonNullable<Parameters<ManagerBridge['addDocs']>[1]>;
      if (added.length) api.addDocs(wid, added);
      if (failed.length) {
        const msg = tr('{0} file(s) failed: {1}', { 0: failed.length, 1: (failed[0] && failed[0].error) || 'network error' });
        api.reportError(msg, 'saveWorkerFile');
        // The files already uploaded are kept: Upload again sends only the failed ones.
        setFiles(files.filter((_, i) => !(results[i] && results[i].ok)));
        setStatus(msg + ' ' + tr('Upload again sends only the files that failed.')); setBusy(false); return;
      }
      api.closeModal('workerDocOverlay');
      api.toast(tr('{0} document{1} uploaded', { 0: added.length, 1: added.length > 1 ? 's' : '' }));
      api.openCard(wid);
    } catch (e) {
      setStatus(tr('Upload failed: {0}', { 0: (e as Error)?.message || String(e) })); setBusy(false);
    }
  };
  return (
    <div data-testid="doc-upload" data-wid={wid}>
      <Title>{tr('Add document — {0}', { 0: w.name || '' })}</Title>
      <Field label={tr('Type')}>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="wdType" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(WORKER_DOC_TYPES).map(([k, l]) => <SelectItem key={k} value={k}>{tr(l)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={tr('Expiry date (optional — reminder before it expires)')}><DatePicker id="wdExpiry" value={expiry} onChange={setExpiry} /></Field>
      <Field label={tr('Files (several at once is fine — PDF or photos)')}>
        <Input type="file" id="wdFiles" multiple accept="application/pdf,.pdf,image/*,.doc,.docx" className="h-auto py-2" onChange={e => setFiles([...(e.target.files || [])])} />
      </Field>
      <div id="wdStatus" className="mb-1.5 min-h-[1.2em] text-xs text-ink-2">{status}</div>
      <div className="flex justify-end">
        <Button variant="primary" id="wdSubmit" disabled={busy} onClick={submit}><IconUpload className="size-[18px]" />{tr('Upload')}</Button>
      </div>
    </div>
  );
}

// ── Upload hours: a file (spreadsheet, photos, PDF — every page read at once) and / or rows typed by hand,
// sent as one batch for the owner's approval; the batches already sent with their status ──
type Row = { date: string; inTime: string; outTime: string };
const MANUAL_DAY_SHIFT = ['08:00', '16:00'];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** A new row takes the day after the last row (today for the first one). */
export function nextManualDate(rows: Row[]) {
  const last = rows.length && rows[rows.length - 1].date;
  if (!last) return ymd(new Date());
  const d = new Date(last + 'T12:00'); d.setDate(d.getDate() + 1);
  return ymd(d);
}
/** Which typed rows can't be sent: no date, or (paid by the hour) no in / out, or only one of the two times. */
export function manualRowsProblem(rows: Row[], daily: boolean, name: string) {
  const bad = rows.map((r, i) => (!r.date || (!daily && (!r.inTime || !r.outTime)) || (!!r.inTime !== !!r.outTime) ? i : -1)).filter(i => i >= 0);
  if (!bad.length) return null;
  const r = rows[bad[0]];
  const why = !r.date ? tr('pick a date')
    : !daily ? tr('enter the in and out times — {0} is paid by the hour (dates only need "₪/day" in the pay window: worker card → Pay)', { 0: name || tr('this worker') })
      : tr('enter both times, or leave both empty for a whole day');
  return { rows: bad, text: tr('Shift {0}: {1}', { 0: bad[0] + 1, 1: why }) };
}
/** The typed rows ready to send, as {date: dd/MM/yyyy, inTime, outTime}; a daily worker's row with no times is one day, 08:00–16:00. */
export function manualEntries(rows: Row[], daily: boolean): HoursEntry[] {
  return rows.map(r => {
    if (!r.date) return null;
    let inTime = r.inTime, outTime = r.outTime;
    if (!inTime && !outTime && daily) [inTime, outTime] = MANUAL_DAY_SHIFT;
    if (!inTime || !outTime) return null;
    const [y, m, d] = r.date.split('-');
    return { date: d + '/' + m + '/' + y, inTime, outTime };
  }).filter(Boolean) as HoursEntry[];
}

function SentList({ wid, api, version }: { wid: string; api: ManagerBridge; version: number }) {
  const [batches, setBatches] = React.useState<(HoursBatch & { rows: HoursEntry[] })[] | null | 'error'>(null);
  React.useEffect(() => {
    let live = true;
    api.loadPendingHours().then(all => {
      if (!live) return;
      setBatches(all.map(b => ({ ...b, rows: (b.entries || []).filter(r => r.workerId === wid) })).filter(b => b.rows.length)
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))));
    }).catch(() => { if (live) setBatches('error'); });
    return () => { live = false; };
  }, [wid, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (batches === null) return <div className="text-xs text-ink-3">{tr('Loading…')}</div>;
  if (batches === 'error') return <div className="text-xs text-ink-3">{tr('Could not load')}</div>;
  if (!batches.length) return <div className="text-xs text-ink-3" data-testid="hours-sent-none">{tr('Nothing sent yet')}</div>;
  return (
    <div data-testid="hours-sent">
      <PagedList items={batches} render={b => (
        <div key={b.id} data-testid="hours-batch" className="mb-1.5 flex items-center justify-between gap-2 rounded-[12px] bg-white/[.05] px-3 py-1.5 text-xs">
          <span className="text-ink-2">{tr('{0} shift(s): {1}{2}{3}', { 0: b.rows.length, 1: b.rows[0].date, 2: b.rows.length > 1 ? ' – ' + b.rows[b.rows.length - 1].date : '', 3: b.fileName ? ' · ' + b.fileName : '' })}</span>
          <HoursStatusChip b={{ status: (b.status as 'pending') || 'pending', when: (b.status === 'pending' ? b.uploadedAt : b.decidedAt) || '' }} />
        </div>
      )} />
    </div>
  );
}

export function HoursImport({ wid, api }: { wid: string; api: ManagerBridge }) {
  const info = api.hoursInfo(wid);
  const [clientId, setClientId] = React.useState(() => info?.clients[0]?.id || '');
  const [entries, setEntries] = React.useState<HoursEntry[]>([]);
  const [fileName, setFileName] = React.useState('');
  const [reading, setReading] = React.useState('');
  const [rows, setRows] = React.useState<Row[]>([]);
  const [bad, setBad] = React.useState<number[]>([]);
  const [sent, setSent] = React.useState(0);
  const [fileKey, setFileKey] = React.useState(0);
  if (!info) return null;
  const isSheet = (f: File) => /\.(xlsx|xls|csv)$/i.test(f.name);
  // Every file at once; images and PDFs page by page (the shared upload helpers), every page read in parallel.
  const onFiles = async (list: FileList | null) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setEntries([]); setFileName(files.map(f => f.name).join(', '));
    setReading(files.some(f => !isSheet(f)) ? tr('Reading with AI…') : tr('Parsing spreadsheet…'));
    try {
      const perFile = await Promise.all(files.map(async f => {
        if (isSheet(f)) return api.parseHoursSheet(f);
        const pages = await api.filePages(f);
        return (await Promise.all(pages.map(pg => api.readHoursPage(pg)))).flat();
      }));
      const all = perFile.flat();
      setEntries(all); setReading('');
      if (!all.length) api.toast(tr('No shifts recognized in this file'));
    } catch (err) {
      api.toast(tr('Could not parse file: {0}', { 0: (err as Error)?.message || String(err) }));
      setReading('');
    }
  };
  // Shifts from the file whose date could not be read as a date: shown in red, nothing is sent.
  const badDates = entries.filter(en => !isHoursDate(en.date));
  const submit = async () => {
    if (badDates.length) { api.toast(tr('{0} shift(s) with a date that could not be read — fix the file and choose it again', { 0: badDates.length }), 6000); return; }
    const problem = manualRowsProblem(rows, info.daily, info.name);
    if (problem) { setBad(problem.rows); api.toast(problem.text, 6000); return; }
    setBad([]);
    const manual = manualEntries(rows, info.daily);
    if (!entries.length && !manual.length) return;
    const all = [...entries, ...manual].map(en => ({ workerId: wid, clientId, date: en.date, inTime: en.inTime, outTime: en.outTime || '' }));
    const name = [fileName, manual.length ? 'entered by hand' : ''].filter(Boolean).join(' + ');
    try {
      const r = await api.sendHours(all, name);
      if (r.error) { api.toast(r.error); return; }
      api.toast(tr('{0} shift(s) sent for review', { 0: r.count ?? all.length }));
      setEntries([]); setFileName(''); setRows([]); setFileKey(k => k + 1); setSent(n => n + 1);
    } catch (e) { api.toast(tr('Upload failed: {0}', { 0: (e as Error).message })); }
  };
  const setRow = (i: number, k: keyof Row, val: string) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: val } : r)));
  return (
    <div data-testid="hours-import" data-wid={wid}>
      <Title>{tr('Upload hours — {0}', { 0: info.name })}</Title>
      <Field label={tr('Client / object')}>
        <Select value={clientId} onValueChange={setClientId}>
          <SelectTrigger id="hoursImportClient" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{info.clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={tr('File (Excel: Date/In/Out columns, or a photo/scan of a timesheet)')}>
        <Input key={fileKey} type="file" id="hoursImportFile" multiple accept=".xlsx,.xls,.csv,image/*,application/pdf,.pdf" className="h-auto py-2" onChange={e => onFiles(e.target.files)} />
      </Field>
      <div id="hoursImportPreview" className="min-h-5 text-xs text-ink-3">
        {reading || (entries.length > 0 && <>
          <div className="mb-1 text-ink-2">{tr('{0} shift(s) found:', { 0: entries.length })}</div>
          {badDates.length > 0 && <div data-testid="hours-bad-dates" className="mb-1 text-[var(--red)]">{tr('{0} shift(s) with a date that could not be read — fix the file and choose it again', { 0: badDates.length })}</div>}
          {[...badDates, ...entries.filter(en => isHoursDate(en.date))].slice(0, 10).map((en, i) => (
            <div key={i} data-bad={!isHoursDate(en.date) || undefined} className={cn(!isHoursDate(en.date) && 'text-[var(--red)]')}>{en.date || '?'} · {en.inTime}{en.outTime ? '–' + en.outTime : ' ' + tr('(open)')}</div>
          ))}
          {entries.length > 10 && <div>{tr('…{0} more', { 0: entries.length - 10 })}</div>}
        </>)}
      </div>
      <FormSection className="flex items-center justify-between gap-2">{tr('Enter by hand')}
        <Button size="sm" data-testid="hours-add-row" onClick={() => setRows(rs => [...rs, { date: nextManualDate(rs), inTime: '', outTime: '' }])}><IconPlus className="size-4" />{tr('Add shift')}</Button>
      </FormSection>
      <div className="my-1.5 text-[11px] text-ink-3">{info.daily ? tr('Paid by the day: a date is enough — with no times it counts as one day (08:00–16:00).') : tr('Paid by the hour: date, in and out for each shift. (How a worker is paid is set in the pay window: worker card → Pay.)')}</div>
      <div id="hoursManualRows" className="mb-2 flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={i} data-row={i} data-date={r.date} data-bad={bad.includes(i) || undefined} className={cn('grid grid-cols-[1.4fr_1fr_1fr_auto] items-center gap-1.5 rounded-[12px]', bad.includes(i) && 'outline outline-1 outline-[var(--red)]')}>
            <DatePicker value={r.date} onChange={val => setRow(i, 'date', val)} />
            <Input type="time" value={r.inTime} title={tr('In')} onChange={e => setRow(i, 'inTime', e.target.value)} />
            <Input type="time" value={r.outTime} title={tr('Out')} onChange={e => setRow(i, 'outTime', e.target.value)} />
            <Button size="icon-sm" title={tr('Remove')} aria-label={tr('Remove')} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><IconTrash className="size-4" /></Button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" id="hoursImportSubmitBtn" disabled={!!reading || !(entries.length || rows.length)} onClick={submit}><IconUpload className="size-[18px]" />{tr('Upload for approval')}</Button>
      </div>
      <FormSection>{tr('Sent for approval')}</FormSection>
      <div id="hoursSentList" className="mt-2"><SentList wid={wid} api={api} version={sent} /></div>
    </div>
  );
}

// ── Export hours: a month of the last 12, Excel or PDF ──
export function HoursExport({ wid, api }: { wid: string; api: ManagerBridge }) {
  const months = React.useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1));
  }, []);
  const [pick, setPick] = React.useState(`${months[0].getFullYear()}-${months[0].getMonth()}`);
  const run = (format: 'excel' | 'pdf') => {
    const [y, m] = pick.split('-').map(Number);
    api.closeModal('hoursExportOverlay');
    void api.exportHours(wid, y, m, format);
  };
  return (
    <div data-testid="hours-export" data-wid={wid}>
      <Title>{tr('Export hours')}</Title>
      <Field label={tr('Month')}>
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger id="hoursExportMonth" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{months.map(d => <SelectItem key={d.getTime()} value={`${d.getFullYear()}-${d.getMonth()}`}>{d.toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="flex justify-end gap-2">
        <Button data-testid="hours-export-excel" onClick={() => run('excel')}><IconFileSpreadsheet className="size-[18px]" />Excel</Button>
        <Button variant="primary" data-testid="hours-export-pdf" onClick={() => run('pdf')}><IconFileTypePdf className="size-[18px]" />PDF</Button>
      </div>
    </div>
  );
}
