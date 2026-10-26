// The manager page's own script, part "language": the markup's translation (applyI18n), setLanguage, the phone tables.
// One of the modules of src/manager/page/ (React migration stage 8c-3; the
// former inline script of schedule-manager.html, split by section, the same
// code in the same order — page/entry.ts imports them in that order), typed
// (strict TypeScript; loose records are `any`). Its top-level functions and variables stay
// reachable under their old global names through the window accessors below
// (the markup's onclick handlers, the React bridge, the
// other parts and the browser tests use them).
import { byId } from './dom';
import { I18N_LANGS, loadI18n, onNewerDictionary, tr } from '../logic/i18n';
import { getSession } from '../data/session';
import { API_URL } from '../data/api';
import { isAccTab } from '../logic/access';
import { setFrame } from '../frame';
import { island } from '../bridge';
Object.defineProperties(window, {
  "setLanguage": {get: () => setLanguage, configurable: true},
  "cardTables": {get: () => cardTables, configurable: true},
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
export async function setLanguage(lang?: any, opts?: any){
  lang = I18N_LANGS[lang] ? lang : 'en';
  try{ localStorage.setItem('uiLang', lang); }catch(e: any){}
  if(!(opts && opts.save === false) && getSession()){
    fetch(API_URL, {method:'POST', body: JSON.stringify({action:'updateMyLanguage', language: lang})}).catch(()=>{});
  }
  try{ await loadI18n(lang); }catch(e: any){}
  redrawForLanguage();
}
// The Language buttons are React (LanguageButton: the frame's title bar, the
// sign-in screen, the Firms screen); they follow the frame's language.
export function syncLangButtons(){ setFrame({lang:I18N_LANG}); }
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
  // the sign-in screen follows the frame's language (syncLangButtons); the Firms screen is drawn again
  try{ if(byId('firmsScreen')?.style.display === 'block' && island()) island()!.renderFirmsScreen(); }catch(e: any){}
  try{ const s = getSession(); if(s) renderAccountControl(s); }catch(e: any){}
  try{ if(typeof render === 'function') render(); }catch(e: any){}
  try{ if(typeof currentTab !== 'undefined' && isAccTab(currentTab)) renderAccounting(); }catch(e: any){}
}
// ═══ CANONICAL punch-hours calculation — single source of truth. ═══
// The one copy is src/lib/payroll.ts, loaded as payroll.js (the global
// Payroll; docs/accounting.md → Payroll module); its wrappers with the page's
// names (analyzeDayPunches, shiftPay…) are src/manager/logic/pay.ts. Do not
// add a second hours calc.
// shiftOn(), weekShifts(), workerTotalHours(), getVisible() — the Schedule's
// shifts and who it shows — are src/manager/logic/schedule.ts.

// A worker's status — active, contract expiry, documents (isActiveWorker,
// workerExpiryStatus, workerDocStatus, workerDocId…) — and the pay wrappers
// over payroll.js (shiftPay, effectiveRates, localYMD…) are
// src/manager/logic/workers.ts and pay.ts.
