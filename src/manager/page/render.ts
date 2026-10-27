// The manager page's own script, part "render": render(): every open tab draws again.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { loadNotifReads, refreshBell, renderGreeting } from './header';
import { island } from '../bridge';
import { isAccTab } from '../logic/access';
import { portalInfo } from './nav';
Object.defineProperties(window, {
  "render": {get: () => render, configurable: true},
});

// --- Week nav: the React Schedule tab sets weekStart (window.ManagerBridge.setWeek) ---

// --- Render -------------------------------------------------------------------
export function render(){
  // A supplier or client login: only its portal screens (nav.ts) — no firm data here.
  if(portalInfo()){ island()?.renderPortal(); return; }
  if(currentTab==='schedule')   renderSchedulePage();
  // render() only ever refreshed the Schedule tab's own pieces above — every
  // other tab's table (Workers/Clients/Admin/Accounting) is rendered ONLY by
  // switchTab() when the tab is first opened. Every place that mutates data
  // (saveWorker, saveClient, deletePunch, ...) calls render() to reflect the
  // change, but most of them sit ON one of those other tabs while doing it —
  // so an edit silently didn't show up until switching away and back. A few
  // call sites had already patched around this ad-hoc (search
  // `currentTab==='admin'`) instead of fixing it here once for every tab and
  // every mutation.
  if(currentTab==='workers')    renderWorkersPage();
  if(currentTab==='clients')    renderClientsPage();
  if(currentTab==='suppliers')  renderSuppliersPage();
  if(currentTab==='admin')      renderAdmin();
  if(currentTab==='dashboard')  renderDashboard();
  if(isAccTab(currentTab)) renderAccounting();
  refreshBell(); loadNotifReads();
  renderGreeting();
  // The worker windows that are open (the card, the notices, the worker window) read their data again.
  if(island()) island()!.refreshWindows();
}

// The workers' requests (loadShiftRequests, decideShiftRequest), the site
// filter (filterByClient) and pruneDateShifts() are src/manager/logic/schedule.ts.
