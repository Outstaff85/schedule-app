// The manager page's own script, part "language": the markup's translation (applyI18n), the Language button and sheet, the login screen's showcase, the phone tables.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, scan-pipeline.js, the React bridge, the
// other parts and the browser tests use them).
import { byId, qs, qsa } from './dom';
import { I18N_LANGS, loadI18n, onNewerDictionary, tr } from '../logic/i18n';
import { getSession } from '../data/session';
import { API_URL } from '../data/api';
import { esc } from '../logic/util';
import { workerExpiryStatus } from '../logic/workers';
import { tabAllowed } from '../logic/access';
import { setFrame } from '../frame';
Object.defineProperties(window, {
  "applyI18n": {get: () => applyI18n, configurable: true},
  "setLanguage": {get: () => setLanguage, configurable: true},
  "placeLangButton": {get: () => placeLangButton, configurable: true},
  "LOGIN_SECTORS": {get: () => LOGIN_SECTORS, configurable: true},
  "__loginSector": {get: () => __loginSector, set: (v?: any) => { __loginSector = v; }, configurable: true},
  "__loginTimer": {get: () => __loginTimer, set: (v?: any) => { __loginTimer = v; }, configurable: true},
  "showLoginSector": {get: () => showLoginSector, configurable: true},
  "startLoginShowcase": {get: () => startLoginShowcase, configurable: true},
  "loginFx": {get: () => loginFx, configurable: true},
  "I18N_LANG_EN": {get: () => I18N_LANG_EN, configurable: true},
  "syncLangButtons": {get: () => syncLangButtons, configurable: true},
  "openLangSheet": {get: () => openLangSheet, configurable: true},
  "closeLangSheet": {get: () => closeLangSheet, configurable: true},
  "renderLangList": {get: () => renderLangList, configurable: true},
  "pickLanguage": {get: () => pickLanguage, configurable: true},
  "cardTables": {get: () => cardTables, configurable: true},
  "redrawForLanguage": {get: () => redrawForLanguage, configurable: true},
  "showContractNotice": {get: () => showContractNotice, configurable: true},
  "closeContractNotice": {get: () => closeContractNotice, configurable: true},
});

// ── Translations (docs/translations.md) ─────────────────────────────────────
// Every UI text in the code is English. tr('Total Pay') returns it in the
// language picked in the header from i18n/<lang>.json (English text → translation); a text
// the dictionary lacks shows in English. {name} placeholders take params:
// tr(text, {n: 3}). Static HTML marks its texts with
// data-i18n (text), data-i18n-placeholder, data-i18n-title; applyI18n()
// translates them. The language is this device's choice (the header's
// language select, English by default, setLanguage()); the layout never
// changes (left to right). Form 101 is outside this: it is
// always Hebrew.
// tr(), uiLocale(), storedLanguage(), loadI18n(), I18N_LANGS are
// src/manager/logic/i18n.ts; the page's markup and the
// Language button are here.
export function applyI18n(root?: any){
  const host = root || document;
  const keyOf = (el?: any, attr?: any) => { const k = '__i18n_' + attr; if(el[k] == null) el[k] = attr === 'text' ? (el.getAttribute('data-i18n') || el.textContent.trim()) : el.getAttribute('data-i18n-' + attr); return el[k]; };
  host.querySelectorAll('[data-i18n]').forEach((el?: any) => { el.textContent = tr(keyOf(el, 'text')); });
  host.querySelectorAll('[data-i18n-placeholder]').forEach((el?: any) => { el.placeholder = tr(keyOf(el, 'placeholder')); });
  host.querySelectorAll('[data-i18n-title]').forEach((el?: any) => { el.title = tr(keyOf(el, 'title')); });
}
// The language (the Language button, .lang-btn): keeps the choice on this device and redraws in it;
// a signed-in user's choice is also saved to their account (updateMyLanguage), and login brings it back on any device.
async function setLanguage(lang?: any, opts?: any){
  lang = I18N_LANGS[lang] ? lang : 'en';
  try{ localStorage.setItem('uiLang', lang); }catch(e: any){}
  if(!(opts && opts.save === false) && getSession()){
    fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyLanguage', language: lang})}).catch(()=>{});
  }
  try{ await loadI18n(lang); }catch(e: any){}
  redrawForLanguage();
}
// The one Language button sits in the title bar, or on the screen that covers
// it (login, the super-admin's Firms screen) while that one is shown.
export function placeLangButton(){
  const btn = byId('langBtn'); if(!btn) return;
  const shown = (id?: any) => { const el = byId(id); return el && el.style.display && el.style.display !== 'none' ? el : null; };
  // The login screen: its corner; the super-admin's firms list: in its
  // header row, before the buttons; otherwise the React frame's title bar, its spot before the account.
  const cover = shown('loginScreen');
  const firms = !cover && shown('firmsScreen') ? byId('firmsActions') : null;
  const host = cover || firms || qs('[data-slot-for="langBtn"]');
  btn.classList.toggle('on-cover', !!cover);
  if(!host) return;
  if(host.firstChild !== btn) host.prepend(btn);
}
['loginScreen','firmsScreen'].forEach((id?: any) => { const el = byId(id); if(el) new MutationObserver(placeLangButton).observe(el, {attributes:true, attributeFilter:['style']}); });
// The login screen's showcase: the headline turns through the sectors, the
// sector tiles light up in turn (a tap picks one and stops the turning) and
// the roles of the lit sector show below them. Runs only while the login
// screen is shown.
const LOGIN_SECTORS = [
  {title:'Staff for restaurants', roles:['Cooks','Kitchen helpers','Dishwashers','Waiters']},
  {title:'Staff for factories', roles:['Production line','Packing','Sorting','Warehouse']},
  {title:'Staff for bakeries', roles:['Bakers','Dough preparation','Packing','Night shifts']},
  {title:'Staff for catering', roles:['Event staff','Servers','Kitchen crew','Setup and cleanup']},
  {title:'Full property support', roles:['Residential and commercial','Cleaning','Maintenance and repairs','Gardening','Building care']},
  {title:'Office cleaning from 3 hours', roles:['Offices','From 3 hours a visit','Regular or one-time'], pay:true},
];
let __loginSector = 0, __loginTimer: any = null;
function showLoginSector(i?: any){
  __loginSector = i;
  const rot = byId('loginRotator'), roles = byId('loginRoles');
  if(!rot || !roles) return;
  rot.classList.add('out');
  setTimeout(() => { rot.textContent = tr(LOGIN_SECTORS[i].title); rot.classList.remove('out'); }, 250);
  qsa('#loginSectors .login-sector').forEach((b?: any) => b.classList.toggle('active', Number(b.dataset.sector) === i));
  roles.innerHTML = LOGIN_SECTORS[i].roles.map((r?: any, k?: any) => `<span class="login-role" style="animation-delay:${k * 70}ms">${esc(tr(r))}</span>`).join('')
    // Office cleaning is paid on the spot: the payment apps it takes.
    + (LOGIN_SECTORS[i].pay ? `<div class="login-pay"><span class="login-pay-label"><i class="ti ti-wallet"></i> ${esc(tr('Pay with'))}</span>`
      + `<span class="pay-badge"><span class="pay-ico gpay"><b>G</b></span>Google Pay</span>`
      + `<span class="pay-badge"><span class="pay-ico paybox"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7.4" r="3.1"/><path d="M4.2 5.2 7.8 10v8.2q0 .8.8.8h6.8q.8 0 .8-.8V10l3.6-4.8"/></svg></span>PayBox</span>`
      + `<span class="pay-badge"><span class="pay-ico bit">bit</span>bit</span>`
      + `<span class="pay-badge"><span class="pay-ico bank"><i class="ti ti-building-bank"></i></span>${esc(tr('Bank transfer'))}</span>`
      + `<span class="pay-badge"><span class="pay-ico invoice"><i class="ti ti-receipt"></i></span>${esc(tr('By invoice'))}</span></div>` : '');
}
function startLoginShowcase(){
  const screen = byId('loginScreen');
  const on = screen && screen.style.display && screen.style.display !== 'none';
  clearInterval(__loginTimer); __loginTimer = null;
  if(!on){ loginFx.stop(); return; }
  loginFx.start();
  showLoginSector(__loginSector);
  if(!(typeof window.matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches))
    __loginTimer = setInterval(() => showLoginSector((__loginSector + 1) % LOGIN_SECTORS.length), 3200);
}
byId('loginSectors').addEventListener('click', (e?: any) => {
  const b = e.target.closest('.login-sector'); if(!b) return;
  clearInterval(__loginTimer); __loginTimer = null;
  showLoginSector(Number(b.dataset.sector));
});
new MutationObserver(startLoginShowcase).observe(byId('loginScreen'), {attributes:true, attributeFilter:['style']});
// The login background: a field of drifting points joined by faint lines,
// drawn toward the pointer; a soft light follows the pointer, and the tiles
// light up under it. Runs only while the login screen is shown and the page
// is visible; nothing moves with prefers-reduced-motion.
const loginFx = (() => {
  let raf = 0, pts: any = [], w = 0, h = 0, mouse = {x: -1e4, y: -1e4}, ctx: any = null;
  const cv = byId('loginFx');
  const still = () => typeof window.matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function size(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(90, Math.max(28, w * h / 16000)));
    pts = Array.from({length: n}, () => ({x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, r: Math.random() * 1.6 + .6, g: Math.random() < .35}));
  }
  function frame(){
    ctx.clearRect(0, 0, w, h);
    for(const p of pts){
      const dx = mouse.x - p.x, dy = mouse.y - p.y, d2 = dx * dx + dy * dy;
      if(d2 < 32000){ p.vx += dx * 0.000025; p.vy += dy * 0.000025; }
      p.vx *= 0.995; p.vy *= 0.995;
      const sp = Math.hypot(p.vx, p.vy); if(sp < .12){ p.vx += (Math.random() - .5) * .05; p.vy += (Math.random() - .5) * .05; }
      p.x += p.vx; p.y += p.vy;
      if(p.x < -10) p.x = w + 10; if(p.x > w + 10) p.x = -10; if(p.y < -10) p.y = h + 10; if(p.y > h + 10) p.y = -10;
    }
    for(let i = 0; i < pts.length; i++){
      const a = pts[i];
      for(let j = i + 1; j < pts.length; j++){
        const b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
        if(d < 15000){ ctx.strokeStyle = `rgba(120,160,255,${0.16 * (1 - d / 15000)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
      const mx = a.x - mouse.x, my = a.y - mouse.y, md = mx * mx + my * my;
      if(md < 26000){ ctx.strokeStyle = `rgba(109,214,160,${0.35 * (1 - md / 26000)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
      ctx.fillStyle = a.g ? 'rgba(109,214,160,.75)' : 'rgba(150,185,255,.7)';
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  function start(){ if(raf || still() || document.hidden) return; size(); raf = requestAnimationFrame(frame); }
  function stop(){ cancelAnimationFrame(raf); raf = 0; }
  const screen = byId('loginScreen');
  screen.addEventListener('pointermove', (e?: any) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    screen.style.setProperty('--mx', e.clientX + 'px'); screen.style.setProperty('--my', e.clientY + 'px');
    const t = e.target.closest && e.target.closest('.login-feature, .login-sector');
    if(t){ const r = t.getBoundingClientRect(); t.style.setProperty('--cx', (e.clientX - r.left) + 'px'); t.style.setProperty('--cy', (e.clientY - r.top) + 'px'); }
  });
  screen.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
  window.addEventListener('resize', () => { if(raf) size(); });
  document.addEventListener('visibilitychange', () => { if(document.hidden) stop(); else if(screen.style.display && screen.style.display !== 'none') start(); });
  return {start, stop};
})();
// The Language button (.lang-btn, top right of every page) and its sheet: the
// button shows the current language's own name; a tap opens a sheet with a
// search field and every language of I18N_LANGS (own script + English name),
// the current one ticked; a pick goes through setLanguage. A tap outside the
// sheet or Escape closes it. The same code in all four pages — keep them the same.
const I18N_LANG_EN: Record<string, string> = {en:'English', he:'Hebrew', ru:'Russian'};
export function syncLangButtons(){
  setFrame({lang:I18N_LANG});
  qsa('.lang-btn .lang-btn-name').forEach((el?: any) => { el.textContent = I18N_LANGS[I18N_LANG] || I18N_LANGS.en; });
  const ov = byId('langSheet'); if(ov && ov.classList.contains('open')) renderLangList();
}
function openLangSheet(e?: any){
  if(e) e.stopPropagation();
  let ov = byId('langSheet');
  if(!ov){
    ov = document.createElement('div'); ov.id = 'langSheet'; ov.className = 'lang-ov';
    ov.innerHTML = '<div class="lang-sheet" role="dialog" aria-modal="true"><div class="lang-grab"></div><h4></h4><label class="lang-search"><i class="ti ti-search"></i><input type="search" autocomplete="off" spellcheck="false"></label><div class="lang-list"></div></div>';
    ov.addEventListener('click', (ev?: any) => { if(ev.target === ov) closeLangSheet(); });
    ov.querySelector('input').addEventListener('input', renderLangList);
    document.body.appendChild(ov);
  }
  ov.querySelector('h4').textContent = tr('Language');
  const inp = ov.querySelector('input'); inp.value = ''; inp.placeholder = tr('Search a language');
  renderLangList();
  void ov.offsetWidth; ov.classList.add('open');
}
function closeLangSheet(){ const ov = byId('langSheet'); if(ov) ov.classList.remove('open'); }
function renderLangList(){
  const ov = byId('langSheet'); if(!ov) return;
  const q = ov.querySelector('input').value.trim().toLowerCase();
  const langs = Object.keys(I18N_LANGS).filter((l?: any) => !q || [l, I18N_LANGS[l], I18N_LANG_EN[l] || ''].join(' ').toLowerCase().includes(q));
  ov.querySelector('.lang-list').innerHTML = langs.map((l?: any) => `<button type="button" class="lang-li${l === I18N_LANG ? ' on' : ''}" data-lang="${esc(l)}" onclick="pickLanguage('${esc(l)}')"><b>${esc(I18N_LANGS[l])}</b><small>${esc(I18N_LANG_EN[l] || '')}</small>${l === I18N_LANG ? '<span class="lang-tick"><i class="ti ti-check"></i></span>' : ''}</button>`).join('')
    || `<div class="lang-none">${esc(tr('No language found'))}</div>`;
}
function pickLanguage(l?: any){ closeLangSheet(); if(l !== I18N_LANG) setLanguage(l); }
document.addEventListener('keydown', (e?: any) => { if(e.key === 'Escape') closeLangSheet(); });
// Glass buttons shine on every tap (CSS .gbtn.shine).
document.addEventListener('pointerdown', (e?: any) => {
  const b = e.target.closest && e.target.closest('.gbtn'); if(!b) return;
  b.classList.remove('shine'); void b.offsetWidth; b.classList.add('shine');
  clearTimeout(b.__shineT); b.__shineT = setTimeout(() => b.classList.remove('shine'), 650);
});

// Phone layout of the tables in Admin (the Errors and Timings tables, CSS:
// table.mtable at ≤ 700 px): each cell gets its column's header as data-label,
// so a row reads as a card of "label value" lines. Runs after the section redraws.
function cardTables(root?: any){
  root.querySelectorAll('table').forEach((t?: any) => {
    t.classList.add('mtable');
    const head = t.tHead && t.tHead.rows.length ? t.tHead.rows[t.tHead.rows.length - 1] : null;
    if(!head) return;
    const labels: any = [];
    [...head.cells].forEach((c?: any) => { const n = c.colSpan || 1; for(let i = 0; i < n; i++) labels.push(c.textContent.trim()); });
    [...t.tBodies, ...(t.tFoot ? [t.tFoot] : [])].forEach((b?: any) => [...b.rows].forEach((r?: any) => {
      let col = 0;
      [...r.cells].forEach((c?: any) => { if(!c.hasAttribute('data-label') && labels[col]) c.setAttribute('data-label', labels[col]); col += c.colSpan || 1; });
    }));
  });
}
(() => {
  let queued = false;
  const run = () => { queued = false; ['sectionAdmin'].forEach((id?: any) => { const el = byId(id); if(el) cardTables(el); }); };
  const mo = new MutationObserver(() => { if(!queued){ queued = true; requestAnimationFrame(run); } });
  ['sectionAdmin'].forEach((id?: any) => { const el = byId(id); if(el) mo.observe(el, {childList:true, subtree:true}); });
})();
// A newer dictionary than the one shown: redraw in it.
onNewerDictionary(()=>redrawForLanguage());
function redrawForLanguage(){
  applyI18n();
  syncLangButtons();
  try{ if(byId('loginRoles')) showLoginSector(__loginSector); }catch(e: any){}
  try{ const s = getSession(); if(s) renderAccountControl(s); }catch(e: any){}
  try{ if(typeof render === 'function') render(); }catch(e: any){}
  try{ if(typeof currentTab !== 'undefined' && currentTab === 'accounting') renderAccounting(); }catch(e: any){}
}
// ═══ CANONICAL punch-hours calculation — single source of truth. ═══
// The one copy is src/lib/payroll.ts, loaded as payroll.js (the global
// Payroll; docs/accounting.md → Payroll module); its wrappers with the page's
// names (analyzeDayPunches, shiftPay…) are src/manager/logic/pay.ts. Do not
// add a second hours calc.
// shiftOn(), weekShifts(), workerTotalHours(), getVisible() — the Schedule's
// shifts and who it shows — are src/manager/logic/schedule.ts.

// The notice under the title bar when the app opens: how many contracts have
// expired or expire soon (workerExpiryStatus, active workers only); "Show"
// opens Today, where they are listed; ✕ hides it until the next app start.
export function showContractNotice(){
  const el=byId('contractNotice'); if(!el) return;
  let closed=false; try{ closed=sessionStorage.getItem('contractNoticeClosed')==='1'; }catch(e: any){}
  const st=workers.map(workerExpiryStatus).filter(Boolean);
  const over=st.filter((x?: any)=>x.level==='overdue').length, soon=st.length-over;
  if(closed||!st.length||!tabAllowed('dashboard')){ el.style.display='none'; return; }
  const parts: any=[]; if(over) parts.push(tr('{n} expired',{n:over})); if(soon) parts.push(tr('{n} expiring soon',{n:soon}));
  el.className='contract-notice'+(over?' over':'');
  el.innerHTML=`<i class="ti ti-alert-triangle"></i><span>${esc(tr('Contracts: {list}',{list:parts.join(', ')}))}</span>
    <button type="button" class="go" onclick="switchTab('dashboard')">${esc(tr('Show'))}</button>
    <button type="button" aria-label="${esc(tr('Close'))}" onclick="closeContractNotice()">✕</button>`;
  el.style.display='';
}
function closeContractNotice(){ try{ sessionStorage.setItem('contractNoticeClosed','1'); }catch(e: any){} showContractNotice(); }
// A worker's status — active, contract expiry, documents (isActiveWorker,
// workerExpiryStatus, workerDocStatus, workerDocId…) — and the pay wrappers
// over payroll.js (shiftPay, effectiveRates, localYMD…) are
// src/manager/logic/workers.ts and pay.ts.
