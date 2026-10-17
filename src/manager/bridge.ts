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

/** A worker on the Workers tab (stage 6c-1): the record's list fields and what the page works out for it. */
export type WorkerRow = {
  id: string;
  name: string;
  docGiven: string;
  docSurname: string;
  phone: string;
  /** the ID / passport number (`workerDocId`) */
  docId: string;
  status: 'active' | 'vacation' | 'fired';
  clientIds: string[];
  supplierId: string;
  /** YYYY-MM-DD or '' */
  startDate: string;
  createdAt?: string | number;
  /** the Form 101 PDF */
  docUrl: string;
  site: string;
  today: WorkerToday;
  notices: Notice[];
  /** this month's hours (`workersMonthHours`, the payroll shift pairing) */
  monthHours: number;
  /** `workerDocStatus`: the level, its lines, the list badge (DOCS / ID EXPIRED / … / '' when complete) */
  docLevel: 'ok' | 'warn' | 'error';
  docLines: string[];
  docBadge: string;
  /** the ID / passport or a document expired or expiring (the Documents filter "expiring") */
  docExpiring: boolean;
  /** `workerExpiryStatus`: the contract ended / ending, its deadline as shown */
  contract: { overdue: boolean; deadline: string } | null;
  /** `canEditPay(w)` */
  canPay: boolean;
};

export type WorkersSnapshot = {
  ready: boolean;
  /** every worker in the page's order, except those deleted from the side panel inside their Undo time */
  workers: WorkerRow[];
  clients: { id: string; name: string; color?: string; object?: string }[];
  suppliers: { id: string; name: string; color?: string }[];
  /** the `workers` section: add, edit, delete, status, punch link, Select */
  canEdit: boolean;
};

/** One date of one worker: a shift for that date only, or null to drop the change. */
export type DatedChange = { workerId: string; date: string; shift: DayShift | null };


// ── The worker card, the worker window, documents, hours (stage 6c-2) ──

/** A worker record as stored (docs/workers.md → Data: the worker record); the window reads and writes these fields. */
export type WorkerDoc = { id: string; type: string; name?: string; fileId?: string; url?: string; mediaType?: string; uploadedAt?: string; expiry?: string };
export type Child = { name: string; idNo: string; dob: string };
export type WorkerRecord = {
  id: string;
  name?: string;
  docGiven?: string;
  docSurname?: string;
  colorIdx?: number;
  phone?: string;
  notes?: string;
  status?: string;
  clientIds?: string[];
  supplierId?: string | null;
  hrId?: string | null;
  schedule?: DayShift[];
  startDate?: string;
  workStartDate?: string;
  expiryEnabled?: boolean;
  expiryMonths?: number;
  expiryWarnMonths?: number;
  token?: string;
  createdAt?: string;
  docType?: string;
  docId?: string;
  docSex?: string;
  docDob?: string;
  docExpiry?: string;
  address?: string;
  houseNumber?: string;
  city?: string;
  maritalStatus?: string;
  healthFund?: string;
  incomeType?: string;
  otherIncomeType?: string;
  docChildren?: Child[];
  spouseSurname?: string;
  spouseGiven?: string;
  spouseId?: string;
  spouseDob?: string;
  spouseIncome?: string;
  docUrl?: string;
  docSavedAt?: string;
  assetsFileId?: string;
  docs?: WorkerDoc[];
  /** display only, from a scan: the ID checksum failed / the ספח's number differs / fields whose two reads differ */
  idChecksumOk?: boolean;
  idMismatch?: boolean;
  __scanCheck?: string[];
  [k: string]: unknown;
};

/** A notice with what the notices sheet shows: its icon (a Tabler name), detail line and actions (by rights). */
export type NoticeAct = { label: string; icon: string; wa?: boolean; run: () => void };
export type NoticeFull = Notice & { icon: string; detail: string; acts: NoticeAct[] };

/** The head of the worker card, the notices sheet and the worker window. */
export type WorkerHead = {
  name: string;
  /** the plate's colour (`workerBarColor`) */
  color: string;
  site: string;
  today: WorkerToday;
  monthHours: number;
  notices: NoticeFull[];
};

export type HoursBatchStatus = { status: 'pending' | 'approved' | 'rejected'; when: string };

export type CardSnapshot = WorkerHead & {
  w: WorkerRecord;
  /** the `workers` section: status, edit, scan, documents, hours, punch link */
  canEdit: boolean;
  canPay: boolean;
  /** the `exports` section */
  canExport: boolean;
  /** the owner / super-admin: the HR line */
  isFirmAdmin: boolean;
  hr: { name: string; color: string } | null;
  clients: { id: string; name: string; color: string }[];
  supplier: { name: string; color: string } | null;
  /** today's shift (`shiftOn`), null on a day off */
  shiftToday: { start: string; end: string } | null;
  contract: { overdue: boolean; deadline: string } | null;
  /** the scheduled hours per week (`workerTotalHours`) */
  weekHours: number;
  docLevel: 'ok' | 'warn' | 'error';
  docLines: string[];
  /** the documents expired / expiring, by document id (`workerDocExpiries`) */
  docExpiry: Record<string, { level: 'error' | 'warn'; text: string }>;
  /** the latest hours batch of this worker (`latestHoursBatch`), live */
  hoursBatch: HoursBatchStatus | null;
};

export type EditorInfo = WorkerHead & {
  clients: { id: string; name: string; color: string; object: string; lat?: number; lng?: number; radius?: number }[];
  suppliers: { id: string; name: string }[];
  /** the HR field (owner / super-admin only), the HR logins (loaded on first need) */
  isFirmAdmin: boolean;
  hrUsers: { id: string; name: string }[];
  /** the worker has a scan to search (`workerHasScanPages`) */
  hasScan: boolean;
  /** the live scan's pages besides the front, when the scan in memory is this window's (null otherwise) */
  liveOthers: number | null;
  /** the Documents section (an edit only) */
  docLevel: 'ok' | 'warn' | 'error';
  docLines: string[];
  docMissing: string[];
  docFailed: boolean;
  docExpiryText: string;
  docProblems: number;
  docExpiry: Record<string, { level: 'error' | 'warn'; text: string }>;
  punchLink: string;
};

export type ScanHit = { value: string; unsure: boolean };
export type UploadPage = { b64: string; mediaType: string };
export type HoursEntry = { date: string; inTime: string; outTime: string };
export type HoursBatch = { id: string; status: string; uploadedAt?: string; decidedAt?: string; fileName?: string; entries?: (HoursEntry & { workerId: string; clientId?: string })[] };

export type WorkerBridge = {
  /** the live record (a copy), or null */
  record(id: string): WorkerRecord | null;
  card(id: string): CardSnapshot | null;
  notices(id: string): WorkerHead | null;
  /** the window's head and choices for this record (`editId` null: a new worker) */
  editorInfo(w: WorkerRecord, editId: string | null): EditorInfo;
  closeModal(id: string): void;
  setWorkerStatus(id: string, status: string): void;
  /** closes the card and opens the edit form (back to the card on close) */
  editFromCard(id: string): void;
  rescanFromCard(id: string): void;
  /** closes the card and opens the pay window (back to the card on close) */
  payFromCard(id: string): void;
  openDocUpload(id: string): void;
  openHoursImport(id: string): void;
  openHoursExport(id: string): void;
  openCard(id: string): void;
  /** removes these documents and their files; saved */
  removeDocs(workerId: string, docIds: string[]): void;
  /** a scan field found from the card: saved on the worker (`name` rebuilt) */
  setScanField(workerId: string, key: string, value: string): void;
  /** rebuilds the Form 101 from the stored sidecar (`regenerateWorkerDoc`) */
  regenerateDoc(workerId: string, sig?: string | null): Promise<boolean>;
  /** searches the worker's scan (`findScanFields`; editId null: the scan in memory of a new worker) */
  findScanFields(editId: string | null, keys: string[], docType: string): Promise<Record<string, ScanHit> | null>;
  /** keeps the window as a draft and opens the scan over it (`rescanFromWorkerModal`) */
  rescan(): void;
  newToken(id: string): string | null;
  // saveWorker() (src/manager/worker-save.ts)
  findByDocId(docId: string): { id: string; name: string; clientIds: string[] } | null;
  isHr(): boolean;
  /** the server's yes / no across the whole firm (an HR has only its own workers) */
  docExistsInFirm(docId: string, workerId?: string): Promise<boolean>;
  /** a scan of this session is in memory (`__aiScanImage`) */
  liveScan(): boolean;
  /** `__aiRescannedWorkerId`: read, set, and read-and-clear */
  rescannedId(): string | null;
  setRescanned(id: string | null): void;
  /** replaces the record with prev + fields (the own-rate rule for a new rated client, the HR change); render(), saved */
  commitEdit(id: string, fields: Partial<WorkerRecord>, hrPicked: string | null | undefined): void;
  /** adds the new worker (its HR: an HR login's own uid, else the pick); render(), saved */
  addRecord(rec: WorkerRecord, hrPicked: string | null | undefined): void;
  /** builds and uploads the Form 101 from the live scan (`autoUploadWithRetry`); `sig` the signature drawn */
  uploadForm101(isId: boolean, workerId: string, sig: string | null | undefined): Promise<void>;
  genToken(): string;
  newId(): string;
  // documents and hours
  fileForStorage(f: File): Promise<{ b64: string; fileName: string; mediaType: string }>;
  uploadWorkerFile(body: Record<string, unknown>, onProgress: (loaded: number, total: number) => void): Promise<{ ok?: boolean; id?: string; url?: string; error?: string } | null>;
  addDocs(workerId: string, docs: WorkerDoc[]): void;
  reportError(msg: string, where: string): void;
  hoursInfo(id: string): { name: string; daily: boolean; clients: { id: string; name: string }[] } | null;
  parseHoursSheet(f: File): Promise<HoursEntry[]>;
  filePages(f: File): Promise<UploadPage[]>;
  readHoursPage(pg: UploadPage): Promise<HoursEntry[]>;
  sendHours(entries: (HoursEntry & { workerId: string; clientId: string })[], fileName: string): Promise<{ count?: number; error?: string }>;
  loadPendingHours(): Promise<HoursBatch[]>;
  exportHours(workerId: string, year: number, month: number, format: 'excel' | 'pdf'): Promise<void>;
};

export type ManagerBridge = WorkerBridge & {
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
  /** the page's toast (`showToast`) */
  toast(text: string): void;

  // ── Workers (stage 6c-1) ──
  workers(): WorkersSnapshot;
  /** the scan of a new worker's passport / ID (`startNewScan`) */
  scanNew(): void;
  /** the pay window (`openPayModal`) */
  openPay(id: string): void;
  /** copies the worker's punch link (`copyWorkerLink`) */
  copyLink(id: string): void;
  /** sets the status of several workers; saved */
  setStatus(ids: string[], status: 'active' | 'vacation'): void;
  /** removes the workers and their files (`deleteWorkerNow`) once their Undo time is up; saved */
  deleteWorkers(ids: string[]): void;
};

/** What the page calls to draw (src/manager/main.tsx). */
export type ManagerIsland = {
  renderToday(): void;
  renderSchedule(): void;
  renderWorkers(): void;
  // the worker windows (stage 6c-2), drawn into the page's overlays
  openCard(id: string): void;
  openNotices(id: string): void;
  openEditor(w: WorkerRecord, editId: string | null): void;
  /** the window's save (`saveWorker`) */
  saveWorker(opts: { auto?: boolean }): Promise<void>;
  /** the window's fields as a draft before a rescan (`window.__wDraft`) */
  editorDraft(): unknown;
  applyDraft(): void;
  findMissing(): Promise<void>;
  uploadProgress(label: string, pct: number): void;
  openDocUpload(id: string): void;
  openHoursImport(id: string): void;
  openHoursExport(id: string): void;
  /** the open windows read their data again (render(), a live hours batch, the HR list) */
  refreshWindows(): void;
};

declare global {
  interface Window {
    ManagerBridge?: ManagerBridge;
    ManagerIsland?: ManagerIsland;
  }
}

export function bridge(): ManagerBridge {
  const b = window.ManagerBridge;
  if (!b) throw new Error('ManagerBridge missing');
  return b;
}
