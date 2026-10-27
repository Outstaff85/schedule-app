// The manager page's own script, part "nav": the tabs: those a login may see and switchTab (the React frame draws them, src/manager/Frame.tsx).
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId, qsa } from './dom';
import { NAV_TABS, canAddWorkers, hasPermission, homeTab, isAccTab, tabAllowed } from '../logic/access';
import { prepareScanEarly } from '../../scan/open';
import { setFrame } from '../frame';
import { island } from '../bridge';
Object.defineProperties(window, {
  "switchTab": {get: () => switchTab, configurable: true},
});

// --- Tab ---------------------------------------------------------------------
// The sections and tabs a login may see (hasPermission, tabAllowed, homeTab,
// hrPayOnly, hrHourReview, NAV_TAB_PERMISSION, MORE_TABS…) are
// src/manager/logic/access.ts. The page shows / hides:
export function applyNavPermissions(){
  // The sections this login may see, for the React frame's menu and bottom bar (src/manager/frame.ts).
  setFrame({tabs:NAV_TABS.filter(tabAllowed)});
  // The Export section: the header Export menu and the salary export.
  qsa('#exportDropdown, .perm-exports').forEach((el?: any) => { el.style.display = hasPermission('exports') ? '' : 'none'; });
  // If the tab we're currently sitting on just got hidden (e.g. permissions
  // changed and the page re-initialized), fall back to the home tab rather
  // than leaving a blank/inaccessible section visible.
  if(currentTab && !tabAllowed(currentTab)) switchTab(homeTab());
}

// A supplier or client login (permissions plan, stage 3): its role and name
// while it uses the app (set by the gate, startPortal); its every tab is drawn
// into the one portal section (src/manager/Portal.tsx), never the firm's tabs.
let __portal: {role: 'supplier'|'client', username: string} | null = null;
export function setPortal(p: {role: 'supplier'|'client', username: string} | null){ __portal = p; }
export function portalInfo(){ return __portal ? {...__portal, tab: currentTab} : null; }

export function switchTab(tab?: any){
  currentTab=tab;
  setFrame({tab});
  if(__portal){
    NAV_TABS.forEach((t?: any)=>byId('section'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.remove('visible'));
    byId('sectionPortal')?.classList.add('visible');
    island()?.renderPortal();
    document.body.dataset.tab=tab;
    return;
  }
  NAV_TABS.forEach((t?: any)=>{
    byId('section'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.toggle('visible',tab===t);
  });
  // the Workers tab (also the landing tab): its New worker button opens the scanner, so the scanner's models start
  // now, in the background — once; opened again it only refreshes the kept session's 3 minutes (src/scan/keep.ts)
  if(tab==='workers'){   renderWorkersPage(); prepareScanEarly(canAddWorkers()); }
  if(tab==='clients')    renderClientsPage();
  if(tab==='suppliers')  renderSuppliersPage();
  // setupAdminPaneBar() (role-gated pane visibility + default pane) only
  // runs here, on an actual tab switch — NOT from render()'s own
  // per-mutation renderAdmin() call below, or clicking into e.g. the Firms
  // pane would get silently reset back to Punch Log on every unrelated save.
  if(tab==='admin')      setupAdminPaneBar();
  if(tab==='dashboard')  renderDashboard();
  if(tab==='schedule')   renderSchedulePage();
  if(isAccTab(tab)){ __hourApprovalsCache=null; __accOpenSeq++; renderAccounting(); } // opening the tab reads the approvals afresh
  document.body.dataset.tab=tab; // V7: the Workers / Filter-by-client panel only on Workers and Schedule
}
