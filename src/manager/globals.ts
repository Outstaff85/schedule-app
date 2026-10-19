// The data layer and the logic under their old global names: the first import
// of the manager page's module (src/manager/page/entry.ts), before the page's
// own script (page/app.ts).
//
// The data layer, in layers (each file uses only those above it):
//   events.ts    — the events it emits, the Message type, the page's answers (host)
//   ids.ts       — uid(), genToken()
//   session.ts   — who is signed in, which firm, the cache key
//   state.ts     — the firm's data: workers, clients, suppliers, ready
//   telemetry.ts — errors and timings to Admin → Errors / Timings
//   api.ts       — the backend (firestore-backend.js), the fetch(API_URL) dispatcher, gs* calls, uploads
//   punches.ts   — the punch cache and its sync
//   store.ts     — load, save, the offline cache, the live watchers
// It never draws: the page answers its events in one place (its "The data
// layer's events" block).
//
// This entry hands the page the data layer under the names the page's code
// (and the browser tests) already call, as window
// properties: the functions, the data as read / write accessors (workers,
// clients, suppliers, __dataReady), and the state the page reads as
// read-only accessors. React migration stage 8b (docs/react-migration-plan.md);
// 8c imports these modules directly and this file goes.
import * as events from './data/events';
import * as ids from './data/ids';
import * as session from './data/session';
import { state } from './data/state';
import * as stateFns from './data/state';
import * as api from './data/api';
import * as punches from './data/punches';
import * as store from './data/store';
import * as telemetry from './data/telemetry';
import * as access from './logic/access';
import * as i18n from './logic/i18n';
import * as util from './logic/util';
import * as pay from './logic/pay';
import * as wk from './logic/workers';
import * as up from './logic/uploads';
import * as fns from './logic/functions';
import * as sched from './logic/schedule';
import * as exp from './logic/exports';
import * as adm from './logic/admin';

const w = window as unknown as Record<string, unknown>;

Object.assign(w, {
  // the page wires the events and its answers here
  ManagerData: {on: events.on, setHost: events.setHost},
  uid: ids.uid, genToken: ids.genToken,
  // session
  SESSION_KEY: session.SESSION_KEY, getSession: session.getSession, saveSession: session.saveSession, clearSession: session.clearSession,
  fsTenantId: session.fsTenantId, STORAGE_KEY_BASE: session.STORAGE_KEY_BASE, STORAGE_KEY: session.STORAGE_KEY,
  gsAuth: session.gsAuth, gsAuthQuery: session.gsAuthQuery,
  // data
  getDataObj: stateFns.getDataObj, applyData: stateFns.applyData,
  // backend, dispatcher, direct calls, uploads
  API_URL: api.API_URL, SESSION_EXPIRED_ERROR: api.SESSION_EXPIRED_ERROR, loadFirestoreBackend: api.loadFirestoreBackend,
  uploadWorkerFile: api.uploadWorkerFile, gsSave: api.gsSave, gsLoad: api.gsLoad, gsSavePunch: api.gsSavePunch,
  gsDeletePunch: api.gsDeletePunch, gsUpdatePunch: api.gsUpdatePunch, gsDeleteWorkerDoc: api.gsDeleteWorkerDoc,
  // punches
  getPunchLog: punches.getPunchLog, savePunchLog: punches.savePunchLog, punchWindowStart: punches.punchWindowStart,
  ALL_PUNCHES_FROM: punches.ALL_PUNCHES_FROM, ensurePunchesSince: punches.ensurePunchesSince, ensureAllPunches: punches.ensureAllPunches,
  periodPunchStart: punches.periodPunchStart, syncPunchesFromGS: punches.syncPunchesFromGS, mergeRemotePunches: punches.mergeRemotePunches,
  // load / save / cache / watchers
  UNSAVED_KEY: store.UNSAVED_KEY, hasUnsavedLocal: store.hasUnsavedLocal, dropWorkerPhotos: store.dropWorkerPhotos,
  applyServerLoad: store.applyServerLoad, autoSave: store.autoSave, loadData: store.loadData,
  watchHoursBatches: store.watchHoursBatches, latestHoursBatch: store.latestHoursBatch, pendingHoursCount: store.pendingHoursCount,
  watchHrWorkers: store.watchHrWorkers,
  // telemetry
  queueTelemetry: telemetry.queueTelemetry, flushTelemetry: telemetry.flushTelemetry, reportTiming: telemetry.reportTiming,
  markFirstContent: telemetry.markFirstContent, markFreshContent: telemetry.markFreshContent, reportError: telemetry.reportError,
  // who may see what (logic/access.ts)
  hasPermission: access.hasPermission, NAV_TAB_PERMISSION: access.NAV_TAB_PERMISSION, isHrSession: access.isHrSession,
  isFirmAdminSession: access.isFirmAdminSession, HR_HIDDEN_TABS: access.HR_HIDDEN_TABS, hrPayOnly: access.hrPayOnly,
  hrHourReview: access.hrHourReview, tabAllowed: access.tabAllowed, homeTab: access.homeTab, MORE_TABS: access.MORE_TABS,
  // translations (logic/i18n.ts)
  I18N_LANGS: i18n.I18N_LANGS, tr: i18n.tr, uiLocale: i18n.uiLocale, storedLanguage: i18n.storedLanguage, loadI18n: i18n.loadI18n,
  currentLang: i18n.currentLang, currentDict: i18n.currentDict, onNewerDictionary: i18n.onNewerDictionary,
  // helpers (logic/util.ts)
  esc: util.esc, loadXlsx: util.loadXlsx, getSundayOfWeek: util.getSundayOfWeek, toMins: util.toMins, calcHours: util.calcHours, fmtDMY: util.fmtDMY,
  // pay, over payroll.js (logic/pay.ts)
  analyzeDayPunches: pay.analyzeDayPunches, groupPunchesIntoShifts: pay.groupPunchesIntoShifts, PAY_RULES: pay.PAY_RULES(),
  effectiveRates: pay.effectiveRates, shiftPay: pay.shiftPay, isDailyPay: pay.isDailyPay, dailyRate: pay.dailyRate, shiftPayFor: pay.shiftPayFor,
  travelPay: pay.travelPay, salaryPeriodKey: pay.salaryPeriodKey, dayOverride: pay.dayOverride, localYMD: pay.localYMD, wOwnRate: pay.wOwnRate,
  // a worker's status (logic/workers.ts)
  DOC_STORE: wk.DOC_STORE, workerDocId: wk.workerDocId, workerAddress: wk.workerAddress, isActiveWorker: wk.isActiveWorker,
  workerExpiryStatus: wk.workerExpiryStatus, WORKER_DOC_TYPES: wk.WORKER_DOC_TYPES, parseDocDate: wk.parseDocDate,
  workerDocExpiries: wk.workerDocExpiries, workerDocStatus: wk.workerDocStatus,
  // upload preparation (logic/uploads.ts)
  UPLOAD_MAX_DIM: up.UPLOAD_MAX_DIM, downscaleForUpload: up.downscaleForUpload, _loadPdfJs: up.loadPdfJs, isPdfFile: up.isPdfFile,
  fileToUploadPages: up.fileToUploadPages, fileForStorage: up.fileForStorage, filesToUploadPages: up.filesToUploadPages,
  // the functions the page calls directly, and their warm-up (logic/functions.ts)
  FORM101_FN_URL: fns.FORM101_FN_URL, PREPROCESS_SCAN_FN_URL: fns.PREPROCESS_SCAN_FN_URL, AI_FN_URL: fns.AI_FN_URL,
  USERS_ADMIN_FN_URL: fns.USERS_ADMIN_FN_URL, SCAN_WARM_URLS: fns.SCAN_WARM_URLS, __fnWarm: fns.fnWarm, warmCloudFunctions: fns.warmCloudFunctions,
  // the Schedule: its shifts, who is shown, the workers' requests (logic/schedule.ts)
  DAYS: sched.DAYS, DAYS_HE: sched.DAYS_HE, WORKER_COLORS: sched.WORKER_COLORS, CLIENT_COLORS: sched.CLIENT_COLORS,
  shiftOn: sched.shiftOn, weekShifts: sched.weekShifts, workerTotalHours: sched.workerTotalHours, hasSchedule: sched.hasSchedule,
  getVisible: sched.getVisible, filterByClient: sched.filterByClient, pruneDateShifts: sched.pruneDateShifts,
  loadShiftRequests: sched.loadShiftRequests, decideShiftRequest: sched.decideShiftRequest,
  // exports (logic/exports.ts)
  fmtDate: exp.fmtDate, fmtRange: exp.fmtRange, exportExcel: exp.exportExcel, exportPDF: exp.exportPDF, exportJSON: exp.exportJSON,
  getWorkerMonthShifts: exp.getWorkerMonthShifts, exportShiftsDetail: exp.exportShiftsDetail,
  // the Admin tab's figures and caches (logic/admin.ts)
  FIRM_PROFILE_FIELDS: adm.FIRM_PROFILE_FIELDS, activeTenantProfile: adm.activeTenantProfile, firmProfileMissing: adm.firmProfileMissing,
  FIRMS_CACHE_KEY: adm.FIRMS_CACHE_KEY, ADMIN_CACHE_PREFIX: adm.ADMIN_CACHE_PREFIX, saveAdminCache: adm.saveAdminCache, loadAdminCache: adm.loadAdminCache,
  clearAdminCaches: adm.clearAdminCaches, saveFirmsCache: adm.saveFirmsCache, loadFirmsCache: adm.loadFirmsCache,
  adminPanes: adm.adminPanes, activeTenantIdForAdmin: adm.activeTenantIdForAdmin, USER_ROLE_LABELS: adm.USER_ROLE_LABELS,
  hrColor: adm.hrColor,
  assignWorkersToHr: adm.assignWorkersToHr, assignWorkersToSupplier: adm.assignWorkersToSupplier,
  fetchForTenant: adm.fetchForTenant, firmsPayableRows: adm.firmsPayableRows,
  logPeriodOptions: adm.logPeriodOptions, logPeriodRange: adm.logPeriodRange, logPeriodQuery: adm.logPeriodQuery,
  copyTextToClipboard: adm.copyTextToClipboard,
});

// The data, read and replaced by the page under its old names.
for (const k of ['workers', 'clients', 'suppliers'] as const)
  Object.defineProperty(window, k, {get: () => state[k], set: v => { state[k] = v; }, configurable: true});
Object.defineProperty(window, '__dataReady', {get: () => state.ready, set: v => { state.ready = !!v; }, configurable: true});
// What the Schedule shows (logic/schedule.ts view): the week and the site filter.
Object.defineProperty(window, 'weekStart', {get: () => sched.view.weekStart, set: v => { sched.view.weekStart = v; }, configurable: true});
Object.defineProperty(window, 'selectedClientId', {get: () => sched.view.clientId, set: v => { sched.view.clientId = v; }, configurable: true});
// The state the page reads by name, read-only.
const getters: Record<string, () => unknown> = {
  __uploadsInFlight: api.uploadsRunning,
  __punchLoadedFrom: punches.punchLoadedFrom,
  __punchSynced: punches.punchSynced,
  __hoursBatches: store.hoursBatches,
  __shiftReqs: sched.shiftRequests,
  I18N_LANG: i18n.currentLang,
  I18N: i18n.currentDict,
};
for (const [name, get] of Object.entries(getters)) Object.defineProperty(window, name, {get, configurable: true});

// The data layer's questions about rights and the week on screen, answered by the logic.
events.setHost({canWriteWorkers: () => access.hasPermission('workers') || access.hasPermission('schedule'),
  weekStart: () => sched.view.weekStart.toISOString()});

api.installDispatcher();
telemetry.installTelemetryFlush();
// Starts loading right away, so the SDK is ready by the time loadData() or
// the login form needs it.
api.loadFirestoreBackend().catch(e => console.warn('Firestore backend:', e));
