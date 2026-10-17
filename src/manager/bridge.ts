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

/** A day of the roster (`w.schedule[0..6]`, Sunday first) or a change for one date (`w.dateShifts`). */
export type DayShift = { type: 'work' | 'off'; start?: string | null; end?: string | null };

export type SchedWorker = {
  id: string;
  name: string;
  /** 'active' | 'vacation' (inactive workers are not sent) */
  status: string;
  clientIds: string[];
  /** the worker's first client */
  site: string;
  schedule: DayShift[];
  dateShifts: Record<string, DayShift>;
};

/** A worker's request from the punch page (`tenants/{t}/shiftRequests`, stage 5b). */
export type ShiftRequest = {
  id: string;
  kind: 'unavailable' | 'swap';
  workerId: string;
  workerName?: string;
  toWorkerId?: string;
  toWorkerName?: string;
  /** YYYY-MM-DD */
  date: string;
  start?: string;
  end?: string;
  note?: string;
  status: string;
};

export type ScheduleSnapshot = {
  ready: boolean;
  /** the shown week's Sunday, YYYY-MM-DD (the page's `weekStart`) */
  weekStart: string;
  /** the site filter (the page's `selectedClientId`, shared with the side panel) */
  clientId: string | null;
  /** the active workers, in the page's order */
  workers: SchedWorker[];
  clients: { id: string; name: string; color?: string }[];
  /** the workers' requests from today on (`loadShiftRequests`) */
  requests: ShiftRequest[];
  /** the login has the `schedule` section: edit shifts, confirm requests, copy weeks */
  canEdit: boolean;
  /** the `exports` section */
  canExport: boolean;
  canAddWorker: boolean;
};

/** One date of one worker: a shift for that date only, or null to drop the change. */
export type DatedChange = { workerId: string; date: string; shift: DayShift | null };

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

  // ── Schedule (stage 6b) ──
  schedule(): ScheduleSnapshot;
  /** shows the week starting that Sunday (YYYY-MM-DD) */
  setWeek(ymd: string): void;
  /** the site filter (null: all sites) */
  setClient(id: string | null): void;
  /** a shift for every <weekday> (`week`: the roster, a change of that date dropped) or for that date only (`date`); saved */
  setShift(workerId: string, date: string, scope: 'week' | 'date', shift: DayShift): void;
  /** several one-date changes at once (Copy last week, Repeat, their Undo); saved */
  applyDated(changes: DatedChange[]): void;
  /** confirms (hands the shift over) or declines a worker's offer; the page's `decideShiftRequest` */
  decideRequest(id: string, ok: boolean): Promise<void>;
  /** moves a worker before another in the roster order; saved */
  moveWorker(fromId: string, toId: string): void;
  editWorker(id: string): void;
  exportAs(kind: 'excel' | 'pdf' | 'json'): void;
};

declare global {
  interface Window {
    ManagerBridge?: ManagerBridge;
    ManagerIsland?: { renderToday(): void; renderSchedule(): void };
  }
}

export function bridge(): ManagerBridge {
  const b = window.ManagerBridge;
  if (!b) throw new Error('ManagerBridge missing');
  return b;
}
