// The bridge between the manager app (schedule-manager.html, an old page until
// its stage moves it) and its React pieces (docs/build.md → The manager's React
// pieces). The page sets `window.ManagerBridge` before this module loads; a
// piece reads the page's data and runs the page's actions only through it.
// The data comes already worked out by the page's own functions where those
// still belong to a tab that has not moved (a worker's notices, today's shift,
// the punch's site), so nothing is computed twice.
import type { Punch } from '@/lib/payroll';

export type Notice = { lvl: 'red' | 'amber'; word: string; title: string };
/** A worker today: on vacation, the latest punch (in / out), no punch on a started shift, or nothing. */
export type WorkerToday = { k: '' | 'in' | 'out' | 'none' | 'vac'; time?: string };
export type Shift = { type: string; start?: string; end?: string } | null;

export type BridgeWorker = {
  id: string;
  name: string;
  active: boolean;
  supplierId?: string;
  /** the worker's first client */
  site: string;
  /** today's shift (`shiftOn`: the roster or a change for this date) */
  shift: Shift;
  today: WorkerToday;
  /** urgent first (`workerNotices`) */
  notices: Notice[];
};

export type BridgePunch = Punch & {
  workerId: string;
  workerName: string;
  type: 'in' | 'out';
  time: string;
  /** the site shown for the punch (`punchSite`) */
  site: string;
  gpsSuspicious?: boolean;
};

export type TodaySnapshot = {
  /** false until the page has drawn its data once (the cache or the server) */
  ready: boolean;
  workers: BridgeWorker[];
  suppliers: { id: string; name: string; color?: string }[];
  /** today's punches, as stored */
  log: BridgePunch[];
  /** the login may add workers (the `workers` section) */
  canAddWorker: boolean;
};

export type ManagerBridge = {
  /** the page's language and its loaded dictionary (`I18N_LANG`, `I18N`) */
  lang(): string;
  dict(): Record<string, string>;
  today(): TodaySnapshot;
  openWorker(id: string): void;
  openNotices(id: string): void;
  openSuppliers(): void;
  addWorker(): void;
  /** reads the punches again from the server */
  refresh(): Promise<void>;
};

declare global {
  interface Window {
    ManagerBridge?: ManagerBridge;
    ManagerIsland?: { renderToday(): void };
  }
}

export function bridge(): ManagerBridge {
  const b = window.ManagerBridge;
  if (!b) throw new Error('ManagerBridge missing');
  return b;
}
