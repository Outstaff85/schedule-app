// The Workers tab of the manager app (docs/workers.md → Workers tab), drawn in
// React inside the old page (stage 6c-1): one create button (New worker: a scan,
// its menu also adds by hand), the search, the Filters (status, documents,
// client, supplier, group by — each set one a chip under the search), the
// cards / list toggle, "Inactive: N — show", Select (Vacation / Active /
// Delete) and the workers as plates (or a table on a computer's list view).
// A plate's tap opens the worker card, a double click / long press the edit
// form — both still the page's (ManagerBridge); Delete never asks (Undo).
import * as React from 'react';
import {
  IconAlertTriangle, IconBeach, IconCash, IconChevronDown, IconChevronUp, IconCircleCheck, IconDownload, IconFilter, IconId, IconLayoutGrid, IconLink, IconList,
  IconScan, IconTransfer, IconTrash, IconUserPlus, IconUsers, IconX,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Plate, type PlateAction } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { NewBadge } from '@/components/shared/new-badge';
import { SelectBar, SelectRow, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { ManagerBridge, WorkerRow, WorkersSnapshot } from './bridge';
import { TransferAskWindow } from './TransferAsk';
import { isFirmAdminSession } from './logic/access';
import { Line, MoreChip, NoticeChip, TodayPin } from './pieces';
import { hoursShort } from './today';
import {
  NO_FILTERS, barColor, filterWorkers, groupWorkers, isActive,
  type DocsFilter, type Filters, type GroupBy, type StatusFilter,
} from './workers';

// The filters stay while the app is open (the tab is drawn again on every
// render() and on a language change); the view and the Filters' open state
// are kept on this device, as on the old tab.
let kept: Filters = NO_FILTERS;
// Workers deleted here and still inside their Undo time: left out of the list.
const hidden = new Set<string>();
const ANY = '*';

function stored(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function store(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }

const STATUS_OPTS: [StatusFilter, string][] = [['', 'Active and on vacation'], ['active', 'Active'], ['vacation', 'On vacation'], ['fired', 'Inactive'], ['all', 'All statuses']];
const DOCS_OPTS: [DocsFilter, string][] = [['', 'All documents'], ['incomplete', 'Documents incomplete'], ['expiring', 'ID expired / expiring']];
const GROUP_OPTS: [GroupBy, string][] = [['', 'No grouping'], ['client', 'Group by client'], ['supplier', 'Group by supplier']];
const STATUS_BADGE = { active: ['ok', 'Active'], vacation: ['warn', 'On vacation'], fired: ['bad', 'Inactive'] } as const;

function Loading() {
  return (
    <div data-testid="workers-loading" aria-busy="true" className="grid gap-2">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-10" />
      <div className="grid gap-x-3 gap-y-1.5 min-[701px]:grid-cols-2 min-[1100px]:grid-cols-3">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-[62px]" />)}</div>
    </div>
  );
}

/** A filter: its caption over a select (no caption on a phone — the first option names it). */
function FilterSelect<V extends string>({ id, cap, value, opts, onChange, className }: {
  id: string; cap: string; value: V; opts: [V, string][]; onChange: (v: V) => void; className?: string;
}) {
  return (
    <label className={cn('grid min-w-0 gap-1', className)}>
      <span className="og-label max-[700px]:hidden">{cap}</span>
      <Select value={value || ANY} onValueChange={v => onChange((v === ANY ? '' : v) as V)}>
        <SelectTrigger data-testid={id} className={cn('w-full', value && 'border-info text-info')}><SelectValue /></SelectTrigger>
        <SelectContent>{opts.map(([v, l]) => <SelectItem key={v || ANY} value={v || ANY}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}

export function Workers({ snap, api }: { snap: WorkersSnapshot; api: ManagerBridge }) {
  const [transfer, setTransfer] = React.useState(false);
  const [f, setF] = React.useState<Filters>(kept);
  const [view, setView] = React.useState<'cards' | 'list'>(() => (stored('workersView') === 'list' ? 'list' : 'cards'));
  const [open, setOpen] = React.useState(() => !!stored('workersFiltersOpen'));
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const set = (next: Partial<Filters>) => setF(cur => (kept = { ...cur, ...next }));

  const all = React.useMemo(() => snap.workers.filter(w => !hidden.has(w.id)), [snap.workers, hidden.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = React.useMemo(() => filterWorkers(all, f, snap.clients), [all, f, snap.clients]);
  const groups = React.useMemo(() => groupWorkers(list, f.group, snap), [list, f.group, snap]);
  const ids = React.useMemo(() => list.map(w => w.id), [list]);
  const sel = useSelection(ids);
  const inactiveN = snap.workers.filter(w => !isActive(w)).length;
  const clientOf = React.useMemo(() => new Map(snap.clients.map(c => [c.id, c])), [snap.clients]);
  const supplierOf = React.useMemo(() => new Map(snap.suppliers.map(s => [s.id, s])), [snap.suppliers]);

  if (!snap.ready) return <Loading />;

  const can = snap.canEdit;
  const cards = view === 'cards';
  const pickView = (v: 'cards' | 'list') => { store('workersView', v); setView(v); if (v !== 'cards') sel.end(); };
  const toggleOpen = () => { store('workersFiltersOpen', open ? '' : '1'); setOpen(!open); };

  const remove = (which: string[]) => {
    which = which.filter(id => snap.workers.some(w => w.id === id));
    if (!which.length) return;
    which.forEach(id => hidden.add(id)); redraw();
    const one = which.length === 1 ? snap.workers.find(w => w.id === which[0]) : null;
    undoDelete(one ? one.name : tr('{0} workers{1}', { 0: which.length, 1: '' }),
      () => { which.forEach(id => hidden.delete(id)); api.deleteWorkers(which); },
      () => { which.forEach(id => hidden.delete(id)); redraw(); });
  };

  const chips: { key: keyof Filters; text: string }[] = [];
  const optText = <V extends string>(opts: [V, string][], v: V) => tr(opts.find(o => o[0] === v)?.[1] || v);
  if (f.status) chips.push({ key: 'status', text: optText(STATUS_OPTS, f.status) });
  if (f.docs) chips.push({ key: 'docs', text: optText(DOCS_OPTS, f.docs) });
  if (f.client) chips.push({ key: 'client', text: clientOf.get(f.client)?.name || f.client });
  if (f.supplier) chips.push({ key: 'supplier', text: supplierOf.get(f.supplier)?.name || f.supplier });
  if (f.group) chips.push({ key: 'group', text: optText(GROUP_OPTS, f.group) });

  const menu = (w: WorkerRow): PlateAction[] => [
    { label: tr('Open card'), icon: <IconId />, onSelect: () => api.openWorker(w.id) },
    ...(w.canPay ? [{ label: tr('Pay'), icon: <IconCash />, onSelect: () => api.openPay(w.id) }] : []),
    ...(can ? [{ label: tr('Punch link'), icon: <IconLink />, onSelect: () => api.copyLink(w.id) }] : []),
  ];

  const plate = (w: WorkerRow) => (
    <Plate key={w.id} data-testid="worker-plate" data-wid={w.id} className="mb-1.5"
      color={barColor(w)}
      title={<span title={w.name} data-testid="worker-name">{w.name}</span>}
      chips={<NewBadge createdAt={w.createdAt} />}
      sub={<>
        {/* every plate keeps the chip row and the site line, empty or not: the plates stand the same height (owner,
            2026-10-27). Two notices are shown, the others in +N (owner, 2026-10-31). */}
        {w.notices.length > 0
          ? <span className="mb-0.5 mt-[3px] flex items-center gap-1" data-testid="worker-chip1">
              {w.notices.slice(0, 2).map((n, i) => <NoticeChip key={i} n={n} onOpen={() => api.openNotices(w.id)} />)}
              <MoreChip n={w.notices.length - 2} onOpen={() => api.openNotices(w.id)} />
            </span>
          : <span className="invisible mb-0.5 mt-[3px] flex" aria-hidden data-testid="worker-chip-space"><Badge variant="warn"><IconAlertTriangle />—</Badge></span>}
        <span className="block min-h-[1lh]"><Line parts={[w.site, <TodayPin key="p" w={w} />]} /></span>
      </>}
      right={<span data-testid="worker-hours">{hoursShort(w.monthHours)}</span>}
      actions={menu(w)}
      onOpen={() => api.openWorker(w.id)}
      onEdit={can ? () => api.editWorker(w.id) : undefined}
      onDelete={can ? () => remove([w.id]) : undefined}
      selecting={sel.on} selected={sel.picked.has(w.id)} onToggle={() => sel.toggle(w.id)} />
  );

  const dot = (color?: string) => color ? <span className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: color }} /> : null;
  const columns: DataColumn<WorkerRow>[] = [
    { id: 'worker', header: tr('Worker'), accessorFn: w => w.name, sortFn: 'alphanumeric', cell: c => {
      const w = c.row.original;
      return (
        <span className="inline-flex items-center gap-1.5">
          <b className="font-semibold">{w.name}</b><NewBadge createdAt={w.createdAt} />
          {w.contract && <Badge variant={w.contract.overdue ? 'bad' : 'warn'} title={tr('Deadline: {0}', { 0: w.contract.deadline })}>{w.contract.overdue ? tr('EXPIRED') : tr('EXPIRING SOON')}</Badge>}
          {w.docBadge && <Badge variant={w.docLevel === 'error' ? 'bad' : 'warn'} title={w.docLines.join(' · ')}>{w.docBadge}</Badge>}
        </span>
      );
    } },
    { id: 'status', header: tr('Status'), accessorFn: w => w.status, cell: c => { const [v, l] = STATUS_BADGE[c.row.original.status] || STATUS_BADGE.active; return <Badge variant={v}>{tr(l)}</Badge>; } },
    { id: 'doc', header: tr('ID / Passport'), accessorFn: w => w.docId, cell: c => <span className="font-mono text-ink-2">{c.row.original.docId || '—'}</span> },
    { id: 'objects', header: tr('Objects'), enableSorting: false, accessorFn: w => w.clientIds.join(), cell: c => {
      const objs = c.row.original.clientIds.map(id => clientOf.get(id)).filter(Boolean);
      return objs.length ? <span className="inline-flex flex-wrap gap-1">{objs.map(o => <Badge key={o!.id} className="text-ink">{dot(o!.color)}{o!.name}</Badge>)}</span> : <span className="text-ink-3">—</span>;
    } },
    { id: 'supplier', header: tr('Supplier'), accessorFn: w => supplierOf.get(w.supplierId)?.name || '', cell: c => {
      const s = supplierOf.get(c.row.original.supplierId);
      return s ? <Badge className="text-ink">{dot(s.color)}{s.name}</Badge> : <span className="text-ink-3">—</span>;
    } },
    { id: 'phone', header: tr('Phone'), accessorFn: w => w.phone, cell: c => <span className="text-ink-2">{c.row.original.phone || '—'}</span> },
    { id: 'start', header: tr('Start date'), accessorFn: w => w.startDate, cell: c => <span className="text-ink-2">{c.row.original.startDate ? new Date(c.row.original.startDate + 'T00:00').toLocaleDateString('en-GB') : '—'}</span> },
    { id: 'acts', header: tr('Actions'), enableSorting: false, cell: c => {
      const w = c.row.original;
      return (
        <span className="inline-flex gap-1">
          {w.docUrl && <Button asChild size="icon-sm"><a href={w.docUrl} target="_blank" rel="noopener" title={tr('Download the document (PDF from {0})', { 0: 'Firebase Storage' })} aria-label={tr('Download the document (PDF from {0})', { 0: 'Firebase Storage' })}><IconDownload className="size-4" /></a></Button>}
          {can && <Button size="icon-sm" variant="danger" aria-label={tr('Delete')} data-testid="worker-row-delete" onClick={() => remove([w.id])}><IconTrash className="size-4" /></Button>}
        </span>
      );
    } },
  ];

  const body = (items: WorkerRow[]) => cards
    ? <PagedList items={items} columns render={plate} />
    : <DataTable data-testid="workers-table" columns={columns} data={items} rowId={w => w.id} card={plate}
        onRowOpen={w => api.openWorker(w.id)} onRowEdit={can ? w => api.editWorker(w.id) : undefined} />;

  const noneAtAll = !snap.workers.length;

  return (
    <div data-testid="workers">
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="workers-head">
        {can && (
          // One create button (owner, 2026-10-26): its main part scans a new worker's passport / ID, its menu
          // adds a worker by hand, or from another firm (owner, 2026-10-31; Filters stand at the right of this line).
          <ButtonGroup attached data-testid="workers-create">
            <Button variant="primary" className="og-new" data-testid="workers-new" title={tr('Scan a passport / ID')} onClick={api.scanNew}><IconScan />{tr('New worker')}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="primary" className="og-new" size="icon" data-testid="workers-new-more" aria-label={tr('More ways to add a worker')}><IconChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem data-testid="workers-new-hand" onSelect={api.addWorker}><IconUserPlus />{tr('Enter by hand')}</DropdownMenuItem>
                {isFirmAdminSession() && <DropdownMenuItem data-testid="workers-transfer" onSelect={() => setTransfer(true)}><IconTransfer />{tr('From another firm')}</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        )}
        <Button data-testid="workers-filters-btn" aria-expanded={open} className={cn('ml-auto', open && 'border-info text-info')} onClick={toggleOpen}>
          <IconFilter />{tr('Filters')}
          {chips.length > 0 && <span data-testid="workers-filters-n" className="rounded-full bg-info px-1.5 font-mono text-[11px] text-[#fff]">{chips.length}</span>}
          {open ? <IconChevronUp /> : <IconChevronDown />}
        </Button>
      </div>
      {transfer && <TransferAskWindow onClose={() => setTransfer(false)} toast={(m, ms) => api.toast(m, ms)} />}

      <div className="mb-3.5 grid gap-2">
        <div className="flex items-stretch gap-2">
          <Input data-testid="workers-search" className="min-w-0 flex-1" value={f.q} onChange={e => set({ q: e.target.value })}
            placeholder={tr('Search: name, ID / passport, phone, client...')} />
          <ToggleGroup type="single" value={view} onValueChange={v => { if (v) pickView(v as 'cards' | 'list'); }} aria-label={tr('Layout')} data-testid="workers-view">
            <ToggleGroupItem value="list" aria-label={tr('List')} title={tr('List')}><IconList /></ToggleGroupItem>
            <ToggleGroupItem value="cards" aria-label={tr('Cards')} title={tr('Cards')}><IconLayoutGrid /></ToggleGroupItem>
          </ToggleGroup>
        </div>
        {open && (
          <div data-testid="workers-filters" className="grid grid-cols-2 gap-2 min-[701px]:grid-cols-5">
            <FilterSelect id="wf-status" cap={tr('Status')} value={f.status} opts={STATUS_OPTS.map(([v, l]) => [v, tr(l)])} onChange={v => set({ status: v })} />
            <FilterSelect id="wf-docs" cap={tr('Documents')} value={f.docs} opts={DOCS_OPTS.map(([v, l]) => [v, tr(l)])} onChange={v => set({ docs: v })} />
            <FilterSelect id="wf-client" cap={tr('Client')} value={f.client} opts={[['', tr('All clients')], ...snap.clients.map(c => [c.id, c.name] as [string, string])]} onChange={v => set({ client: v })} />
            <FilterSelect id="wf-supplier" cap={tr('Supplier')} value={f.supplier} opts={[['', tr('All suppliers')], ...snap.suppliers.map(s => [s.id, s.name] as [string, string])]} onChange={v => set({ supplier: v })} />
            <FilterSelect id="wf-group" cap={tr('Group by')} className="max-[700px]:col-span-2" value={f.group} opts={GROUP_OPTS.map(([v, l]) => [v, tr(l)])} onChange={v => set({ group: v })} />
          </div>
        )}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="workers-chips">
            {chips.map(c => (
              <Badge key={c.key} asChild variant="info">
                <button type="button" data-key={c.key} title={tr('Clear this filter')} onClick={() => set({ [c.key]: '' } as Partial<Filters>)}>{c.text}<IconX /></button>
              </Badge>
            ))}
          </div>
        )}
        {!f.status && inactiveN > 0 && (
          <button type="button" data-testid="workers-inactive" className="w-fit text-xs text-ink-2 underline underline-offset-2" onClick={() => set({ status: 'fired' })}>
            {tr('Inactive: {n} — show', { n: inactiveN })}
          </button>
        )}
      </div>

      {noneAtAll ? (
        <Empty data-testid="workers-empty" className="mx-auto max-w-md">
          <EmptyMedia><IconUsers /></EmptyMedia>
          <EmptyTitle>{tr('No workers yet')}</EmptyTitle>
          <EmptyDescription>{tr('Add a worker by hand or scan a passport / ID.')}</EmptyDescription>
          {can && <EmptyContent><Button variant="primary" className="og-new" onClick={api.addWorker}><IconUserPlus />{tr('Add the first worker')}</Button></EmptyContent>}
        </Empty>
      ) : !list.length ? (
        <div data-testid="workers-none" className="rounded-[14px] border border-dashed border-white/20 px-3 py-6 text-center text-sm text-ink-2">{tr('No workers found')}</div>
      ) : (
        <>
          {can && cards && <SelectRow sel={sel} testid="workers-select" />}
          {groups.map(g => g.key
            ? <Section key={g.key} label={g.name === 'No client assigned' || g.name === 'No supplier assigned' ? tr(g.name) : g.name} count={g.items.length} icon={dot(g.color)} data-testid="workers-group">{body(g.items)}</Section>
            : <React.Fragment key="all">{body(g.items)}</React.Fragment>)}
        </>
      )}

      <SelectBar sel={sel} onDelete={can ? remove : undefined}>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-vacation" onClick={() => { api.setStatus([...sel.picked], 'vacation'); sel.end(); }}><IconBeach className="size-4" />{tr('Vacation')}</Button>
        <Button size="sm" disabled={!sel.picked.size} data-testid="sel-active" onClick={() => { api.setStatus([...sel.picked], 'active'); sel.end(); }}><IconCircleCheck className="size-4" />{tr('Active')}</Button>
      </SelectBar>
    </div>
  );
}

