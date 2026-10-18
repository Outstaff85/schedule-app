// The entry scripts/build-globals.mjs builds into manager-data.js: a plain
// script that schedule-manager.html loads before its own script.
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
// (and scan-pipeline.js, and the browser tests) already call, as window
// properties: the functions, the data as read / write accessors (workers,
// clients, suppliers, __dataReady), and the state the page reads as
// read-only accessors. React migration stage 8b (docs/react-migration-plan.md);
// 8c imports these modules directly and this file goes.
import * as events from './events';
import * as ids from './ids';
import * as session from './session';
import { state } from './state';
import * as stateFns from './state';
import * as api from './api';
import * as punches from './punches';
import * as store from './store';
import * as telemetry from './telemetry';

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
});

// The data, read and replaced by the page under its old names.
for (const k of ['workers', 'clients', 'suppliers'] as const)
  Object.defineProperty(window, k, {get: () => state[k], set: v => { state[k] = v; }, configurable: true});
Object.defineProperty(window, '__dataReady', {get: () => state.ready, set: v => { state.ready = !!v; }, configurable: true});
// The state the page reads by name, read-only.
const getters: Record<string, () => unknown> = {
  __uploadsInFlight: api.uploadsRunning,
  __punchLoadedFrom: punches.punchLoadedFrom,
  __punchSynced: punches.punchSynced,
  __hoursBatches: store.hoursBatches,
};
for (const [name, get] of Object.entries(getters)) Object.defineProperty(window, name, {get, configurable: true});

api.installDispatcher();
telemetry.installTelemetryFlush();
// Starts loading right away, so the SDK is ready by the time loadData() or
// the login form needs it.
api.loadFirestoreBackend().catch(e => console.warn('Firestore backend:', e));
