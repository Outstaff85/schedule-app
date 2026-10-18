// The manager page's own script, part "nav": the tabs: showing those a login may see, the phone's More sheet, switchTab.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId, qs, qsa } from './dom';
import { MORE_TABS, NAV_TAB_PERMISSION, hasPermission, homeTab, tabAllowed } from '../logic/access';
import { esc } from '../logic/util';
import { tr } from '../logic/i18n';
Object.defineProperties(window, {
  "applyNavPermissions": {get: () => applyNavPermissions, configurable: true},
  "openMoreSheet": {get: () => openMoreSheet, configurable: true},
  "switchTab": {get: () => switchTab, configurable: true},
});

// --- Tab ---------------------------------------------------------------------
// The sections and tabs a login may see (hasPermission, tabAllowed, homeTab,
// hrPayOnly, hrHourReview, NAV_TAB_PERMISSION, MORE_TABS…) are
// src/manager/logic/access.ts. The page shows / hides:
export function applyNavPermissions(){
  ['dashboard', ...Object.keys(NAV_TAB_PERMISSION)].forEach((tab?: any)=>{
    const el = byId('tab'+tab.charAt(0).toUpperCase()+tab.slice(1));
    if(!el) return;
    el.style.display = tabAllowed(tab) ? '' : 'none';
  });
  const more = byId('tabMore');
  if(more) more.style.display = MORE_TABS.some(tabAllowed) ? '' : 'none';
  // The Export section: the header Export menu and the salary export.
  qsa('#exportDropdown, .perm-exports').forEach((el?: any) => { el.style.display = hasPermission('exports') ? '' : 'none'; });
  // If the tab we're currently sitting on just got hidden (e.g. permissions
  // changed and the page re-initialized), fall back to the home tab rather
  // than leaving a blank/inaccessible section visible.
  if(currentTab && !tabAllowed(currentTab)) switchTab(homeTab());
}

// Phone bottom bar: the sheet of the tabs under More (MORE_TABS).
function openMoreSheet(){
  const items = MORE_TABS.filter(tabAllowed).map((t?: any) => {
    const el = byId('tab'+t.charAt(0).toUpperCase()+t.slice(1));
    const icon = (el.querySelector('.ic i') || {}).className || '';
    const label = el.querySelector('.lb').textContent;
    return t3Line({c: el.style.getPropertyValue('--k'), cls: t===currentTab ? 'more-on' : '', onclick: `closeModal('moreOverlay');switchTab('${t}')`,
      av: `<span class="more-ic" style="color:${el.style.getPropertyValue('--k')}"><i class="${esc(icon)}"></i></span>`, name: esc(label), right: '<i class="ti ti-chevron-right" style="color:var(--text3)"></i>'});
  });
  byId('moreModal').innerHTML = `<div class="modal-title">${esc(tr('More'))}</div>` + items.join('');
  byId('moreOverlay').classList.add('open');
}
// A short vibration on a tap in the phone bottom bar.
qs('.top-tabs')?.addEventListener('click', () => { try{ if(matchMedia('(max-width:700px)').matches && navigator.vibrate) navigator.vibrate(8); }catch(e: any){} });
export function switchTab(tab?: any){
  currentTab=tab;
  byId('tabMore')?.classList.toggle('active', MORE_TABS.includes(tab));
  ['dashboard','schedule','workers','clients','suppliers','admin','accounting'].forEach((t?: any)=>{
    byId('tab'+t.charAt(0).toUpperCase()+t.slice(1))?.classList.toggle('active',tab===t);
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
