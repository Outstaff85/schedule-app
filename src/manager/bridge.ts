// The bridge between the manager app (schedule-manager.html, an old page until
// its stage moves it) and its React pieces (docs/build.md → The manager's React
// pieces). The page sets `window.ManagerBridge` before this module loads; a
// piece reads the page's data and runs the page's actions only through it.
// The data comes already worked out by the page's own functions where those
// still belong to a tab that has not moved (a worker's notices, today's shift,
// the punch's site), so nothing is computed twice.
import type { Punch } from '@/lib/payroll';
import type { AccData, AccWorker, ApprovalDoc, HrLogin } from './accounting';
import type { UserRow } from './users';
import type { MapPickProps } from './MapPicker';
import type { BellItem } from './BellPanel';

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
  /** the site filter (the page's `selectedClientId`) */
  clientId: string | null;
  /** the active workers, in the page's order */
  workers: SchedWorker[];
  clients: { id: string; name: string; color?: string }[];
  /** the workers' requests from today on (`loadShiftRequests`) */
  requests: ShiftRequest[];
  /** the login has the `schedule` section and Edit shifts: edit shifts, confirm requests, copy weeks */
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
  /** every worker in the page's order */
  workers: WorkerRow[];
  clients: { id: string; name: string; color?: string; object?: string }[];
  suppliers: { id: string; name: string; color?: string }[];
  /** the `workers` section and Edit workers: add, edit, delete, status, punch link, Select */
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
  /** display only, from a scan: the ID checksum failed / fields whose two reads differ */
  idChecksumOk?: boolean;
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
  /** the `workers` section and Edit workers: status, edit, scan, documents, hours, punch link */
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
  /** sends this session's scan with the fields saved as a full document for the field reader model (docs/hf-plan.md → H8a), in the background */
  sendScanDocument(workerId: string, saved: Partial<WorkerRecord>): void;
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
  // ── The frame (stage 8e-1): the React Shell's actions on the page ──
  /** opens a section (`switchTab`) */
  switchTab(tab: string): void;
  /** opens or closes the bell's list under the bell button (`toggleBell`) */
  toggleBell(e: MouseEvent): void;
  /** the account menu's items: My name, Install app, Sign out; the theme kept on the account */
  editMyName(): void;
  installApp(): void;
  signOut(): void;
  saveTheme(theme: string): void;
  /** a supplier or client login (stage 3, Portal.tsx): its role, the open tab, its name; null for every other login */
  portal(): { role: 'supplier' | 'client'; tab: string; username: string } | null;
  /** switches the page's language (`setLanguage`: the dictionaries, the account, a redraw) */
  setLanguage(lang: string): void;
  // ── The bell's list (stage 8e-4, BellPanel.tsx) ──
  /** the notifications, newest first (`notifList`), with which are unread */
  bellItems(): BellItem[];
  /** marks one read and opens what it is about */
  openNotif(id: string): void;
  /** runs one of a notification's actions (Call, WhatsApp) */
  bellAct(id: string, index: number): void;
  markAllNotifRead(): void;
  // ── The sign-in screen (stage 8e-2) ──
  /** signs in (the login function, then the page reloads); the error text to show, or null */
  signIn(username: string, password: string): Promise<string | null>;
  /** wakes a cold login function while the user types */
  pingLogin(): void;
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
  /** the page's toast (`showToast`), for `ms` (its default when left out) */
  toast(text: string, ms?: number): void;

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

  // ── Clients and Suppliers (stage 6d) ──
  clients(): ClientsSnapshot;
  suppliers(): SuppliersSnapshot;
  /** opens the client window (null: a new client) */
  openClient(id: string | null): void;
  openSupplier(id: string | null): void;
  /** the manual punch for this client */
  manualPunch(id: string): void;
  /** removes the clients once their Undo time is up: taken off every worker and the site filter; saved */
  deleteClients(ids: string[]): void;
  /** removes the suppliers once their Undo time is up: taken off every worker; saved */
  deleteSuppliers(ids: string[]): void;
  /** the client window's figures and its logins (`editId` null: a new client) */
  clientInfo(editId: string | null): ClientInfo;
  supplierInfo(editId: string | null): SupplierInfo;
  /** stores the client (editId null: a new one) unless nothing changed, closes the window; saved */
  commitClient(editId: string | null, fields: ClientRecord): void;
  commitSupplier(editId: string | null, fields: SupplierRecord): void;
  /** the client window's ⋮ → Manual punch: the window saved first, then the punch (back to the window on close) */
  punchFromClient(id: string): void;
  /** a window's ⋮ → Delete: the window closes without saving and does not come back (the list then deletes behind Undo) */
  deleteFromEditor(kind: 'client' | 'supplier', id: string): void;
  /** the map picker over the client window (`openMapPicker`); `onPick` gets the place chosen */
  pickPlace(start: { lat: number | null; lng: number | null; addr: string; radius: number }, onPick: (p: { lat: number; lng: number; radius: number; mapsUrl: string }) => void): void;
  /** the client of a manual punch and the workers it offers (assigned to this client, else every active one) */
  punchInfo(clientId: string): { client: { id: string; name: string }; workers: { id: string; name: string }[] } | null;
  /** adds the punch to the local log and sends it (`gsSavePunch`) */
  addPunch(p: ManualPunch): void;

  // ── Accounting (stage 6e) ──
  accounting(): AccountingSnapshot;
  /** the page's data the figures read (src/manager/accounting.ts) */
  accData(): AccData;
  /** loads the punches the period needs (`ensurePunchesSince`), then shows it; render() */
  setPeriod(period: string): Promise<void>;
  /** loads the punches a period needs (an export of another period) */
  ensurePeriod(period: string): Promise<void>;
  openClientWindow(id: string): void;
  /** the month's hours-approval documents (`hourApprovalsOf`: kept a minute unless `fresh`), once the first punch load is in */
  hourApprovals(month: string, fresh?: boolean): Promise<ApprovalDoc[]>;
  /** a proposed fix accepted (the shift's punches move) or rejected; the error text, or '' */
  resolveFix(docId: string, key: string, accept: boolean): Promise<string>;
  /** a client's signed month: the PDF in a new tab */
  openSigned(path: string): void;
  /** approves a pending hours batch (`approveHoursBatch`: the punches made, loaded back to the earliest) */
  approveBatch(id: string): Promise<void>;
  /** rejects batches (`rejectHoursBatch` / `bulkHoursBatches`, which ask first) */
  rejectBatches(ids: string[]): Promise<void>;
  /** posts to the `hours` function with the login's ID token (the HR's Hours approval) */
  hoursCall(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** SheetJS, loaded on first need (`loadXlsx`); null when it failed */
  xlsx(): Promise<Xlsx | null>;
  /** the pay window's worker, whether it is read-only, and the period picked */
  payInfo(id: string): { w: AccWorker; ro: boolean; period: string } | null;
  /** writes the pay window's fields on the worker (a field undefined is removed), saves, closes the window; render() */
  savePay(id: string, patch: Record<string, unknown>): void;

  // ── Admin (stage 6f-1: the section chooser and the punch log) ──
  admin(): AdminSnapshot;
  /** opens an Admin section (null: none — the tiles); the old panes not moved yet are shown by the page */
  setAdminPane(pane: AdminPane | null): void;
  /** every punch in the cache now (Clear Log counts its months after loading the whole history) */
  punchLog(): AdminPunch[];
  /** "Load earlier month": back to the 1st of the month already partly loaded, or the month before */
  loadEarlierPunches(): Promise<void>;
  /** loads the whole punch history (`ensureAllPunches`) */
  loadAllPunches(): Promise<void>;
  /** Export CSV of the whole history (`exportPunchCSV`) */
  exportPunches(): Promise<void>;
  /** Clear Log: a CSV of exactly those punches first, then `deletePunchesByMonths`; the toast is the page's; true when deleted */
  clearPunchMonths(months: string[]): Promise<boolean>;
  /** the punch's edit (`editedBy: 'admin'`, `editedAt`), sent with `gsUpdatePunch`; render() */
  savePunch(id: string, edit: PunchEdit): void;
  /** deletes the punches (their Undo time is up): the cache and Firestore; render() */
  deletePunches(ids: string[]): void;

  // ── Admin (stage 6f-2: Firms, Users, Errors, Timings, the super-admin's Firms screen) ──
  /** a data call through the page's dispatcher (`fetch(API_URL)`, POST, with `gsAuth()`); a network failure answers `{error}` */
  adminCall(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** the firms: a super-admin's list (`listTenants`, cached first) or an owner's own profile (`refreshTenantProfile`); then a redraw */
  loadFirms(): Promise<void>;
  /** a super-admin opens a firm (`switchToTenant`: the page reloads into it) */
  openFirm(tenantId: string): void;
  /** Disable / Enable firms (`setTenantActive` each; its toast; the list again) */
  setFirmsActive(ids: string[], active: boolean): Promise<void>;
  /** deletes firms (their Undo time is up): `deleteTenant` each — the firm's data, logins and files; the toast; the list again */
  deleteFirms(ids: string[]): Promise<void>;
  /** the firm window: a new firm, a firm of the list, or the firm being worked in */
  openFirmWindow(mode: 'create' | 'edit' | 'mine', tenantId?: string): void;
  /** the Payable summary (all firms): this week's hours and pay of each cached firm, with its own clients (the canonical payroll) */
  firmsPayable(): Promise<{ name: string; hours: number; pay: number; error?: boolean }[]>;
  /** the firm's logins (`listUsers`, this firm only, cached); then a redraw */
  loadUsers(): Promise<void>;
  /** the user window: a saved login (from the cache, else the server) or a new one (null) */
  openUserWindow(id: string | null): void;
  /** deletes logins (their Undo time is up): `deleteUser` each; the toast; the list again */
  deleteUsers(ids: string[]): Promise<void>;
  /** Errors / Timings: another period (loaded, cached per period) */
  setLogPeriod(kind: 'errors' | 'timings', value: string): void;
  /** Errors / Timings: the period again from the server */
  reloadLog(kind: 'errors' | 'timings'): Promise<void>;
  /** Reset: every error and every measurement deleted (all firms, all periods); the caches dropped, the toast */
  resetLogs(): Promise<void>;
  /** to the clipboard, with the toast (`copyTextToClipboard`) */
  copyText(text: string): void;
  // the windows
  firmInfo(): FirmWindowInfo | null;
  /** the firm being worked in: its profile from the server (`loadTenantProfile`), cached in the session */
  loadProfile(): Promise<FirmProfile | null>;
  /** the WhatsApp reminder's text (the firm's, else the default in the UI language) after reading it afresh */
  firmMessage(): Promise<string>;
  /** the WhatsApp reminder saved on its own (`saveFirmMessages`; the default text = empty) */
  saveFirmMessage(tenantId: string, text: string): Promise<void>;
  /** after a firm save: the window closes, the session's profile, the Form 101s (now, or when the firm is opened), the lists */
  firmSaved(mode: 'create' | 'edit' | 'mine', tenantId: string | null, profile: FirmProfile | null): void;
  userInfo(): UserWindowInfo;
  /** this month's commission of an HR at these rates (its workers' Salary rows, `commissionFor`) */
  hrMonthCommission(uid: string, rate: number, dayRate: number): number;
  /** an HR's workers (`assignWorkersToHr`: their punches move too) or a supplier's (`assignWorkersToSupplier`); key null unassigns; the count */
  assignWorkers(kind: 'hr' | 'supplier', ids: string[], key: string | null): Promise<number>;
  /** "Add workers": the picker over the user window */
  openAssign(team: AssignTeam): void;
  /** after a user save: a former HR's workers unassigned, one's own name in the header, the window closes, the toast, the list again */
  userSaved(id: string | null, origRole: string | null, role: string, fullName: string): Promise<void>;
};

/** A firm of the super-admin's list (`listTenants`), with what Form 101 would leave empty (`firmProfileMissing`). */
export type FirmProfile = { companyName?: string; deductionsFileNumber?: string; phone?: string; street?: string; streetNumber?: string; city?: string };
export type FirmRow = FirmProfile & { tenantId: string; workerCount?: number; clientCount?: number; savedAt?: string; active?: boolean; missing: string[] };
export type FirmWindowInfo = {
  mode: 'create' | 'edit' | 'mine';
  tenantId: string | null;
  profile: FirmProfile;
  /** the WhatsApp reminder: only for the firm being worked in */
  wa: boolean;
};
export type AssignTeam = { kind: 'hr' | 'supplier'; key: string; name: string };
export type TeamWorker = { id: string; name: string; docId: string; hrId?: string; supplierId?: string };
export type UserWindowInfo = {
  workers: TeamWorker[];
  suppliers: { id: string; name: string }[];
  clients: { id: string; name: string; object?: string }[];
  /** the HR logins' names (the "now: <name>" of the picker) */
  hrNames: Record<string, string>;
};
export type LogPane = {
  kind: 'errors' | 'timings';
  /** the picked period and the list of periods ([value, label]) */
  period: string;
  periods: [string, string][];
  label: string;
  /** the period's rows (cached, then fresh), null while nothing is loaded */
  rows: Record<string, unknown>[] | null;
  error: string;
};

/** The SheetJS calls the exports use. */
export type Xlsx = {
  utils: { book_new(): unknown; aoa_to_sheet(aoa: unknown[][]): unknown; book_append_sheet(wb: unknown, ws: unknown, name: string): void };
  writeFile(wb: unknown, name: string): void;
};

/** A pending hours batch (`tenants/{t}/pendingHours`). */
export type PendingBatch = { batchId?: string; id?: string; status: string; fileName?: string; uploadedBy?: string; entries: { workerId: string; clientId?: string }[] };

/** The Accounting tab's snapshot (stage 6e). */
export type AccountingSnapshot = {
  ready: boolean;
  /** 'week' | 'month' | 'm:YYYY-MM' | 'all' — kept on the page (the pay window's days follow it) */
  period: string;
  /** `uiLocale()`: the month names of the period list */
  locale: string;
  /** an HR with the Accounting section (its Commission tab): its own workers' Salary only, with its commission (`hrPayOnly`) */
  payOnly: boolean;
  me: { uid: string; commissionRate: number; commissionDayRate: number };
  /** the `exports` section */
  canExport: boolean;
  /** the owner / super-admin: approve or reject hours batches */
  canApprove: boolean;
  /** `canEditPay(w)` per worker id */
  canPay: Record<string, boolean>;
  /** the HR logins with their commission (owner / super-admin; Payable by HR) */
  hrUsers: HrLogin[];
  /** hours batches waiting (`__hoursBatches`) and a key that changes with them */
  waiting: number;
  batchesKey: string;
  /** counts the openings of the tab: the approvals are read afresh on each */
  openSeq: number;
  firmName: string;
};


// ── Admin (stage 6f) ──

export type AdminPane = 'punchlog' | 'firms' | 'users' | 'errors' | 'timings' | 'scanner';

/** A punch as the log shows it: as stored, with its site worked out (`punchSite`). */
export type AdminPunch = {
  id: string | number;
  workerId: string;
  workerName: string;
  type: 'in' | 'out';
  time: string;
  ts: string | number;
  /** dd/MM/yyyy, set by the server */
  date?: string;
  site: string;
  /** the stored site text (a custom site when there is no clientId) */
  rawSite?: string;
  clientId?: string | null;
  dist?: number | null;
  gpsAccuracy?: number | null;
  gpsSuspicious?: boolean;
  gpsWarnings?: string[];
  manual?: boolean;
  notes?: string;
};

/** The punch window's fields; `site` a client id, '' for none, or '__custom__' to keep the stored custom site. */
export type PunchEdit = { type: 'in' | 'out'; time: string; site: string; notes: string };

export type AdminSnapshot = {
  ready: boolean;
  /** the open section (kept while the app stays open), null: none chosen */
  pane: AdminPane | null;
  /** the sections this login sees: Punch Log for everyone; Firms, Users for an owner / super-admin; Errors, Timings for a super-admin */
  panes: AdminPane[];
  /** Clear Log: an owner / super-admin (the server's gate too) */
  canClear: boolean;
  /** Edit punches (the login's template): a punch opens its edit window, Delete, Select */
  canEditPunches: boolean;
  /** the firm's profile misses a Form 101 field (the Firms tile shows it, as the tab's icon does) */
  firmIncomplete: boolean;
  /** the cached punches while the Punch Log section is open (empty otherwise) */
  log: AdminPunch[];
  workers: { id: string; name: string; clientIds: string[] }[];
  clients: { id: string; name: string; color: string; address: string }[];
  /** the earliest day loaded (dd/mm/yyyy), null when the whole history is in */
  loadedFrom: string | null;
  // stage 6f-2
  isSuper: boolean;
  /** `uiLocale()` */
  locale: string;
  /** a super-admin's firms (cached, then fresh), null until loaded; the load error */
  firms: FirmRow[] | null;
  firmsError: string;
  /** an owner's own firm (the session's profile, then fresh) */
  own: (FirmProfile & { missing: string[] }) | null;
  /** the firm's logins (cached, then fresh), null until loaded; the load error */
  users: UserRow[] | null;
  usersError: string;
  /** the users' teams: an HR's workers, a supplier's */
  team: TeamWorker[];
  suppliers: { id: string; name: string }[];
  /** Errors / Timings while one is open */
  logs: LogPane | null;
  /** the firms' names (a measurement's firm) */
  firmNames: Record<string, string>;
};

// ── Clients and Suppliers (stage 6d) ──

/** A client on the Clients tab: the record's list fields and what the page works out for it. */
export type ClientRow = {
  id: string;
  name: string;
  color: string;
  address: string;
  object: string;
  /** its active workers */
  workers: number;
  /** this month's hours at the client (`salaryEntriesFor('month').byClient`) */
  monthHours: number;
  /** no billing rate and no worker rate */
  noRate: boolean;
  /** a pending hours batch has entries for it */
  waiting: boolean;
};
export type ClientsSnapshot = {
  ready: boolean;
  clients: ClientRow[];
  /** the `clients` section: Delete, Select */
  canEdit: boolean;
  /** Edit punches: the Manual punch action */
  canPunch: boolean;
};

/** A supplier on the Suppliers tab. */
export type SupplierRow = {
  id: string;
  name: string;
  color: string;
  phone: string;
  workers: number;
  /** its workers' hours this month (`workersMonthHours`) */
  monthHours: number;
};
export type SuppliersSnapshot = {
  ready: boolean;
  suppliers: SupplierRow[];
  /** the `suppliers` section: Delete, Select */
  canEdit: boolean;
};

/** A client record as stored (docs/clients.md → Data: the client record). */
export type ClientRecord = {
  id?: string;
  name?: string;
  color?: string;
  companyNumber?: string;
  object?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  radius?: number;
  mapsUrl?: string;
  defaultHourlyRate?: number | null;
  defaultOtRate?: number | null;
  defaultShabbatRate?: number | null;
  rateMode?: 'tiered' | 'fixed' | 'daily';
  billRate?: number | null | '';
  billOtRate?: number | null;
  billShabbatRate?: number | null;
  fixedBillRate?: number | null;
  dailyBillRate?: number | null;
  [k: string]: unknown;
};

/** A supplier's own commission rate from a date (`sp.commission`). */
export type CommissionEntry = { from?: string; mode?: 'hour' | 'day'; rate: number | string | null };
/** A supplier record as stored (docs/suppliers.md → Data). */
export type SupplierRecord = {
  id?: string;
  name?: string;
  color?: string;
  phone?: string;
  contactPerson?: string;
  bank?: string;
  bankBranch?: string;
  accountNumber?: string;
  companyNumber?: string;
  commission?: CommissionEntry[];
  [k: string]: unknown;
};

export type ClientInfo = {
  /** active workers at the client, this month's hours and billed sum there (0 for a new one) */
  workers: number;
  monthHours: number;
  billed: number;
  /** pending hours batches for it */
  waiting: number;
  /** the `clients` section: Delete from the ⋮ */
  canDelete: boolean;
  /** `PAY_RULES.otMult`, `shabbatMult` (the law's figures in the OT / Shabbat placeholders) */
  otMult: number;
  shabbatMult: number;
};

export type SupplierInfo = {
  workers: { id: string; name: string; active: boolean; hours: number }[];
  /** this month's commission payable (`supplierMonthPayable`) */
  payable: number;
  /** the owner / super-admin sets the supplier's own rate */
  canRate: boolean;
  canDelete: boolean;
  /** `SUPPLIER_DEFAULT_RATE` */
  defaultRate: number;
};

/** A punch entered by hand from the client window (docs/clients.md → Manual punch). */
export type ManualPunch = {
  id: number; workerId: string; workerName: string; type: 'in' | 'out'; time: string; date: string; ts: string; site: string;
  clientId: string | null; dist: null; gpsVerified: false; manual: true; notes: string; gpsWarnings: string[];
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
  // ── Clients and Suppliers (stage 6d) ──
  renderClients(): void;
  renderSuppliers(): void;
  openClient(c: ClientRecord, editId: string | null): void;
  /** the client window's save (`saveClient`) */
  saveClient(opts: { auto?: boolean }): void;
  openSupplier(s: SupplierRecord, editId: string | null): void;
  openManualPunch(clientId: string): void;
  /** the map picker (stage 8e-3) into #mapPickModal; the page opens the overlay */
  openMapPicker(p: { start: MapPickProps['start']; onPick: MapPickProps['onPick']; close: () => void }): void;
  /** sets the map picker's pin (the browser checks) */
  mapPickAt(lat: number, lng: number): void;
  // ── Accounting (stage 6e) ──
  renderAccounting(): void;
  /** an HR's Commission tab (the Accounting tab's Salary for its own workers) and Hours tab (the hours review) */
  renderCommission(): void;
  renderHours(): void;
  /** a supplier's or client's open tab (Portal.tsx) */
  renderPortal(): void;
  /** Salary / Billing / Approvals / Alerts */
  setAccTab(tab: string): void;
  /** the pay window, drawn into the page's #payModal */
  openPay(id: string): void;
  // ── Admin (stage 6f-1) ──
  /** the section tabs, the tiles and the sections (#adminRoot) */
  renderAdmin(): void;
  // ── Admin (stage 6f-2) ──
  /** the super-admin's landing screen's firms (#firmsScreenRoot) */
  renderFirmsScreen(): void;
  /** the firm window, drawn into the page's #firmModal */
  openFirm(): void;
  /** the user window, drawn into the page's #userFormModal (a new login: the role and its client / supplier may be set) */
  openUser(u: UserRow | null, preset?: { role: 'client' | 'supplier'; id: string }): void;
  /** "Add workers", drawn into the page's #hrAssignModal */
  openAssign(team: AssignTeam): void;
};

declare global {
  interface Window {
    ManagerBridge?: ManagerBridge;
    ManagerIsland?: ManagerIsland;
  }
}

// The page and its React pieces reach each other through these two, not
// through window (React migration 8f): the page gives its bridge once
// (page/bridge.ts), main.tsx its island. window.ManagerBridge /
// window.ManagerIsland stay set for the browser tests only.
let theBridge: ManagerBridge | undefined;
let theIsland: ManagerIsland | undefined;
export function provideBridge(b: ManagerBridge): void { theBridge = b; window.ManagerBridge = b; }
export function provideIsland(i: ManagerIsland): void { theIsland = i; window.ManagerIsland = i; }
export const hasBridge = (): boolean => !!theBridge;
export function bridge(): ManagerBridge {
  if (!theBridge) throw new Error('ManagerBridge missing');
  return theBridge;
}
/** The React pieces' entry points, once main.tsx has run (undefined before). */
export const island = (): ManagerIsland | undefined => theIsland;
