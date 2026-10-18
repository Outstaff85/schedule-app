// The manager page's own script, part "base": the constants, the page state, the utilities left on the page.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
export {};
Object.defineProperties(window, {
  "currentTab": {get: () => currentTab, set: (v?: any) => { currentTab = v; }, configurable: true},
  "editingWorkerId": {get: () => editingWorkerId, set: (v?: any) => { editingWorkerId = v; }, configurable: true},
  "editingClientId": {get: () => editingClientId, set: (v?: any) => { editingClientId = v; }, configurable: true},
  "editingSupplierId": {get: () => editingSupplierId, set: (v?: any) => { editingSupplierId = v; }, configurable: true},
});

// --- Constants ---------------------------------------------------------------
// DAYS, DAYS_HE, WORKER_COLORS, CLIENT_COLORS are src/manager/logic/schedule.ts.

// --- State -------------------------------------------------------------------
let currentTab       = 'schedule';
let editingWorkerId: any = null; // the worker the window edits, by id (a reorder or delete can't shift it)
let editingClientId: any  = null;
let editingSupplierId: any = null;

// workers, clients and suppliers are the data layer's (src/manager/data/state.ts),
// weekStart and selectedClientId (the Schedule's week and site filter) the
// logic's (src/manager/logic/schedule.ts), read and replaced here under these names.

// --- Utils --------------------------------------------------------------------
// esc(), loadXlsx(), getSundayOfWeek(), toMins(), calcHours(), fmtDMY() are
// src/manager/logic/util.ts.
