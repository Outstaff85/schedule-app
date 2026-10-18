// The manager page's own script, part "nav": the tabs: those a login may see and switchTab (the React frame draws them, src/manager/Frame.tsx).
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId, qsa } from './dom';
import { NAV_TAB_PERMISSION, hasPermission, homeTab, tabAllowed } from '../logic/access';
import { setFrame } from '../frame';
Object.defineProperties(window, {
  "applyNavPermissions": {get: () => applyNavPermissions, configurable: true},
  "switchTab": {get: () => switchTab, configurable: true},
});

// --- Tab ---------------------------------------------------------------------
// The sections and tabs a login may see (hasPermission, tabAllowed, homeTab,
// hrPayOnly, hrHourReview, NAV_TAB_PERMISSION, MORE_TABS…) are
// src/manager/logic/access.ts. The page shows / hides:
export function applyNavPermissions(){
  // The sections this login may see, for the React frame's menu and bottom bar (src/manager/frame.ts).
  setFrame({tabs:['dashboard', ...Object.keys(NAV_TAB_PERMISSION)].filter(tabAllowed)});
  // The Export section: the header Export menu and the salary export.
  qsa('#exportDropdown, .perm-exports').forEach((el?: any) => { el.style.display = hasPermission('exports') ? '' : 'none'; });
  // If the tab we're currently sitting on just got hidden (e.g. permissions
  // changed and the page re-initialized), fall back to the home tab rather
  // than leaving a blank/inaccessible section visible.
  if(currentTab && !tabAllowed(currentTab)) switchTab(homeTab());
}

export function switchTab(tab?: any){
  currentTab=tab;
  setFrame({tab});
  ['dashboard','schedule','workers','clients','suppliers','admin','accounting'].forEach((t?: any)=>{
    byId('section'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.toggle('visible',tab===t);
  });
  if(tab==='workers')    renderWorkersPage();
  if(tab==='clients')    renderClientsPage();
  if(tab==='suppliers')  renderSuppliersPage();
  // setupAdminPaneBar() (role-gated pane visibility + default pane) only
  // runs here, on an actual tab switch — NOT from render()'s own
  // per-mutation renderAdmin() call below, or clicking into e.g. the Firms
  // pane would get silently reset back to Punch Log on every unrelated save.
  if(tab==='admin')      setupAdminPaneBar();
  if(tab==='dashboard')  renderDashboard();
  if(tab==='schedule')   renderSchedulePage();
  if(tab==='accounting'){ __hourApprovalsCache=null; __accOpenSeq++; renderAccounting(); } // opening the tab reads the approvals afresh
  document.body.dataset.tab=tab; // V7: the Workers / Filter-by-client panel only on Workers and Schedule
  renderCrumb();
}
