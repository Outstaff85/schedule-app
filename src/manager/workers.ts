// The Workers tab's list rules (docs/workers.md → Workers tab), as the old
// renderWorkersPage had them: the filters (all combine), the search, the
// grouping and a plate's bar colour.
import type { WorkerRow, WorkersSnapshot } from './bridge';

export type StatusFilter = '' | 'active' | 'vacation' | 'fired' | 'all';
export type DocsFilter = '' | 'incomplete' | 'expiring';
export type GroupBy = '' | 'client' | 'supplier';
export type Filters = { q: string; status: StatusFilter; docs: DocsFilter; client: string; supplier: string; group: GroupBy };
export const NO_FILTERS: Filters = { q: '', status: '', docs: '', client: '', supplier: '', group: '' };

export const isActive = (w: WorkerRow) => w.status !== 'fired';

/** Search: the name (and the names from the document), phone, the worker's clients (name and object), and the ID / passport number from 2 characters, spaces and dashes ignored. */
export function matches(w: WorkerRow, q: string, clients: WorkersSnapshot['clients']) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  const qNum = q.replace(/[\s-]/g, '');
  const objNames = w.clientIds.map(id => { const c = clients.find(x => x.id === id); return c ? (c.name || '') + ' ' + (c.object || '') : ''; }).join(' ');
  const text = [w.name, w.docGiven, w.docSurname, w.phone, objNames].join(' ').toLowerCase();
  const docNo = String(w.docId || '').toLowerCase().replace(/[\s-]/g, '');
  return text.includes(q) || (qNum.length >= 2 && docNo.includes(qNum));
}

export function filterWorkers(list: WorkerRow[], f: Filters, clients: WorkersSnapshot['clients']) {
  return list.filter(w => {
    if (!f.status) { if (!isActive(w)) return false; }
    else if (f.status !== 'all' && (w.status || 'active') !== f.status) return false;
    if (f.client && !w.clientIds.includes(f.client)) return false;
    if (f.supplier && w.supplierId !== f.supplier) return false;
    if (f.docs === 'incomplete' && w.docLevel === 'ok') return false;
    if (f.docs === 'expiring' && !w.docExpiring) return false;
    return matches(w, f.q, clients);
  });
}

export type Group = { key: string; name: string; color?: string; items: WorkerRow[] };
/** By client a worker appears under every client they have; by supplier under one ("No supplier assigned" when none). */
export function groupWorkers(list: WorkerRow[], by: GroupBy, snap: Pick<WorkersSnapshot, 'clients' | 'suppliers'>): Group[] {
  if (!by) return [{ key: '', name: '', items: list }];
  const groups: Group[] = by === 'client'
    ? [...snap.clients.map(c => ({ key: c.id, name: c.name, color: c.color, items: list.filter(w => w.clientIds.includes(c.id)) })),
      { key: '-', name: 'No client assigned', items: list.filter(w => !w.clientIds.length) }]
    : [...snap.suppliers.map(s => ({ key: s.id, name: s.name, color: s.color, items: list.filter(w => w.supplierId === s.id) })),
      { key: '-', name: 'No supplier assigned', items: list.filter(w => !w.supplierId) }];
  return groups.filter(g => g.items.length);
}

/** The plate's bar: red inactive or an urgent notice, amber on vacation or with a notice, green otherwise. */
export function barColor(w: WorkerRow) {
  if (!isActive(w) || w.notices.some(n => n.lvl === 'red')) return 'var(--red)';
  return w.status === 'vacation' || w.notices.length ? 'var(--amber)' : 'var(--green)';
}
