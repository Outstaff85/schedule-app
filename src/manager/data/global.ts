// The entry scripts/build-globals.mjs builds into manager-data.js: a plain
// script that schedule-manager.html loads before its own script. It hands the
// page the data layer under the names the page's code (and scan-pipeline.js,
// and the browser tests) already call — as window properties, the same as the
// page's own function declarations were — and starts what used to start at
// the page's load: the backend's loading, the fetch(API_URL) dispatcher and
// the telemetry flush. The data layer's own state the page still reads is
// given as read-only window properties under its old names.
// React migration stage 8b (docs/react-migration-plan.md); 8c imports these
// modules directly and this file goes.
import * as session from './session';
import * as api from './api';
import * as punches from './punches';
import * as store from './store';
import * as telemetry from './telemetry';

const w = window as unknown as Record<string, unknown>;

Object.assign(w, {
  // session
  SESSION_KEY: session.SESSION_KEY, getSession: session.getSession, saveSession: session.saveSession, clearSession: session.clearSession,
  fsTenantId: session.fsTenantId, STORAGE_KEY_BASE: session.STORAGE_KEY_BASE, STORAGE_KEY: session.STORAGE_KEY,
  gsAuth: session.gsAuth, gsAuthQuery: session.gsAuthQuery,
  // backend, dispatcher, direct calls, uploads
  API_URL: api.API_URL, SESSION_EXPIRED_ERROR: api.SESSION_EXPIRED_ERROR, loadFirestoreBackend: api.loadFirestoreBackend,
  uploadWorkerFile: api.uploadWorkerFile, gsSave: api.gsSave, gsLoad: api.gsLoad, gsSavePunch: api.gsSavePunch,
  gsDeletePunch: api.gsDeletePunch, gsUpdatePunch: api.gsUpdatePunch, gsDeleteWorkerDoc: api.gsDeleteWorkerDoc,
  // punches
  getPunchLog: punches.getPunchLog, savePunchLog: punches.savePunchLog, punchWindowStart: punches.punchWindowStart,
  ALL_PUNCHES_FROM: punches.ALL_PUNCHES_FROM, ensurePunchesSince: punches.ensurePunchesSince, ensureAllPunches: punches.ensureAllPunches,
  periodPunchStart: punches.periodPunchStart, syncPunchesFromGS: punches.syncPunchesFromGS, mergeRemotePunches: punches.mergeRemotePunches,
  // load / save / cache / watchers
  setSaveStatus: store.setSaveStatus, getDataObj: store.getDataObj, applyData: store.applyData, UNSAVED_KEY: store.UNSAVED_KEY,
  hasUnsavedLocal: store.hasUnsavedLocal, dropWorkerPhotos: store.dropWorkerPhotos, applyServerLoad: store.applyServerLoad, autoSave: store.autoSave, loadData: store.loadData,
  watchHoursBatches: store.watchHoursBatches, updateHoursBadge: store.updateHoursBadge, latestHoursBatch: store.latestHoursBatch,
  watchHrWorkers: store.watchHrWorkers,
  // telemetry
  queueTelemetry: telemetry.queueTelemetry, flushTelemetry: telemetry.flushTelemetry, reportTiming: telemetry.reportTiming,
  markFirstContent: telemetry.markFirstContent, markFreshContent: telemetry.markFreshContent, reportError: telemetry.reportError,
});
// The state the page still reads by name, read-only.
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
