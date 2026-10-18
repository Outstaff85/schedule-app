// The Clients and Suppliers tabs of the manager app (docs/clients.md → Clients
// tab, docs/suppliers.md → Suppliers tab), drawn in React inside the old page
// (stage 6d): New, Select, and a plate per client / supplier — its colour as
// the bar, the name (a client's notices: No rate, Hours waiting), "N workers ·
// address / phone", this month's hours, ⋮ and a swipe. A tap, a double click
// or a long press opens its window (no card to read first). Delete never asks
// (Undo); the record goes when its time is up (the page's delete).
import * as React from 'react';
import { IconAlertTriangle, IconBuilding, IconClock, IconPlus, IconTruckDelivery } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Plate, type PlateAction } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { ClientRow, ClientsSnapshot, ManagerBridge, SupplierRow, SuppliersSnapshot } from './bridge';
import { Line } from './pieces';
import { hoursShort } from './today';

// Deleted here and still inside their Undo time: left out of the list.
const hiddenClients = new Set<string>();
const hiddenSuppliers = new Set<string>();

/** Delete from a window's ⋮ (the window already closed unsaved): the plate goes behind the Undo snack, the record when its time is up. */
export function deleteLater(kind: 'clients' | 'suppliers', id: string, name: string, api: ManagerBridge) {
  const hidden = kind === 'clients' ? hiddenClients : hiddenSuppliers;
  const redraw = () => (kind === 'clients' ? window.ManagerIsland?.renderClients() : window.ManagerIsland?.renderSuppliers());
  hidden.add(id); redraw();
  undoDelete(name,
    () => { hidden.delete(id); if (kind === 'clients') api.deleteClients([id]); else api.deleteSuppliers([id]); },
    () => { hidden.delete(id); redraw(); });
}

/**
 * A plate that only opens its window (no card to read first): with a mouse a
 * single click waits for a possible double click, so a
 * double click opens the window once and its second click doesn't land on the
 * backdrop; a touch opens at once.
 */
export function useTapOpen(open: (id: string) => void) {
  const ptr = React.useRef('mouse');
  const timer = React.useRef(0);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  return (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => { ptr.current = e.pointerType; },
    onOpen: () => {
      window.clearTimeout(timer.current);
      if (ptr.current === 'mouse') timer.current = window.setTimeout(() => open(id), 250); else open(id);
    },
    onEdit: () => { window.clearTimeout(timer.current); open(id); },
  });
}

const workersText = (n: number) => (n === 1 ? tr('1 worker{1}', { 1: '' }) : tr('{0} workers{1}', { 0: n, 1: '' }));

function Loading({ id }: { id: string }) {
  return (
    <div data-testid={id} aria-busy="true" className="grid gap-2">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-x-3 gap-y-1.5 min-[701px]:grid-cols-2 min-[1100px]:grid-cols-3">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[62px]" />)}</div>
    </div>
  );
}

/** The list both tabs share: New and Select above, the plates paged by 10, the bulk bar, Undo. */
function Directory<R extends { id: string; name: string }>({ kind, rows, canEdit, onNew, render, onDelete, empty, many }: {
  kind: 'clients' | 'suppliers';
  rows: R[];
  canEdit: boolean;
  onNew: () => void;
  render: (r: R, sel: { on: boolean; picked: boolean; toggle: () => void }, remove: (ids: string[]) => void) => React.ReactNode;
  onDelete: (ids: string[]) => void;
  empty: React.ReactNode;
  /** "N clients" for the snack of a bulk Delete */
  many: (n: number) => string;
}) {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const hidden = kind === 'clients' ? hiddenClients : hiddenSuppliers;
  const list = rows.filter(r => !hidden.has(r.id));
  const ids = React.useMemo(() => list.map(r => r.id), [list.map(r => r.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = useSelection(ids);

  const remove = (which: string[]) => {
    which = which.filter(id => rows.some(r => r.id === id));
    if (!which.length) return;
    which.forEach(id => hidden.add(id)); redraw();
    const one = which.length === 1 ? rows.find(r => r.id === which[0]) : null;
    undoDelete(one ? one.name : many(which.length),
      () => { which.forEach(id => hidden.delete(id)); onDelete(which); },
      () => { which.forEach(id => hidden.delete(id)); redraw(); });
  };

  return (
    <div data-testid={kind}>
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid={kind + '-head'}>
        <Button variant="primary" className="og-new" data-testid={kind + '-new'} onClick={onNew}><IconPlus />{tr('New')}</Button>
        {canEdit && list.length > 0 && <div className="flex" data-testid={kind + '-select'}><SelectHead sel={sel} /></div>}
      </div>
      {list.length
        ? <PagedList items={list} columns render={r => render(r, { on: sel.on, picked: sel.picked.has(r.id), toggle: () => sel.toggle(r.id) }, remove)} />
        : empty}
      <SelectBar sel={sel} onDelete={canEdit ? remove : undefined} />
    </div>
  );
}

export function Clients({ snap, api }: { snap: ClientsSnapshot; api: ManagerBridge }) {
  const tap = useTapOpen(id => api.openClient(id));
  if (!snap.ready) return <Loading id="clients-loading" />;
  const can = snap.canEdit;
  const plate = (c: ClientRow, sel: { on: boolean; picked: boolean; toggle: () => void }, remove: (ids: string[]) => void) => {
    const actions: PlateAction[] = [{ label: tr('Manual punch'), icon: <IconClock />, onSelect: () => api.manualPunch(c.id) }];
    return (
      <Plate key={c.id} data-testid="client-plate" data-cid={c.id} className="mb-1.5" color={c.color || 'var(--neutral)'}
        title={<span title={c.name} data-testid="client-name">{c.name}</span>}
        chips={<>
          {c.noRate && <Badge variant="warn" data-testid="client-norate"><IconAlertTriangle />{tr('No rate')}</Badge>}
          {c.waiting && <Badge variant="warn" data-testid="client-waiting"><IconClock />{tr('Hours waiting')}</Badge>}
        </>}
        sub={<Line parts={[workersText(c.workers), c.address || c.object]} />}
        right={<span data-testid="client-hours">{hoursShort(c.monthHours)}</span>}
        actions={actions}
        {...tap(c.id)}
        onDelete={can ? () => remove([c.id]) : undefined}
        selecting={sel.on} selected={sel.picked} onToggle={sel.toggle} />
    );
  };
  return (
    <Directory kind="clients" rows={snap.clients} canEdit={can} onNew={() => api.openClient(null)} render={plate}
      onDelete={ids => api.deleteClients(ids)} many={n => tr('{0} clients', { 0: n })}
      empty={(
        <Empty data-testid="clients-empty" className="mx-auto max-w-md">
          <EmptyMedia><IconBuilding /></EmptyMedia>
          <EmptyTitle>{tr('No clients yet')}</EmptyTitle>
          <EmptyDescription>{tr('A client is a site your workers punch in at: its place, its rates and its logins.')}</EmptyDescription>
          <EmptyContent><Button variant="primary" className="og-new" onClick={() => api.openClient(null)}><IconPlus />{tr('Add the first client')}</Button></EmptyContent>
        </Empty>
      )} />
  );
}

export function Suppliers({ snap, api }: { snap: SuppliersSnapshot; api: ManagerBridge }) {
  const tap = useTapOpen(id => api.openSupplier(id));
  if (!snap.ready) return <Loading id="suppliers-loading" />;
  const can = snap.canEdit;
  const plate = (s: SupplierRow, sel: { on: boolean; picked: boolean; toggle: () => void }, remove: (ids: string[]) => void) => (
    <Plate key={s.id} data-testid="supplier-plate" data-sid={s.id} className="mb-1.5" color={s.color || 'var(--neutral)'}
      title={<span title={s.name} data-testid="supplier-name">{s.name}</span>}
      sub={<Line parts={[workersText(s.workers), s.phone]} />}
      right={<span data-testid="supplier-hours">{hoursShort(s.monthHours)}</span>}
      {...tap(s.id)}
      onDelete={can ? () => remove([s.id]) : undefined}
      selecting={sel.on} selected={sel.picked} onToggle={sel.toggle} />
  );
  return (
    <Directory kind="suppliers" rows={snap.suppliers} canEdit={can} onNew={() => api.openSupplier(null)} render={plate}
      onDelete={ids => api.deleteSuppliers(ids)} many={n => tr('{0} suppliers', { 0: n })}
      empty={(
        <Empty data-testid="suppliers-empty" className="mx-auto max-w-md">
          <EmptyMedia><IconTruckDelivery /></EmptyMedia>
          <EmptyTitle>{tr('No suppliers yet')}</EmptyTitle>
          <EmptyDescription>{tr('A supplier is a staffing agency your workers come through: its details, its commission and its portal logins.')}</EmptyDescription>
          <EmptyContent><Button variant="primary" className="og-new" onClick={() => api.openSupplier(null)}><IconPlus />{tr('Add the first supplier')}</Button></EmptyContent>
        </Empty>
      )} />
  );
}
