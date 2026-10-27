// The Schedule tab of the manager app (docs/app-core.md → Schedule tab), drawn
// in React inside the old page (stage 6b): ‹ week › with its totals (a tap on
// the dates opens a calendar) and the export menu, the site tabs (the page's
// site filter), the workers' requests (a day they can't work, a
// shift offered to a colleague: Confirm hands it over), and a plate per worker
// with its week — a tap opens its 7 days, a day opens the shift window.
// Copy last week / Repeat for N weeks fill only empty days, list the shifts
// before adding them, and offer Undo. The data and every write go through the
// page (ManagerBridge); schedule only, never punches or pay.
import * as React from 'react';
import {
  IconBraces, IconCalendarRepeat, IconCalendarUser, IconChevronDown, IconChevronLeft, IconChevronRight, IconCopy, IconCheck,
  IconDownload, IconFileSpreadsheet, IconFileTypePdf, IconUserPlus, IconUsers, IconX, IconCalendarOff,
} from '@tabler/icons-react';
import { localYMD } from '@/lib/payroll';
import { tr, uiLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useIsPhone } from '@/hooks/use-phone';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Plate } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { Window } from '@/components/shared/window';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { ManagerBridge, SchedWorker, ScheduleSnapshot, ShiftRequest } from './bridge';
import {
  addDays, calcHours, copyPlan, crossesMidnight, isWork, requestOn, shiftOn, sundayOf, visibleWorkers, weekHours, weekShifts, ymdDate, type CopyItem,
} from './schedule';
import { hoursShort } from './today';

const dayLabels = () => [tr('Sun'), tr('Mon'), tr('Tue'), tr('Wed'), tr('Thu'), tr('Fri'), tr('Sat')];
const fmtDate = (d: Date) => d.toLocaleDateString(uiLocale(), { day: '2-digit', month: 'short' });
const fmtReqDate = (ymd: string) => ymdDate(ymd).toLocaleDateString(uiLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
const shiftsText = (n: number) => (n === 1 ? tr('1 shift') : tr('{n} shifts', { n }));
const REPEAT_WEEKS = [1, 2, 3, 4, 6, 8];
/** The site select's "All sites" (a Select item cannot have an empty value). */
const ALL_SITES = '*';
// The open workers stay open while the app is open (the page's __schedOpen).
const opened = new Set<string>();

function Loading() {
  return (
    <div data-testid="schedule-loading" aria-busy="true" className="grid gap-2">
      <Skeleton className="h-11" />
      <Skeleton className="h-9 w-2/3" />
      {[0, 1, 2].map(i => <Skeleton key={i} className="h-[62px]" />)}
    </div>
  );
}

/** Seven marks for the week: green work, blue a night crossing midnight, amber off while on vacation, grey off; today ringed. */
function DayMarks({ w, start, today }: { w: SchedWorker; start: Date; today: string }) {
  return (
    <span className="mt-[5px] flex gap-[3px]" data-testid="daymarks">
      {weekShifts(w, start).map((x, di) => {
        const k = isWork(x) ? (crossesMidnight(x) ? 'n' : 'w') : (w.status === 'vacation' ? 'o' : '-');
        return (
          <i key={di} data-k={k} className={cn('h-1.5 w-4 rounded-[3px] bg-white/12', k === 'w' && 'bg-ok', k === 'n' && 'bg-info', k === 'o' && 'bg-warn',
            localYMD(addDays(start, di)) === today && 'shadow-[0_0_0_1.5px_rgba(var(--tint),.7)]')} />
        );
      })}
    </span>
  );
}

type ShiftEdit = { w: SchedWorker; di: number };

function ShiftWindow({ edit, start, api, onClose }: { edit: ShiftEdit | null; start: Date; api: ManagerBridge; onClose: () => void }) {
  const date = edit ? addDays(start, edit.di) : start;
  const sh = edit ? shiftOn(edit.w, date) : null;
  const [type, setType] = React.useState<'work' | 'off'>('work');
  const [scope, setScope] = React.useState<'week' | 'date'>('week');
  const [from, setFrom] = React.useState('09:00');
  const [to, setTo] = React.useState('17:00');
  React.useEffect(() => {
    if (!sh) return;
    setType(sh.type === 'off' ? 'off' : 'work'); setScope(sh.dated ? 'date' : 'week');
    setFrom(sh.start || '09:00'); setTo(sh.end || '17:00');
  }, [edit]);
  const day = edit ? dayLabels()[edit.di] : '';
  const ymd = localYMD(date);
  const save = () => {
    if (!edit) return;
    api.setShift(edit.w.id, ymd, scope, type === 'work' ? { type, start: from, end: to } : { type: 'off', start: null, end: null });
    onClose();
  };
  const back = () => {
    if (!edit) return;
    api.applyDated([{ workerId: edit.w.id, date: ymd, shift: null }]);
    api.toast(tr('Back to the weekly schedule'));
    onClose();
  };
  const h = calcHours(from, to);
  return (
    <Window open={!!edit} onOpenChange={o => { if (!o) onClose(); }}
      title={edit ? tr('Edit shift — {0}, {1} {2}', { 0: edit.w.name, 1: day, 2: fmtDate(date) }) : ''}
      footer={<Button variant="primary" data-testid="shift-save" onClick={save}><IconCheck />{tr('Save')}</Button>}>
      <div className="grid gap-3 px-1" data-testid="shift-window">
        <div className="grid gap-1.5">
          <Label>{tr('Shift type')}</Label>
          <ToggleGroup type="single" value={type} onValueChange={v => { if (v) setType(v as 'work' | 'off'); }} data-testid="shift-type">
            <ToggleGroupItem value="work">{tr('Working')}</ToggleGroupItem>
            <ToggleGroupItem value="off">{tr('Day off')}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid gap-1.5">
          <Label>{tr('Applies to')}</Label>
          <Select value={scope} onValueChange={v => setScope(v as 'week' | 'date')}>
            <SelectTrigger data-testid="shift-scope"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="week">{tr('Every {0}', { 0: day })}</SelectItem>
              <SelectItem value="date">{tr('Only {0}', { 0: fmtDate(date) })}</SelectItem>
            </SelectContent>
          </Select>
          {sh?.dated && (
            <p className="text-xs text-ink-2">{tr('This date has its own shift.')}{' '}
              <button type="button" data-testid="shift-back" className="font-semibold text-info hover:underline" onClick={back}>{tr('Back to the weekly schedule')}</button>
            </p>
          )}
        </div>
        <div className={cn('grid gap-2', type === 'off' && 'pointer-events-none opacity-40')}>
          <div className="field-row">
            <div className="grid gap-1.5"><Label htmlFor="shiftFrom">{tr('Start')}</Label><Input id="shiftFrom" type="time" value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="shiftTo">{tr('End')}</Label><Input id="shiftTo" type="time" value={to} onChange={e => setTo(e.target.value)} /></div>
          </div>
          {from && to && (
            <span data-testid="shift-hours" className="w-fit rounded-full bg-white/8 px-2.5 py-1 font-mono text-xs text-fig">
              {tr('{h}h', { h: h.toFixed(2) })}{crossesMidnight({ type: 'work', start: from, end: to }) ? ' · ' + tr('crosses midnight') : ''}
            </span>
          )}
        </div>
      </div>
    </Window>
  );
}

type CopyAsk = { mode: 'last' | 'repeat'; ids: string[] };

/** The shifts Copy last week / Repeat would add, shown before anything is saved. */
function CopyWindow({ ask, snap, start, api, onClose }: { ask: CopyAsk | null; snap: ScheduleSnapshot; start: Date; api: ManagerBridge; onClose: () => void }) {
  const [weeks, setWeeks] = React.useState(4);
  const items = React.useMemo<CopyItem[]>(() => {
    if (!ask) return [];
    const ws = snap.workers.filter(w => ask.ids.includes(w.id));
    return ask.mode === 'last'
      ? copyPlan(ws, addDays(start, -7), [start], snap.requests)
      : copyPlan(ws, start, Array.from({ length: weeks }, (_, i) => addDays(start, 7 * (i + 1))), snap.requests);
  }, [ask, snap, start, weeks]);
  const days = dayLabels();
  const apply = () => {
    if (!items.length) return;
    api.applyDated(items);
    undoDelete(tr('{0} added', { 0: shiftsText(items.length) }), () => {}, () => api.applyDated(items.map(i => ({ ...i, shift: null }))));
    onClose();
  };
  return (
    <Window open={!!ask} onOpenChange={o => { if (!o) onClose(); }}
      title={ask?.mode === 'repeat' ? tr('Repeat this week') : tr('Copy last week')}
      description={ask?.mode === 'repeat'
        ? tr("This week's shifts go to the next weeks. Days that already have a shift keep it.")
        : tr("Last week's shifts go to this week. Days that already have a shift keep it.")}
      footer={<Button variant="primary" data-testid="copy-apply" disabled={!items.length} onClick={apply}><IconCheck />{tr('Add {0}', { 0: shiftsText(items.length) })}</Button>}>
      <div className="grid gap-3 px-1" data-testid="copy-window">
        {ask?.mode === 'repeat' && (
          <div className="grid gap-1.5">
            <Label>{tr('For how many weeks')}</Label>
            <ToggleGroup type="single" value={String(weeks)} onValueChange={v => { if (v) setWeeks(Number(v)); }} data-testid="copy-weeks">
              {REPEAT_WEEKS.map(n => <ToggleGroupItem key={n} value={String(n)}>{n}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        )}
        <PagedList items={items}
          empty={<div data-testid="copy-empty" className="rounded-[14px] border border-dashed border-white/20 px-3 py-3.5 text-center text-[13px] text-ink-2">{tr('Nothing to add: every day already has its shift, or there are no shifts to copy.')}</div>}
          render={it => {
            const d = ymdDate(it.date);
            return (
              <Plate key={it.workerId + it.date} size="sm" className="mb-1.5" data-testid="copy-item" color={crossesMidnight(it.shift) ? 'var(--info)' : 'var(--green)'}
                title={it.name} sub={`${days[d.getDay()]} ${fmtDate(d)}`} right={`${it.shift.start}–${it.shift.end}`} />
            );
          }} />
      </div>
    </Window>
  );
}

function Requests({ list, snap, api }: { list: ShiftRequest[]; snap: ScheduleSnapshot; api: ManagerBridge }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!list.length) return null;
  const byId = new Map(snap.workers.map(w => [w.id, w]));
  const decide = async (id: string, ok: boolean) => { setBusy(id); try { await api.decideRequest(id, ok); } finally { setBusy(null); } };
  return (
    <Section label={tr('Requests from workers')} count={list.length} icon={<IconCalendarUser className="text-warn" />} panel data-testid="sched-requests">
      <PagedList items={list} render={q => {
        const w = byId.get(q.workerId), d = ymdDate(q.date), sh = w ? shiftOn(w, d) : null;
        const extra = (t: string) => <span key="x" className="text-warn">{t}</span>;
        if (q.kind === 'unavailable') {
          const planned = sh && isWork(sh) ? tr('Planned {0}', { 0: `${sh.start}–${sh.end}` }) : '';
          return (
            <Plate key={q.id} color="var(--amber)" className="mb-1.5" data-testid="shift-req" data-kind="unavailable" icon={<IconCalendarOff />}
              title={q.workerName || w?.name || ''}
              sub={<>{tr("Can't work")} · {fmtReqDate(q.date)}{planned && <> · {extra(planned)}</>}{q.note && <> · {q.note}</>}</>} />
          );
        }
        const to = q.toWorkerId ? byId.get(q.toWorkerId) : undefined, toSh = to ? shiftOn(to, d) : null;
        const toDay = to && toSh && isWork(toSh) ? tr('{0} already works {1}', { 0: to.name, 1: `${toSh.start}–${toSh.end}` }) : '';
        return (
          <Plate key={q.id} color="var(--accent)" className="mb-1.5" data-testid="shift-req" data-kind="swap"
            title={`${q.workerName || ''} → ${q.toWorkerName || ''}`}
            sub={<>{tr('Shift offer')} · {fmtReqDate(q.date)} · {q.start || ''}–{q.end || ''}{toDay && <> · {extra(toDay)}</>}{q.note && <> · {q.note}</>}</>}
            right={snap.canEdit ? (
              <span className="flex items-center gap-1.5 font-sans">
                <Button variant="primary" size="sm" data-testid="sr-ok" disabled={busy === q.id} onClick={() => decide(q.id, true)}><IconCheck className="size-4" />{tr('Confirm')}</Button>
                <Button size="icon-sm" data-testid="sr-no" aria-label={tr('Decline')} disabled={busy === q.id} onClick={() => decide(q.id, false)}><IconX className="size-4" /></Button>
              </span>
            ) : undefined} />
        );
      }} />
    </Section>
  );
}

export function Schedule({ snap, api }: { snap: ScheduleSnapshot; api: ManagerBridge }) {
  const phone = useIsPhone();
  const start = React.useMemo(() => ymdDate(snap.weekStart), [snap.weekStart]);
  const vis = React.useMemo(() => visibleWorkers(snap.workers, snap.clientId, start), [snap.workers, snap.clientId, start]);
  const ids = React.useMemo(() => vis.map(w => w.id), [vis]);
  const sel = useSelection(ids);
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [edit, setEdit] = React.useState<ShiftEdit | null>(null);
  const [copy, setCopy] = React.useState<CopyAsk | null>(null);
  const [calOpen, setCalOpen] = React.useState(false);
  const drag = React.useRef<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);

  if (!snap.ready) return <Loading />;

  const today = localYMD(new Date());
  const thisWeek = localYMD(sundayOf(new Date())) === snap.weekStart;
  const total = vis.reduce((t, w) => t + weekHours(w, start), 0);
  const nShifts = vis.flatMap(w => weekShifts(w, start)).filter(x => x.type === 'work').length;
  const days = dayLabels();
  const known = new Set(snap.workers.map(w => w.id));
  const requests = snap.requests
    .filter(q => known.has(q.workerId) && (q.kind === 'unavailable' || q.status === 'pending'))
    .filter(q => !snap.clientId || (snap.workers.find(w => w.id === q.workerId)?.clientIds || []).includes(snap.clientId))
    .sort((a, b) => (a.kind === 'swap' ? 0 : 1) - (b.kind === 'swap' ? 0 : 1) || a.date.localeCompare(b.date));
  const toggle = (id: string) => { if (opened.has(id)) opened.delete(id); else opened.add(id); redraw(); };
  const week = (n: number) => api.setWeek(localYMD(addDays(start, 7 * n)));
  const askCopy = (mode: CopyAsk['mode'], which: string[]) => setCopy({ mode, ids: which });

  const row = (w: SchedWorker) => {
    const ws = weekShifts(w, start), work = ws.filter(isWork), open = opened.has(w.id);
    const sum = [w.site, shiftsText(work.length)].filter(Boolean).join(' · ');
    const dnd = snap.canEdit && !phone && !sel.on;
    return (
      <div key={w.id} data-testid="sched-worker" data-id={w.id} draggable={dnd}
        className={cn('mb-1.5 rounded-[16px]', over === w.id && 'outline-2 outline-dashed outline-info -outline-offset-2')}
        onDragStart={dnd ? e => { drag.current = w.id; e.dataTransfer.effectAllowed = 'move'; } : undefined}
        onDragOver={dnd ? e => { e.preventDefault(); if (drag.current && drag.current !== w.id) setOver(w.id); } : undefined}
        onDragLeave={dnd ? () => setOver(o => (o === w.id ? null : o)) : undefined}
        onDrop={dnd ? e => { e.preventDefault(); setOver(null); const from = drag.current; drag.current = null; if (from && from !== w.id) api.moveWorker(from, w.id); } : undefined}
        onDragEnd={dnd ? () => { drag.current = null; setOver(null); } : undefined}>
        <Plate
          title={w.name}
          color={w.status === 'vacation' ? 'var(--amber)' : work.length ? 'var(--green)' : 'var(--neutral)'}
          sub={<><span>{sum}</span><DayMarks w={w} start={start} today={today} /></>}
          right={<span className="flex items-center gap-1.5" data-testid="week-hours">{hoursShort(weekHours(w, start))}<IconChevronDown className={cn('size-4 text-ink-3 transition-transform duration-150', open && 'rotate-180')} /></span>}
          selecting={sel.on} selected={sel.picked.has(w.id)} onToggle={() => sel.toggle(w.id)}
          onOpen={() => toggle(w.id)} onEdit={() => api.editWorker(w.id)}
          expanded={open && !sel.on}
        >
          {open && !sel.on && (
            <div className="grid" data-testid="dayrows">
              {ws.map((x, di) => {
                const date = addDays(start, di), ymd = localYMD(date), on = isWork(x), mid = crossesMidnight(x);
                const na = requestOn(snap.requests, w.id, ymd, 'unavailable');
                return (
                  <button key={di} type="button" data-testid="sched-day" data-date={ymd} disabled={!snap.canEdit}
                    onClick={() => setEdit({ w, di })}
                    className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-[7px] text-left text-[13px] text-ink-2 hover:bg-white/4 disabled:cursor-default">
                    <span className={cn('min-w-0 truncate', ymd === today && 'font-bold text-info')}>
                      {days[di]} {date.getDate()}{w.site ? ' · ' + w.site : ''}
                      {x.dated && <i title={tr('Changed for this date only')} data-testid="sched-dated" className="ml-1.5 inline-block size-1.5 rounded-full bg-info align-middle" />}
                      {na && <em className="ml-1.5 text-[11px] font-bold not-italic text-warn">{tr("Can't work")}</em>}
                    </span>
                    <b className={cn('shrink-0 text-[13px] font-semibold', on ? 'font-mono' : 'text-warn', on && (mid ? 'text-info' : 'text-fig'))}>
                      {on ? `${x.start}–${x.end}` : tr('Day off')}
                    </b>
                  </button>
                );
              })}
            </div>
          )}
        </Plate>
      </div>
    );
  };

  return (
    <div data-testid="schedule">
      <p className="mb-3 text-[15px] text-ink-2">{tr("A worker's line opens the week · a day opens its shift")}</p>
      <div className="mb-2 flex items-center gap-1.5" data-testid="sched-nav">
        <Button size="icon" aria-label={tr('Previous week')} data-testid="week-prev" onClick={() => week(-1)}><IconChevronLeft /></Button>
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <button type="button" data-testid="week-pick" className="min-w-0 flex-1 rounded-[12px] px-1 py-0.5 text-center hover:bg-white/4">
              <b className="block text-base" data-testid="week-range">{fmtDate(start)} – {fmtDate(addDays(start, 6))}</b>
              <span className="block text-xs text-ink-2" data-testid="week-sum">
                {[thisWeek ? tr('This week') : '', tr('{h}h', { h: total.toFixed(0) }), shiftsText(nShifts)].filter(Boolean).join(' · ')}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <Calendar mode="single" selected={start} defaultMonth={start}
              onSelect={d => { if (d) { api.setWeek(localYMD(sundayOf(d))); setCalOpen(false); } }} />
          </PopoverContent>
        </Popover>
        <Button size="icon" aria-label={tr('Next week')} data-testid="week-next" onClick={() => week(1)}><IconChevronRight /></Button>
        {snap.canExport && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={tr('Export')} data-testid="sched-export"><IconDownload className="size-[18px]" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => api.exportAs('excel')}><IconFileSpreadsheet />{tr('Excel (.xlsx)')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => api.exportAs('pdf')}><IconFileTypePdf />PDF</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => api.exportAs('json')}><IconBraces />{tr('JSON')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {snap.clients.length > 0 && (
        // One select for the sites (owner, 2026-10-26: a row of tabs breaks with many clients).
        <div className="mb-3 max-w-xs" data-testid="site-pick">
          <Select value={snap.clientId || ALL_SITES} onValueChange={v => api.setClient(v === ALL_SITES ? null : v)}>
            <SelectTrigger data-testid="site-select" aria-label={tr('Site')} className={cn('w-full', snap.clientId && 'border-info text-info')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SITES}>{tr('All sites')}</SelectItem>
              {[...snap.clients].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <Requests list={requests} snap={snap} api={api} />

      <Section label={tr('Workers')} count={vis.length} icon={<IconUsers className="text-ink-2" />} data-testid="sched-workers">
        {snap.canEdit && vis.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="sched-tools">
            {!sel.on && <>
              <Button size="sm" data-testid="copy-last" onClick={() => askCopy('last', ids)}><IconCopy className="size-4" />{tr('Copy last week')}</Button>
              <Button size="sm" data-testid="copy-repeat" onClick={() => askCopy('repeat', ids)}><IconCalendarRepeat className="size-4" />{tr('Repeat for N weeks')}</Button>
            </>}
            <span className={cn('flex', !sel.on && 'ml-auto')}><SelectHead sel={sel} /></span>
          </div>
        )}
        <PagedList items={vis} columns render={row}
          empty={
            <Empty data-testid="schedule-empty" className="mx-auto max-w-md">
              <EmptyMedia><IconUsers /></EmptyMedia>
              <EmptyTitle>{tr('No one on the schedule')}</EmptyTitle>
              <EmptyDescription>{snap.clientId ? tr('This site has no active workers.') : tr('Workers with working days show here; pick a site to see all its workers.')}</EmptyDescription>
              {snap.canAddWorker && <EmptyContent><Button variant="primary" className="og-new" onClick={api.addWorker}><IconUserPlus />{tr('Add a worker')}</Button></EmptyContent>}
            </Empty>
          } />
      </Section>

      <SelectBar sel={sel}>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-copy-last" onClick={() => { askCopy('last', [...sel.picked]); sel.end(); }}><IconCopy className="size-4" />{tr('Copy last week')}</Button>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-copy-repeat" onClick={() => { askCopy('repeat', [...sel.picked]); sel.end(); }}><IconCalendarRepeat className="size-4" />{tr('Repeat for N weeks')}</Button>
      </SelectBar>

      <ShiftWindow edit={edit} start={start} api={api} onClose={() => setEdit(null)} />
      <CopyWindow ask={copy} snap={snap} start={start} api={api} onClose={() => setCopy(null)} />
    </div>
  );
}
