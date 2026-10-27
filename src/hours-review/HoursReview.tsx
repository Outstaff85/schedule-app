// The hours review screen in the new stack (docs/hours-review.md): one screen
// for a client (now), a supplier and an HR login (when their pages move) — the
// month's shifts of the login's own workers; a day approved, disputed (with a
// comment) or given a proposed fix (applied only when a manager accepts it in
// Accounting → Approvals); several days or the whole month approved at once;
// the planned schedule and an Excel export — each by its tick (claim hp); a
// client signs the approved month with a finger (`sign`, a PDF kept with its
// documents). The
// data comes only from the `hours` function (`call`); this screen never reads
// Firestore. (It replaced the old pages' hours-review.js, now removed.)
import * as React from 'react';
import { IconAlertTriangle, IconCheck, IconChecks, IconChevronLeft, IconChevronRight, IconCircleCheck, IconClock, IconFileSpreadsheet, IconPencil, IconSignature } from '@tabler/icons-react';
import { toast } from 'sonner';
import { tr, uiLocale } from '@/lib/i18n';
import { loadScript, XLSX_URL } from '@/lib/backend';
import { localYMD } from '@/lib/payroll';
import { cn } from '@/lib/utils';
import { Figures, Section } from '@/components/shared/section';
import { Plate, type PlateAction } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { Window } from '@/components/shared/window';
import { SignaturePad, type SignaturePadHandle } from '@/components/shared/signature-pad';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldRow } from '@/components/ui/form';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import {
  can, dayState, monthDays, monthKey, monthStart, PICKABLE, planned, shiftsText, STATES,
  type DayRow, type HoursCall, type HoursData,
} from './hours';
import { signedMonthPages } from './signed-pdf';

// ── The screen's state, outside React: a language change redraws the page
// from scratch (I18nProvider), the loaded month stays.
type St = { month: number; tab: 'hours' | 'schedule'; data: HoursData | null; loading: boolean };
let st: St = { month: 0, tab: 'hours', data: null, loading: false };
const subs = new Set<() => void>();
const set = (p: Partial<St>) => { st = { ...st, ...p }; subs.forEach(f => f()); };
const useSt = () => React.useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb); }; }, () => st);
let callRef: HoursCall | null = null;
let signRef: SignOpts | undefined;
let busy = false;
/** A client's page passes `sign`: the approved month is signed with a finger (the signer's name goes into the PDF). */
export type SignOpts = { signer: string };

async function reload() {
  const key = monthKey(st.month);
  set({ loading: true });
  try {
    const r = await callRef!({ action: 'load', month: key });
    if (r.error) { toast.error(r.error); return; }
    if (key === monthKey(st.month)) set({ data: r });
  } catch {
    toast.error(tr('Could not load — check the connection and try again.'));
  } finally { set({ loading: false }); }
}
/** Reload the month (after a manager's answer, from outside the screen). */
export const hoursReviewReload = reload;
/** Whose hours these are (the client or supplier and its object), for the page's header. */
export const useHoursOwner = () => useSt().data?.owner;

async function send(body: Record<string, unknown>, okText: string): Promise<boolean> {
  if (busy || !st.data) return false;
  busy = true;
  try {
    const r = await callRef!({ month: st.data.month, ...body });
    if (r.error) { toast.error(r.error); return false; }
    set({ data: { ...st.data, days: r.days || {} } });
    toast.success(okText);
    return true;
  } catch {
    toast.error(tr('Could not save — check the connection and try again.'));
    return false;
  } finally { busy = false; }
}
/** Every day of the month approved (or its fix accepted) — the month can be signed. */
const allDone = (d: HoursData) => { const ds = monthDays(d); return ds.length > 0 && ds.every(r => ['approved', 'fixed'].includes(dayState(d, r).st)); };

const dayLabel = (d: Date, long = false) => d.toLocaleDateString(uiLocale(), long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: '2-digit', month: 'short' });
const hrs = (h: number) => tr('{h}h', { h: h.toFixed(1) });

export function HoursReview({ call, hideOwner, sign }: { call: HoursCall; hideOwner?: boolean; sign?: SignOpts }) {
  callRef = call;
  signRef = sign;
  const s = useSt();
  const d = s.data;
  const key = monthKey(s.month);
  React.useEffect(() => { if (!st.data || st.data.month !== monthKey(st.month)) void reload(); }, [s.month]);

  const showHours = !d || can(d, 'hours'), showSched = !!d && can(d, 'schedule');
  const tab = !showHours ? 'schedule' : !showSched ? 'hours' : s.tab;
  const owner = d && d.owner ? [d.owner.name, d.owner.object].filter(Boolean).join(' · ') : '';
  const ready = !!d && d.month === key;

  return (
    <div data-testid="hours-review" data-month={key} data-ready={ready && !s.loading ? '1' : '0'}>
      {showHours && showSched && (
        <Tabs value={tab} onValueChange={v => set({ tab: v as St['tab'] })} className="mb-2.5">
          <TabsList>
            <TabsTrigger value="hours">{tr('Hours')}</TabsTrigger>
            <TabsTrigger value="schedule">{tr('Schedule')}</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      <div className="mb-2 flex items-center gap-2">
        <Button size="icon" aria-label={tr('Previous month')} onClick={() => set({ month: s.month - 1 })}><IconChevronLeft className="size-5" /></Button>
        <div className="flex-1 text-center text-base font-bold capitalize" data-testid="hours-month">
          {monthStart(key).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' })}
        </div>
        <Button size="icon" aria-label={tr('Next month')} disabled={s.month >= 0} onClick={() => set({ month: Math.min(0, s.month + 1) })}><IconChevronRight className="size-5" /></Button>
      </div>
      {owner && !hideOwner && <div className="mb-2.5 text-center text-xs text-ink-2">{owner}</div>}
      {!ready
        ? <Msg>{s.loading || !d ? <><Spinner className="mr-2 inline size-4 align-[-3px]" />{tr('Loading…')}</> : ''}</Msg>
        : tab === 'hours' ? <HoursTab data={d!} /> : <ScheduleTab data={d!} />}
    </div>
  );
}

function Msg({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-faint">{children}</div>;
}

function HoursTab({ data }: { data: HoursData }) {
  const days = React.useMemo(() => monthDays(data), [data]);
  const state = (r: DayRow) => dayState(data, r);
  const pickable = days.filter(r => PICKABLE.includes(state(r).st));
  const pickJoined = pickable.map(r => r.key).join('\n');
  const pickKeys = React.useMemo(() => (pickJoined ? pickJoined.split('\n') : []), [pickJoined]);
  const sel = useSelection(pickKeys);
  const [win, setWin] = React.useState<{ kind: 'dispute' | 'fix'; row: DayRow } | null>(null);
  const [confirmMonth, setConfirmMonth] = React.useState(false);
  const [signing, setSigning] = React.useState(false);
  const canSign = !!signRef && can(data, 'approve');
  const name = (id: string) => (data.workers || []).find(w => w.id === id)?.name || '';

  if (!days.length) return <Msg>{tr('No hours this month')}</Msg>;
  const counts: Record<string, number> = {};
  days.forEach(r => { const k = state(r).st; counts[k] = (counts[k] || 0) + 1; });
  const done = (counts.approved || 0) + (counts.fixed || 0), open = days.length - done;
  const warn = (counts.changed || 0) + (counts.disputed || 0) + (counts.fix || 0) + (counts.rejected || 0);
  const stText = !open ? tr('Every day approved')
    : tr('{done} of {n} days approved', { done, n: days.length })
      + (counts.changed ? ' · ' + tr('{n} changed after approval', { n: counts.changed }) : '')
      + (counts.disputed ? ' · ' + tr('{n} disputed', { n: counts.disputed }) : '')
      + (counts.fix ? ' · ' + tr('{n} fixes waiting', { n: counts.fix }) : '');
  const total = days.reduce((t, r) => t + r.hours, 0);
  const byW: Record<string, DayRow[]> = {};
  days.forEach(r => { (byW[r.workerId] = byW[r.workerId] || []).push(r); });
  const wids = Object.keys(byW).sort((a, b) => name(a).localeCompare(name(b)));
  const stColor = !open ? 'var(--green)' : warn ? 'var(--amber)' : 'var(--ink-2)';

  const approveSelected = async () => {
    const lines = pickable.filter(r => sel.picked.has(r.key)).map(r => r.line);
    sel.end();
    if (lines.length) await send({ action: 'approve', lines }, lines.length === 1 ? tr('Day approved') : tr('{n} days approved', { n: lines.length }));
  };
  const fig = (n: number, label: string, color: string) => ({ key: label, label: tr(label), value: n, color: n ? color : 'var(--ink-3)' });

  return (
    <>
      <Figures items={[
        fig(done, 'Approved', 'var(--green)'),
        fig(counts.pending || 0, 'Waiting for approval', 'var(--ink)'),
        fig((counts.disputed || 0) + (counts.changed || 0), 'Disputed', 'var(--amber)'),
        fig(counts.fix || 0, 'Fix proposed', 'var(--accent)'),
      ]} />
      <div data-testid="hours-status" className="og-plate mb-2 flex-wrap justify-between !py-2.5 text-[13px]" style={{ ['--bar' as string]: stColor, color: stColor }}>
        <span className="flex items-center gap-2">
          {!open ? <IconCircleCheck className="size-4" /> : warn ? <IconAlertTriangle className="size-4" /> : <IconClock className="size-4" />}{stText}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {can(data, 'export') && <Button size="sm" onClick={() => void exportXlsx(data, days)}><IconFileSpreadsheet className="size-4" />{tr('Export')}</Button>}
          {can(data, 'approve') && pickable.length > 0 && <Button size="sm" variant="primary" data-testid="approve-month" onClick={() => setConfirmMonth(true)}><IconChecks className="size-4" />{tr('Approve the month')}</Button>}
          {canSign && !open && <Button size="sm" variant={data.signed ? 'default' : 'primary'} data-testid="sign-month" onClick={() => setSigning(true)}><IconSignature className="size-4" />{data.signed ? tr('Sign again') : tr('Sign the month')}</Button>}
        </span>
        {canSign && data.signed && data.signed.at && (
          <span className="basis-full text-xs text-ink-2" data-testid="signed-note">
            {tr('Signed {date} — {name}', { date: new Date(data.signed.at).toLocaleString(uiLocale(), { dateStyle: 'medium', timeStyle: 'short' }), name: data.signed.byName || '' })}
          </span>
        )}
      </div>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex-1 text-xs text-ink-2">{tr('Total: {h}h', { h: total.toFixed(1) })}</span>
        {can(data, 'approve') && pickable.length > 0 && <SelectHead sel={sel} testid="hours-select" />}
      </div>
      <PagedList items={wids} render={wid => {
        const list = byW[wid];
        return (
          <Section key={wid} label={name(wid)} count={list.length}            tools={<span className="font-mono text-xs text-fig">{hrs(list.reduce((t, r) => t + r.hours, 0))}</span>}>
            {list.map(r => <DayPlate key={r.key} data={data} row={r} sel={sel} onWindow={(kind, row) => setWin({ kind, row })} />)}
          </Section>
        );
      }} />
      <SelectBar sel={sel}>
        <Button size="sm" variant="primary" disabled={!sel.picked.size} data-testid="approve-selected" onClick={() => void approveSelected()}><IconCheck className="size-4" />{tr('Approve')}</Button>
      </SelectBar>
      {win?.kind === 'dispute' && <DisputeWindow data={data} row={win.row} name={name(win.row.workerId)} onClose={() => setWin(null)} />}
      {win?.kind === 'fix' && <FixWindow data={data} row={win.row} name={name(win.row.workerId)} onClose={() => setWin(null)} />}
      <AlertDialog open={confirmMonth} onOpenChange={setConfirmMonth}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('Approve the month')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('Approve all the hours of this month?')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('Cancel')}</AlertDialogCancel>
            <AlertDialogAction data-testid="approve-month-ok" onClick={() => void send({ action: 'approve', lines: pickable.map(r => r.line) }, tr('Approved — thank you'))
              .then(ok => { if (ok && canSign && st.data && allDone(st.data)) setSigning(true); })}>{tr('Approve')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {signing && <SignWindow data={data} days={days} total={total} onClose={() => setSigning(false)} />}
    </>
  );
}

function DayPlate({ data, row: r, sel, onWindow }: {
  data: HoursData; row: DayRow; sel: ReturnType<typeof useSelection>;
  onWindow: (kind: 'dispute' | 'fix', row: DayRow) => void;
}) {
  const { st: s, e } = dayState(data, r);
  const S = STATES[s];
  const pickable = PICKABLE.includes(s);
  let note = '';
  if (e && (s === 'disputed' || s === 'fix' || s === 'rejected' || s === 'fixed')) {
    const fix = e.inT ? tr('Proposed: {in}–{out}', { in: e.inT, out: e.outT || '' }) + (e.comment ? ' · ' : '') : '';
    note = tr(S.label) + ': ' + fix + (e.comment || '') + (e.byName ? ' — ' + e.byName : '');
  } else if (s === 'changed') note = tr('Changed after approval — check and approve again');
  const actions: PlateAction[] = [
    ...(can(data, 'approve') && s !== 'approved' && s !== 'fixed' ? [{ label: tr('Approve this day'), icon: <IconCheck />, onSelect: () => void send({ action: 'approve', lines: [r.line] }, tr('Day approved')) }] : []),
    ...(can(data, 'dispute') ? [{ label: tr('Dispute this day'), icon: <IconAlertTriangle />, onSelect: () => onWindow('dispute', r) }] : []),
    ...(can(data, 'fix') ? [{ label: tr('Propose a fix'), icon: <IconPencil />, onSelect: () => onWindow('fix', r) }] : []),
  ];
  const selecting = sel.on && pickable;
  // A tap opens the day's form: the fix when the login may propose one, else the dispute.
  const open = can(data, 'fix') ? () => onWindow('fix', r) : can(data, 'dispute') ? () => onWindow('dispute', r) : undefined;
  return (
    <Plate
      data-day-key={r.key}
      data-state={s}
      className="mb-1.5"
      size="sm"
      color={S.color}
      title={dayLabel(r.date)}
      chips={<Badge className="!font-bold" style={{ color: S.color, background: `color-mix(in srgb, ${S.color} 16%, transparent)` }} title={tr(S.label)}>{tr(S.pill)}</Badge>}
      sub={shiftsText(r)}
      right={hrs(r.hours)}
      actions={sel.on ? undefined : actions}
      onOpen={sel.on ? undefined : open}
      selecting={selecting}
      selected={selecting && sel.picked.has(r.key)}
      onToggle={() => sel.toggle(r.key)}
      expanded={!!note}
    >
      {note ? <div className="text-[11px]" style={{ color: S.color }} data-testid="day-note">{note}</div> : undefined}
    </Plate>
  );
}

// Signing the month (a client): the month's days and the signature become a
// PDF stored with the client's documents (signed-pdf.ts, hours.py sign).
// Closing the window without "Sign and save" signs nothing.
function SignWindow({ data, days, total, onClose }: { data: HoursData; days: DayRow[]; total: number; onClose: () => void }) {
  const pad = React.useRef<SignaturePadHandle>(null);
  const [ink, setInk] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const month = monthStart(data.month).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' });
  const save = async () => {
    const png = pad.current?.image();
    if (!png || saving) return;
    setSaving(true);
    try {
      const pages = await signedMonthPages(data, days, png, (signRef && signRef.signer) || '');
      const r = await callRef!({ action: 'sign', month: data.month, pages });
      if (r.error) { toast.error(r.error); return; }
      if (st.data && st.data.month === data.month) set({ data: { ...st.data, signed: r.signed } });
      toast.success(tr('Signed — the month is saved for the firm'));
      onClose();
    } catch {
      toast.error(tr('Could not save — check the connection and try again.'));
    } finally { setSaving(false); }
  };
  return (
    <Window open onOpenChange={o => { if (!o && !saving) onClose(); }} title={<><IconSignature className="mr-1.5 inline size-4 align-[-2px]" />{tr('Sign the month')}</>}
      description={month}
      footer={<Button variant="primary" disabled={!ink || saving} data-testid="sign-ok" onClick={() => void save()}>
        {saving ? <Spinner className="size-4" /> : <IconCheck className="size-4" />}{tr('Sign and save')}</Button>}>
      <p className="mb-2.5 text-[13px] text-ink-2">{tr('{n} days', { n: days.length })} · {tr('Total: {h}h', { h: total.toFixed(1) })}. {tr('Your signature confirms the hours of this month; the signed PDF is kept with your documents at the firm.')}</p>
      <SignaturePad ref={pad} onInk={setInk} />
    </Window>
  );
}

function DayTitle({ row }: { row: DayRow }) {
  return <div className="mb-2.5 text-[13px] text-ink-2">{dayLabel(row.date, true)} · {shiftsText(row)}</div>;
}

// A dispute window: no Save button — closing it (a tap outside) sends the
// comment; an empty comment takes the dispute back.
function DisputeWindow({ data, row, name, onClose }: { data: HoursData; row: DayRow; name: string; onClose: () => void }) {
  const e = (data.days || {})[row.key];
  const was = e && e.status === 'disputed' ? e.comment || '' : '';
  const [text, setText] = React.useState(was);
  const close = () => {
    onClose();
    const comment = text.trim();
    if (comment === was) return;
    void send({ action: 'dispute', workerId: row.workerId, day: row.day, line: row.line, comment }, comment ? tr('Dispute sent') : tr('Dispute removed'));
  };
  return (
    <Window open onOpenChange={o => { if (!o) close(); }} title={<><IconAlertTriangle className="mr-1.5 inline size-4 align-[-2px]" />{tr('Dispute — {name}', { name })}</>}>
      <DayTitle row={row} />
      <div className="grid gap-1.5">
        <Label htmlFor="hrv-dispute">{tr('What is wrong with this day?')}</Label>
        <Textarea id="hrv-dispute" data-testid="dispute-text" rows={4} autoFocus value={text} onChange={ev => setText(ev.target.value)} placeholder={tr('e.g. left at 15:00, not 17:00')} />
      </div>
      <p className="mt-2 text-[11px] text-faint">{tr('Saved when you close this window. Empty = no dispute.')}</p>
    </Window>
  );
}

// A proposed fix: the right in / out (and why). Closing the window sends it
// when a time differs from the punches; the firm accepts or rejects it. A day
// with several shifts first asks which shift.
function FixWindow({ data, row, name, onClose }: { data: HoursData; row: DayRow; name: string; onClose: () => void }) {
  const e = (data.days || {})[row.key];
  const pending = e && e.status === 'fix' ? e : undefined;
  const first = pending && Number.isInteger(pending.shift) && row.shifts[pending.shift!] ? pending.shift! : 0;
  const [idx, setIdx] = React.useState(first);
  const startIn = pending ? pending.inT || '' : row.shifts[first].inT, startOut = pending ? pending.outT || '' : row.shifts[first].outT;
  const wasComment = pending ? pending.comment || '' : '';
  const [inT, setIn] = React.useState(startIn);
  const [outT, setOut] = React.useState(startOut);
  const [comment, setComment] = React.useState(wasComment);
  const close = () => {
    onClose();
    const c = comment.trim(), sh = row.shifts[idx];
    if (!inT || !outT || (inT === startIn && outT === startOut && c === wasComment)) return;
    if (inT === sh.inT && outT === sh.outT) return;
    void send({ action: 'fix', workerId: row.workerId, day: row.day, line: row.line, shift: idx, inT, outT, comment: c }, tr('Fix sent'));
  };
  return (
    <Window open onOpenChange={o => { if (!o) close(); }} title={<><IconPencil className="mr-1.5 inline size-4 align-[-2px]" />{tr('Fix — {name}', { name })}</>}>
      <DayTitle row={row} />
      <div className="grid gap-3">
        {row.shifts.length > 1 && (
          <div className="grid gap-1.5">
            <Label>{tr('Shift')}</Label>
            <Select value={String(idx)} onValueChange={v => { const i = Number(v) || 0; setIdx(i); setIn(row.shifts[i].inT); setOut(row.shifts[i].outT); }}>
              <SelectTrigger data-testid="fix-shift"><SelectValue /></SelectTrigger>
              <SelectContent>{row.shifts.map((x, i) => <SelectItem key={i} value={String(i)}>{(x.inT || '--:--') + '–' + (x.outT || '--:--')}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        <FieldRow>
          <div className="grid gap-1.5"><Label htmlFor="hrv-in">{tr('In')}</Label><Input id="hrv-in" data-testid="fix-in" type="time" value={inT} onChange={ev => setIn(ev.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="hrv-out">{tr('Out')}</Label><Input id="hrv-out" data-testid="fix-out" type="time" value={outT} onChange={ev => setOut(ev.target.value)} /></div>
        </FieldRow>
        <div className="grid gap-1.5">
          <Label htmlFor="hrv-fix-text">{tr('Comment')}</Label>
          <Textarea id="hrv-fix-text" data-testid="fix-text" rows={2} value={comment} onChange={ev => setComment(ev.target.value)} />
        </div>
      </div>
      <p className="mt-2 text-[11px] text-faint">{tr('Sent when you close this window. The firm accepts or rejects the fix.')}</p>
    </Window>
  );
}

async function exportXlsx(data: HoursData, days: DayRow[]) {
  try { await loadScript(XLSX_URL); } catch { toast.error(tr('Excel library not loaded')); return; }
  const name = (id: string) => (data.workers || []).find(w => w.id === id)?.name || '';
  const head = [tr('Worker'), tr('Date'), tr('In'), tr('Out'), tr('Hours'), tr('Status')];
  const rows: unknown[][] = days.map(r => [name(r.workerId), r.date.toLocaleDateString('en-GB'), r.shifts.map(s => s.inT).join(', '),
    r.shifts.map(s => s.outT).join(', '), Math.round(r.hours * 100) / 100, tr(STATES[dayState(data, r).st].label)]);
  rows.push([tr('Total'), '', '', '', Math.round(days.reduce((t, r) => t + r.hours, 0) * 100) / 100, '']);
  const owner = (data.owner && data.owner.name) || '';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[owner + ' — ' + data.month], [], head, ...rows]), tr('Hours'));
  XLSX.writeFile(wb, 'hours-' + data.month + '.xlsx');
}

// Schedule: each worker's planned day for every day of the month.
function ScheduleTab({ data }: { data: HoursData }) {
  const ws = (data.workers || []).filter(w => w.schedule);
  if (!ws.length) return <Msg>{tr('No shifts planned yet')}</Msg>;
  const start = monthStart(data.month), days: Date[] = [];
  for (let d = new Date(start); d.getMonth() === start.getMonth(); d.setDate(d.getDate() + 1)) days.push(new Date(d));
  const today = localYMD(new Date());
  return (
    <PagedList items={ws} render={w => {
      const rows = days.map(d => ({ d, t: planned(w, d) })).filter(x => x.t);
      return (
        <Section key={w.id} label={w.name} count={rows.length}>
          {rows.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>{tr('Date')}</TableHead><TableHead num>{tr('Shift')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map(({ d, t }) => (
                  <TableRow key={localYMD(d)}>
                    <TableCell className={cn(localYMD(d) === today && 'font-bold text-info')}>{dayLabel(d)}</TableCell>
                    <TableCell num>{t}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <div className="pt-1.5 text-xs text-faint">{tr('No shifts planned yet')}</div>}
        </Section>
      );
    }} />
  );
}
