// The firm's data the app holds: workers, clients, suppliers, and whether the
// first load has ended. One copy, here; the page reads and replaces them by
// their old global names (window accessors, global.ts).
import { uid, genToken } from './ids';
import { host } from './events';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Rec = Record<string, any>;

export const state = {
  workers: [] as Rec[],
  clients: [] as Rec[],
  // Suppliers: {id,name,color,phone,notes,bank,bankBranch,accountNumber,
  // companyNumber}. A worker is linked via w.supplierId (one supplier; a
  // worker can work for several clients, w.clientIds).
  suppliers: [] as Rec[],
  /** the first load (cache or server) has ended */
  ready: false,
};

/** What is saved and cached: the three lists, the week on screen, the time. */
export function getDataObj(): Rec {
  return {workers: state.workers, clients: state.clients, suppliers: state.suppliers, weekStart: host.weekStart(), savedAt: new Date().toISOString()};
}

/** A worker as the app holds it (applyData): the fields every worker has. */
export function normWorker(w: Rec): Rec {
  return {id: w.id || uid(), clientIds: w.clientIds || [], token: w.token || genToken(), status: w.status || 'active', ...w};
}
export function applyData(d: Rec): void {
  if (d.workers) state.workers = d.workers.map(normWorker);
  if (d.clients) state.clients = d.clients;
  if (d.suppliers) state.suppliers = d.suppliers;
  // d.weekStart (the week that was on screen at the last save) is deliberately
  // NOT restored — the Weekly Schedule always opens on the current week, and a
  // background re-load mustn't yank the manager off a week they navigated to.
  // The weekly roster is per weekday (w.schedule[0..6]); a change for one
  // date only lives in w.dateShifts, so the week shown picks those up.
}
