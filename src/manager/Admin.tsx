// The Admin tab of the manager app (docs/admin.md), drawn in React inside the
// old page: the section tabs (the breadcrumb "Admin › <section>"), three large
// tiles while no section is chosen, and the sections — the Punch Log (stage
// 6f-1: the figures, Log / By Client, the filters, a plate per punch — a tap
// edits it, ⋮ / swipe, Delete through the Undo snack, Select —, "Load earlier
// month", Export CSV and Clear Log behind the Alert Dialog), and Firms, Users,
// Errors and Timings (stage 6f-2: Firms.tsx, Users.tsx, Logs.tsx). The data,
// its saves and the server calls stay on the page (ManagerBridge).
import * as React from 'react';
import {
  IconAlertCircle, IconAlertTriangle, IconBuildingSkyscraper, IconClipboardText, IconDownload, IconEdit, IconHistory, IconMapPin,
  IconStopwatch, IconTrash, IconUsers,
  IconScan,
} from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldRow } from '@/components/ui/form';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plate } from '@/components/shared/plate';
import { Figures, Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import { Window } from '@/components/shared/window';
import type { AdminPane, AdminPunch, AdminSnapshot, ManagerBridge } from './bridge';
import { Line } from './pieces';
import { Field } from './ClientEditor';
import { useTapOpen } from './Clients';
import { byClient, dayOf, filterChoices, filterLog, logFigures, monthCounts, NO_FILTERS, type LogFilters } from './punchlog';
import { FirmsPane } from './Firms';
import { UsersPane } from './Users';
import { LogsPane } from './Logs';

const PANES: { k: AdminPane; label: string; icon: React.ReactNode }[] = [
  { k: 'punchlog', label: 'Punch Log', icon: <IconClipboardText /> },
  { k: 'firms', label: 'Firms', icon: <IconBuildingSkyscraper /> },
  { k: 'users', label: 'Users', icon: <IconUsers /> },
  { k: 'errors', label: 'Errors', icon: <IconAlertCircle /> },
  { k: 'timings', label: 'Timings', icon: <IconStopwatch /> },
];
/** The line under the tabs: what the open section is for (through tr()). */
const SUBTITLES: Record<AdminPane, string> = {
  punchlog: 'Punch log — view, edit and export all attendance records',
  firms: 'Firm details — the employer block printed on every Form 101',
  users: 'Staff, HR and supplier logins for this firm',
  errors: 'Client-side errors by period, every firm',
  timings: 'How long login, app open and scans take (real devices, every firm)',
};
/** The large tiles while no section is chosen (the UI audit): the three sections an owner uses. */
const TILES: AdminPane[] = ['punchlog', 'firms', 'users'];

// The filters and the view stay while the app is open (the tab is drawn again on every render()).
let keptFilters: LogFilters = NO_FILTERS;
let keptView: 'log' | 'clients' = 'log';
// Punches deleted here and still inside their Undo time: left out of both views.
const hidden = new Set<string>();

export function Admin({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const pane = snap.pane && snap.panes.includes(snap.pane) ? snap.pane : null;
  return (
    <div data-testid="admin" data-pane={pane || ''}>
      <div className="og-tabs" id="adminTabs" data-testid="admin-tabs">
        {PANES.filter(p => snap.panes.includes(p.k)).map(p => (
          <button key={p.k} type="button" data-k={p.k} className={cn('inline-flex items-center gap-1.5 [&_svg]:size-4', pane === p.k && 'on')} onClick={() => api.setAdminPane(p.k)}>
            {p.icon}{tr(p.label)}
          </button>
        ))}
      </div>
      <p className="mb-3 text-[15px] text-ink-2" data-testid="admin-sub">{pane ? tr(SUBTITLES[pane]) : tr('Choose a section')}</p>
      {!pane && (
        <div className="grid gap-x-3 min-[701px]:grid-cols-3" data-testid="admin-tiles">
          {PANES.filter(p => TILES.includes(p.k) && snap.panes.includes(p.k)).map(p => (
            <Plate key={p.k} data-testid="admin-tile" data-k={p.k} size="lg" className="mb-2" icon={p.icon}
              color={p.k === 'firms' && snap.firmIncomplete ? 'var(--warn)' : p.k === 'punchlog' ? 'var(--info)' : p.k === 'firms' ? 'var(--ok)' : 'var(--accent)'}
              title={tr(p.label)} sub={<span className="block whitespace-normal">{tr(SUBTITLES[p.k])}</span>}
              onOpen={() => api.setAdminPane(p.k)} />
          ))}
          {/* The scanner lab (docs/scan-plan.md → Scanner lab): a super-admin's tool, like Errors and Timings. */}
          {snap.panes.includes('timings') && (
            <Plate data-testid="admin-tile" data-k="scanlab" size="lg" className="mb-2" icon={<IconScan />} color="var(--info)"
              title={tr('Scanner lab')} sub={<span className="block whitespace-normal">{tr("Try the scanner's models on this device: the live frame, the shot and the upright turn")}</span>}
              onOpen={() => window.open('/scan-lab/', '_blank', 'noopener')} />
          )}
        </div>
      )}
      {pane === 'punchlog' && (snap.ready ? <PunchLog snap={snap} api={api} /> : <Loading />)}
      {pane === 'firms' && <FirmsPane snap={snap} api={api} />}
      {pane === 'users' && <UsersPane snap={snap} api={api} />}
      {(pane === 'errors' || pane === 'timings') && <LogsPane key={pane} snap={snap} api={api} />}
    </div>
  );
}

function Loading() {
  return (
    <div data-testid="punchlog-loading" aria-busy="true" className="grid gap-2">
      <div className="grid grid-cols-4 gap-1.5">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[66px] rounded-[14px]" />)}</div>
      {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[62px]" />)}
    </div>
  );
}

const recordsText = (n: number) => tr('{0} record{1}', { 0: n, 1: n !== 1 ? 's' : '' });

/** IN / OUT · date · site · GPS (distance, ±accuracy, ⚠ when suspicious, or "Manual"). */
function PunchSub({ e, date = true }: { e: AdminPunch; date?: boolean }) {
  const isIn = e.type === 'in';
  const gps = e.manual
    ? <span key="g" className="inline-flex items-center gap-0.5 text-warn"><IconEdit className="size-3.5" />{tr('Manual')}</span>
    : (e.dist != null || e.gpsAccuracy || e.gpsSuspicious) && (
      <span key="g" className="inline-flex items-center gap-1">
        {e.dist != null && <span className="inline-flex items-center gap-0.5"><IconMapPin className="size-3.5" />{tr('{m} m', { m: Math.round(e.dist) })}</span>}
        {!!e.gpsAccuracy && <span>±{Math.round(e.gpsAccuracy)}m</span>}
        {e.gpsSuspicious && <span className="text-warn" title={(e.gpsWarnings || []).join('; ')} data-testid="punch-gps-warn"><IconAlertTriangle className="size-3.5" /></span>}
      </span>
    );
  return <Line parts={[
    <span key="t" className={cn('font-semibold', isIn ? 'text-ok' : 'text-bad')}>{isIn ? tr('IN') : tr('OUT')}</span>,
    date && dayOf(e), e.site, gps,
  ]} />;
}

function PunchLog({ snap, api }: { snap: AdminSnapshot; api: ManagerBridge }) {
  const [f, setF] = React.useState<LogFilters>(keptFilters);
  const [view, setViewState] = React.useState(keptView);
  const [editing, setEditing] = React.useState<AdminPunch | null>(null);
  const [clearing, setClearing] = React.useState<{ key: string; count: number }[] | null>(null);
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const setFilter = (k: keyof LogFilters, v: string) => { keptFilters = { ...keptFilters, [k]: v === 'all' ? '' : v }; setF(keptFilters); };
  const setView = (v: string) => { if (v !== 'log' && v !== 'clients') return; keptView = v; setViewState(v); };
  // Without Edit punches (the login's template) the punches only read.
  const tap = useTapOpen(id => { const e = snap.log.find(x => String(x.id) === id); if (e && snap.canEditPunches) setEditing(e); });

  const log = React.useMemo(() => snap.log.filter(e => !hidden.has(String(e.id))), [snap.log, hidden.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = React.useMemo(() => filterChoices(log), [log]);
  const rows = React.useMemo(() => filterLog(log, f, snap.workers), [log, f, snap.workers]);
  const ids = React.useMemo(() => rows.map(e => String(e.id)), [rows]);
  const sel = useSelection(ids);
  const figs = logFigures(log);

  const remove = (which: string[]) => {
    which = which.filter(id => log.some(e => String(e.id) === id));
    if (!which.length) return;
    which.forEach(id => hidden.add(id)); redraw();
    undoDelete(which.length === 1 ? tr('Punch') : tr('{0} punches', { 0: which.length }),
      () => { which.forEach(id => hidden.delete(id)); api.deletePunches(which); },
      () => { which.forEach(id => hidden.delete(id)); redraw(); });
  };
  const openClear = async () => {
    await api.loadAllPunches();
    const months = monthCounts(api.punchLog());
    if (!months.length) { api.toast(tr('Log is already empty')); return; }
    setClearing(months);
  };

  const plate = (e: AdminPunch, small?: boolean) => {
    const id = String(e.id), isIn = e.type === 'in';
    return (
      <Plate key={id} data-testid={small ? 'punch-sub' : 'punch-row'} data-pid={id} className="mb-1.5" size={small ? 'sm' : 'md'}
        color={isIn ? 'var(--ok)' : 'var(--bad)'}
        title={small ? <span className="font-mono">{e.time || '--'}</span> : <span title={e.workerName} data-testid="punch-name">{e.workerName || tr('Unknown')}</span>}
        sub={<PunchSub e={e} />}
        right={small ? undefined : <span className="text-ink" data-testid="punch-time">{e.time || '--'}</span>}
        {...tap(id)}
        onDelete={snap.canEditPunches ? () => remove([id]) : undefined}
        selecting={!small && sel.on} selected={sel.picked.has(id)} onToggle={() => sel.toggle(id)} />
    );
  };
  const filterSelect = (k: keyof LogFilters, label: string, all: string, items: { v: string; l: string }[]) => (
    <Select value={f[k] || 'all'} onValueChange={v => setFilter(k, v)}>
      <SelectTrigger className="w-full min-w-0" aria-label={label} data-testid={'punch-filter-' + k} title={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{all}</SelectItem>
        {items.map(o => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div data-testid="punchlog" data-view={view}>
      <Figures className="min-[701px]:max-w-[680px]" items={[
        { key: 'in', label: tr('Total IN'), value: figs.in, color: figs.in ? 'var(--ok)' : undefined },
        { key: 'out', label: tr('Total OUT'), value: figs.out, color: figs.out ? 'var(--bad)' : undefined },
        { key: 'today', label: tr('Today'), value: figs.today, color: 'var(--ink)' },
        { key: 'total', label: tr('Total'), value: figs.total, color: 'var(--ink)' },
      ]} />
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="punchlog-bar">
        <ToggleGroup type="single" value={view} onValueChange={setView} className="w-auto" data-testid="punchlog-view">
          <ToggleGroupItem value="log" data-v="log" className="flex-none whitespace-nowrap">{tr('Log')}</ToggleGroupItem>
          <ToggleGroupItem value="clients" data-v="clients" className="flex-none whitespace-nowrap">{tr('By Client')}</ToggleGroupItem>
        </ToggleGroup>
        {view === 'log' && <span className="font-mono text-[13px] text-ink-2" data-testid="punch-count">{recordsText(rows.length)}</span>}
        <span className="ml-auto flex gap-1">
          <Button size="icon-sm" variant="ghost" data-testid="punch-export" title={tr('Export CSV')} aria-label={tr('Export CSV')} onClick={() => void api.exportPunches()}><IconDownload className="size-4" /></Button>
          {snap.canClear && <Button size="icon-sm" variant="ghost" className="!text-bad" data-testid="punch-clear" title={tr('Clear Log')} aria-label={tr('Clear Log')} onClick={() => void openClear()}><IconTrash className="size-4" /></Button>}
        </span>
      </div>

      {view === 'log' ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 min-[701px]:grid-cols-4" data-testid="punch-filters">
            {filterSelect('worker', tr('Worker'), tr('All workers'), choices.workers.map(w => ({ v: w.id, l: w.name })))}
            {filterSelect('client', tr('Client'), tr('All clients'), snap.clients.map(c => ({ v: c.id, l: c.name })))}
            {filterSelect('date', tr('Date'), tr('All dates'), choices.dates.map(d => ({ v: d, l: d })))}
            {filterSelect('type', tr('Type'), tr('All types'), [{ v: 'in', l: tr('Punch IN') }, { v: 'out', l: tr('Punch OUT') }])}
          </div>
          {rows.length > 0 && snap.canEditPunches && <div className="mb-2 flex" data-testid="punch-select"><SelectHead sel={sel} /></div>}
          <PagedList key={[f.worker, f.client, f.date, f.type].join('|')} items={rows} columns render={e => plate(e)}
            empty={<Empty data-testid="punch-empty"><EmptyMedia><IconClipboardText /></EmptyMedia><EmptyTitle>{tr('No punch records found')}</EmptyTitle></Empty>} />
          {snap.loadedFrom && (
            <div className="flex flex-wrap items-center justify-center gap-2 p-2.5 text-xs text-ink-2" data-testid="punch-older">
              <span>{tr('Showing punches from {0}', { 0: snap.loadedFrom })}</span>
              <Button size="sm" data-testid="punch-earlier" onClick={() => void api.loadEarlierPunches()}><IconHistory className="size-4" />{tr('Load earlier month')}</Button>
              <Button size="sm" data-testid="punch-all" onClick={() => void api.loadAllPunches()}>{tr('Load all history')}</Button>
            </div>
          )}
          <SelectBar sel={sel} onDelete={remove} />
        </>
      ) : <ByClient snap={snap} api={api} log={log} plate={plate} />}

      {editing && <PunchWindow key={String(editing.id)} e={editing} snap={snap} api={api} onClose={() => setEditing(null)} />}
      {clearing && <ClearLog months={clearing} api={api} onClose={() => setClearing(null)} />}
    </div>
  );
}

/** By Client: a section per client — its colour, name and address; who is on site now — a plate per assigned worker and its last 5 punches under it. */
function ByClient({ snap, api, log, plate }: { snap: AdminSnapshot; api: ManagerBridge; log: AdminPunch[]; plate: (e: AdminPunch, small?: boolean) => React.ReactNode }) {
  const model = React.useMemo(() => byClient(log, snap.clients, snap.workers), [log, snap.clients, snap.workers]);
  if (!snap.clients.length) return <Empty data-testid="punch-clients-empty"><EmptyTitle>{tr('No clients configured')}</EmptyTitle></Empty>;
  return (
    <div data-testid="punch-clients">
      <PagedList items={model} render={m => {
        const color = snap.clients.find(c => c.id === m.c.id)?.color || 'var(--neutral)';
        const address = snap.clients.find(c => c.id === m.c.id)?.address || '';
        return (
          <Section key={m.c.id} panel data-testid="punch-client" data-cid={m.c.id}
            icon={<span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />}
            label={<span className="inline-flex min-w-0 items-baseline gap-2"><span>{m.c.name}</span>{address && <span className="truncate font-normal text-ink-3">{address}</span>}</span>}
            tools={<span className="shrink-0 text-xs text-ink-2"><span className={cn(m.present && 'text-ok')}>{tr('{0} on site now', { 0: m.present })}</span> · {tr('{0} workers · {1} total punches', { 0: m.rows.length, 1: m.total })}</span>}>
            {m.rows.length ? m.rows.map(r => {
              const status = r.inNow ? tr('In since {0}', { 0: r.last?.time || '' })
                : r.last ? tr('Last: {0} ({1})', { 0: r.last.time, 1: r.last.type === 'in' ? tr('IN') : tr('OUT') }) : tr('No records today');
              return (
                <div key={r.w.id} data-testid="punch-client-worker" data-wid={r.w.id}>
                  <Plate className="mb-1.5" color={r.inNow ? 'var(--ok)' : 'var(--neutral)'} title={r.w.name}
                    sub={<span className={r.inNow ? 'text-ok' : 'text-ink-3'}>{status}</span>}
                    right={<span className="text-[13px] text-ink-2">{tr('{0} records', { 0: r.log.length })}</span>}
                    onOpen={() => api.openWorker(r.w.id)} />
                  <div className="ml-4">{r.log.slice(0, 5).map(e => plate(e, true))}</div>
                </div>
              );
            }) : <Empty><EmptyTitle>{tr('No workers assigned')}</EmptyTitle></Empty>}
          </Section>
        );
      }} />
    </div>
  );
}

/** The punch window: type, time, site (a client, or the stored custom site) and notes. */
function PunchWindow({ e, snap, api, onClose }: { e: AdminPunch; snap: AdminSnapshot; api: ManagerBridge; onClose: () => void }) {
  const custom = !e.clientId && !!e.rawSite;
  const [open, setOpen] = React.useState(true);
  const [type, setType] = React.useState<'in' | 'out'>(e.type);
  const [time, setTime] = React.useState(e.time || '09:00');
  const [site, setSite] = React.useState(e.clientId && snap.clients.some(c => c.id === e.clientId) ? e.clientId : custom ? '__custom__' : '__none__');
  const [notes, setNotes] = React.useState(e.notes || '');
  const close = () => { setOpen(false); window.setTimeout(onClose, 200); };
  const save = () => {
    api.savePunch(String(e.id), { type, time, site: site === '__none__' ? '' : site, notes });
    close();
  };
  return (
    <Window open={open} onOpenChange={o => { if (!o) close(); }}
      title={<span className="inline-flex items-center gap-1.5 [&_svg]:size-5"><IconEdit />{tr('Edit Punch Record')}</span>}
      description={<>{tr('Worker:')} <b className="text-ink">{e.workerName}</b> · {dayOf(e)}</>}
      footer={<Button variant="primary" className="og-save" data-testid="punch-save" onClick={save}>{tr('Save Changes')}</Button>}>
      <div className="grid gap-3" data-testid="punch-window">
        <FieldRow>
          <Field label={tr('Type')} htmlFor="epType">
            <Select value={type} onValueChange={v => setType(v === 'out' ? 'out' : 'in')}>
              <SelectTrigger id="epType" className="w-full" data-testid="punch-type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="in">{tr('Punch IN')}</SelectItem><SelectItem value="out">{tr('Punch OUT')}</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label={tr('Time')} htmlFor="epTime"><Input id="epTime" type="time" data-testid="punch-time-input" value={time} onChange={ev => setTime(ev.target.value)} /></Field>
        </FieldRow>
        <Field label={tr('Site')} htmlFor="epSite">
          <Select value={site} onValueChange={setSite}>
            <SelectTrigger id="epSite" className="w-full" data-testid="punch-site"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{tr('— No site —')}</SelectItem>
              {snap.clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              {custom && <SelectItem value="__custom__">{tr('{0} (custom)', { 0: e.rawSite || '' })}</SelectItem>}
            </SelectContent>
          </Select>
        </Field>
        <Field label={tr('Notes')} htmlFor="epNotes"><Input id="epNotes" data-testid="punch-notes" value={notes} placeholder={tr('Optional note')} onChange={ev => setNotes(ev.target.value)} /></Field>
      </div>
    </Window>
  );
}

/**
 * Clear Log behind the Alert Dialog: whole months (a checklist with their
 * counts), "DELETE" typed to confirm; the page downloads a CSV of exactly those
 * punches first, then deletes them from the database and the cache.
 */
function ClearLog({ months, api, onClose }: { months: { key: string; count: number }[]; api: ManagerBridge; onClose: () => void }) {
  const [open, setOpen] = React.useState(true);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const close = () => { setOpen(false); window.setTimeout(onClose, 200); };
  const label = (k: string) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(uiLocale(), { month: 'long', year: 'numeric' }); };
  const n = months.filter(m => picked.has(m.key)).reduce((t, m) => t + m.count, 0);
  const all = months.every(m => picked.has(m.key));
  const toggle = (k: string, on: boolean) => setPicked(p => { const s = new Set(p); if (on) s.add(k); else s.delete(k); return s; });
  const go = async (ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!picked.size || confirm !== 'DELETE' || busy) return;
    setBusy(true);
    const ok = await api.clearPunchMonths([...picked]);
    setBusy(false);
    if (ok) close();
  };
  return (
    <AlertDialog open={open} onOpenChange={o => { if (!o) close(); }}>
      <AlertDialogContent data-testid="clear-log">
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('Clear punch log')}</AlertDialogTitle>
          <AlertDialogDescription>{tr('Selected months are deleted permanently from the database (including the archive). A CSV backup of the deleted records is downloaded first.')}</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold">
          <Checkbox checked={all} data-testid="clear-all" onCheckedChange={c => setPicked(c === true ? new Set(months.map(m => m.key)) : new Set())} />{tr('Select all')}
        </label>
        <div className="max-h-[260px] overflow-y-auto rounded-[var(--radius-sm)] border border-border px-2.5 py-1">
          {months.map(m => (
            <label key={m.key} className="flex cursor-pointer items-center justify-between gap-2 py-1.5 text-[13px]" data-testid="clear-month" data-k={m.key}>
              <span className="flex items-center gap-2"><Checkbox checked={picked.has(m.key)} onCheckedChange={c => toggle(m.key, c === true)} />{label(m.key)}</span>
              <span className="text-xs text-ink-3">{recordsText(m.count)}</span>
            </label>
          ))}
        </div>
        <Field label={tr('Type DELETE to confirm')} htmlFor="clearLogConfirm">
          <Input id="clearLogConfirm" autoComplete="off" data-testid="clear-confirm" value={confirm} onChange={ev => setConfirm(ev.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('Cancel')}</AlertDialogCancel>
          <AlertDialogAction danger data-testid="clear-submit" disabled={!picked.size || confirm !== 'DELETE' || busy} onClick={ev => void go(ev)}>
            <IconTrash className="size-4" />{busy ? tr('Deleting…') : picked.size ? tr('Delete') + ' · ' + recordsText(n) : tr('Delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
