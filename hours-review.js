// Hours review — one screen for a client, a supplier and an HR login: the
// month's shifts of the login's own workers, a day approved, disputed (with a
// comment) or given a proposed fix (the right in / out, applied only when a
// manager accepts it in Accounting → Approvals), the whole month approved at
// once, the planned schedule and an Excel export — each by its tick (claim hp,
// HOUR_PERMS in functions-auth/core.py). The data comes only from the `hours`
// Cloud Function (functions-auth/hours.py); this file never reads Firestore.
//
// Loaded on demand by client-portal.html, supplier-portal.html and
// schedule-manager.html (an HR login) and run in the page's global scope, like
// scan-pipeline.js. It uses the page's own esc, tr, uiLocale, localYMD,
// showToast, closeModal, loadXlsx and the shift pairing
// (groupPunchesIntoShifts / analyzeDayPunches) — all three pages have them.
// docs/hours-review.md.
//
//   hoursReviewMount(el, {call: body => Promise<json>, hideOwner?: bool})
//   hoursReviewReload()

const HOURS_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/hours';
let __hrv = {el: null, call: null, hideOwner: false, month: 0, tab: 'hours', data: null, loading: false, busy: false, shown: 10, sel: null};

function hoursReviewMount(el, opts){
  __hrv = Object.assign(__hrv, {el, call: opts.call, hideOwner: !!opts.hideOwner, data: null});
  if(!document.getElementById('hoursReviewOverlay')){
    const ov = document.createElement('div');
    ov.className = 'overlay'; ov.id = 'hoursReviewOverlay';
    ov.innerHTML = '<div class="modal" id="hoursReviewModal"></div>';
    document.body.appendChild(ov);
  }
  return hoursReviewReload();
}

function hrvMonthKey(){ const n = new Date(); return localYMD(new Date(n.getFullYear(), n.getMonth() + __hrv.month, 1)).slice(0, 7); }
function hrvCan(p){ return !!(__hrv.data && (__hrv.data.perms || []).includes(p)); }
function hrvShiftMonth(n){ __hrv.month = Math.min(0, __hrv.month + n); __hrv.shown = 10; __hrv.sel = null; hoursReviewReload(); }
function hrvSwitchTab(t){ __hrv.tab = t; __hrv.sel = null; hrvRender(); }

async function hoursReviewReload(){
  const key = hrvMonthKey();
  __hrv.loading = true; hrvRender();
  try{
    const r = await __hrv.call({action: 'load', month: key});
    if(r.error){ showToast(r.error); return; }
    if(key === hrvMonthKey()) __hrv.data = r;
  }catch(e){ showToast(tr('Could not load — check the connection and try again.')); }
  finally{ __hrv.loading = false; hrvRender(); }
}

// The month's days per worker, the same pairing as the app
// (groupPunchesIntoShifts / analyzeDayPunches). A day holds every shift that
// started on it; its line "<worker>|<day>|<ins>|<outs>" (several shifts
// comma-joined) is what an approval keeps, so a later change shows.
function hrvMonthDays(){
  const d = __hrv.data;
  if(!d || !d.punches) return [];
  const [y, m] = d.month.split('-').map(Number), from = new Date(y, m - 1, 1), to = new Date(y, m, 1);
  const byW = {};
  d.punches.forEach(e => { (byW[e.workerId] = byW[e.workerId] || []).push(e); });
  const days = {};
  Object.entries(byW).forEach(([wid, list]) => groupPunchesIntoShifts(list).forEach(b => {
    if(b.date < from || b.date >= to) return;
    const inE = b.entries.find(e => e.type === 'in'), outE = [...b.entries].reverse().find(e => e.type === 'out');
    const day = localYMD(b.date), key = wid + '|' + day;
    const row = days[key] = days[key] || {key, workerId: wid, day, date: b.date, shifts: [], hours: 0};
    row.shifts.push({inT: inE && inE.time || '', outT: outE && outE.time || ''});
    row.hours += analyzeDayPunches(b.entries, b.date).hours;
  }));
  return Object.values(days).map(r => Object.assign(r, {
    line: [r.workerId, r.day, r.shifts.map(s => s.inT).join(','), r.shifts.map(s => s.outT).join(',')].join('|')
  })).sort((a, b) => a.date - b.date);
}
// A day's state: its stored entry, or "changed" when an approved (or fixed)
// day's shift is no longer the one approved.
function hrvDayState(r){
  const e = ((__hrv.data && __hrv.data.days) || {})[r.key];
  if(!e) return {st: 'pending'};
  if((e.status === 'approved' || e.status === 'fixed') && e.line !== r.line) return {st: 'changed', e};
  return {st: e.status, e};
}
const HRV_STATES = {
  pending:  {icon: 'ti-clock',          color: 'var(--text3)', label: 'Waiting for approval'},
  approved: {icon: 'ti-circle-check',   color: 'var(--green)', label: 'Approved'},
  fixed:    {icon: 'ti-circle-check',   color: 'var(--green)', label: 'Fix accepted'},
  changed:  {icon: 'ti-alert-triangle', color: 'var(--amber)', label: 'Changed after approval'},
  disputed: {icon: 'ti-alert-triangle', color: 'var(--amber)', label: 'Disputed'},
  fix:      {icon: 'ti-pencil',         color: 'var(--accent)', label: 'Fix proposed'},
  rejected: {icon: 'ti-circle-x',       color: 'var(--red)',   label: 'Fix rejected'},
};

function hrvWorkerName(id){ const w = ((__hrv.data && __hrv.data.workers) || []).find(x => x.id === id); return w ? w.name : ''; }
const hrvMsg = t => `<div style="text-align:center;padding:32px;color:var(--text3);font-size:14px">${esc(t)}</div>`;

function hrvRender(){
  const el = __hrv.el; if(!el) return;
  const [y, m] = hrvMonthKey().split('-').map(Number);
  const d = __hrv.data;
  const showHours = !d || hrvCan('hours'), showSched = !!d && hrvCan('schedule');
  if(!showHours && __hrv.tab === 'hours') __hrv.tab = 'schedule';
  if(!showSched && __hrv.tab === 'schedule') __hrv.tab = 'hours';
  const tabs = showHours && showSched ? `<div class="hrv-tabs">${['hours', 'schedule'].map(t =>
    `<button type="button" class="hrv-tab${__hrv.tab === t ? ' active' : ''}" onclick="hrvSwitchTab('${t}')">${esc(tr(t === 'hours' ? 'Hours' : 'Schedule'))}</button>`).join('')}</div>` : '';
  const owner = d && d.owner ? [d.owner.name, d.owner.object].filter(Boolean).join(' · ') : '';
  el.innerHTML = `${hrvStyle()}${tabs}
    <div class="hrv-month">
      <button type="button" onclick="hrvShiftMonth(-1)" title="${esc(tr('Previous month'))}">‹</button>
      <div class="m">${esc(new Date(y, m - 1, 1).toLocaleDateString(uiLocale(), {month: 'long', year: 'numeric'}))}</div>
      <button type="button" onclick="hrvShiftMonth(1)" title="${esc(tr('Next month'))}" ${__hrv.month >= 0 ? 'disabled style="opacity:.3"' : ''}>›</button>
    </div>
    ${owner && !__hrv.hideOwner ? `<div class="hrv-owner">${esc(owner)}</div>` : ''}
    <div id="hrvBody"></div>`;
  const body = el.querySelector('#hrvBody');
  if(!d || d.month !== hrvMonthKey()){ body.innerHTML = hrvMsg(__hrv.loading || !d ? tr('Loading…') : ''); return; }
  body.innerHTML = __hrv.tab === 'hours' ? hrvHoursHtml() : hrvScheduleHtml();
  // The workers come 10 at a time: the next 10 when "Show more" scrolls into
  // view or is tapped (the apps' list rule — CLAUDE.md, Lists page by 10).
  const more = body.querySelector('.hrv-more');
  if(more && 'IntersectionObserver' in window){
    const io = new IntersectionObserver(en => { if(en.some(x => x.isIntersecting)){ io.disconnect(); hrvMore(); } });
    io.observe(more);
  }
}
function hrvMore(){ __hrv.shown += 10; const y = window.scrollY; hrvRender(); window.scrollTo(0, y); }
// The few styles this screen needs, in the pages' own variables.
function hrvStyle(){
  return `<style>
  .hrv-tabs{display:flex;gap:6px;margin-bottom:10px;}
  .hrv-tab{position:relative;background:none;border:1px solid transparent;color:var(--text2);height:36px;padding:0 14px;font:600 13px inherit;cursor:pointer;border-radius:14px;}
  .hrv-tab.active{background:var(--glass-hi,rgba(255,255,255,.2));border-color:rgba(255,255,255,.35);color:#fff;}
  .hrv-tab.active::after{content:'';position:absolute;left:14px;right:14px;bottom:-1px;height:3px;border-radius:2px;background:var(--uline,linear-gradient(90deg,#818cf8,#22d3ee,#f472b6,#818cf8));background-size:300% 100%;box-shadow:0 0 10px rgba(34,211,238,.55);animation:og-flow 2.4s linear infinite;}
  .hrv-month{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
  .hrv-month .m{font-size:16px;font-weight:700;text-transform:capitalize;flex:1;text-align:center;}
  .hrv-month button{width:40px;height:40px;border-radius:14px;border:1px solid var(--glass-edge,rgba(255,255,255,.28));background:var(--glass,rgba(255,255,255,.12));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#fff;font-size:18px;cursor:pointer;}
  .hrv-owner{text-align:center;font-size:12px;color:var(--text2);margin-bottom:10px;}
  .hrv-status{border-radius:16px;padding:11px 14px 11px 16px;margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;background:var(--plate,#1b1e29);border:0;box-shadow:inset 4px 0 0 var(--neutral,#6b7189);}
  .hrv-status.ok{color:var(--green);box-shadow:inset 4px 0 0 var(--green);}
  .hrv-status.warn{color:var(--amber);box-shadow:inset 4px 0 0 var(--amber);}
  /* Odinson Glass plates (redesign stage 10): a worker is a section line,
     each day a plate with its state as the bar on the left (--c), hours in green. */
  .hrv-stats{display:flex;gap:18px;flex-wrap:wrap;margin:2px 2px 12px;}
  .hrv-stats div{font-size:11px;color:var(--text2);}
  .hrv-stats b{display:block;font-size:22px;font-weight:700;line-height:1.1;color:var(--text);}
  .hrv-card{margin-bottom:12px;}
  .hrv-card>div:first-child{padding:0 2px 4px;}
  .hrv-day{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 16px;margin-bottom:6px;border-radius:14px;background:var(--plate,#1b1e29);box-shadow:inset 4px 0 0 var(--c,var(--neutral,#6b7189));font-size:13px;flex-wrap:wrap;}
  .hrv-day .d{flex:1;min-width:90px;}
  .hrv-day .t{font-family:'DM Mono',ui-monospace,monospace;color:var(--text2);font-size:12px;}
  .hrv-day .h{min-width:42px;text-align:right;font:700 13px 'DM Mono',ui-monospace,monospace;color:var(--fig,#9fe6c0);}
  .hrv-day .st{font-size:16px;}
  .hrv-day .note{width:100%;font-size:11px;padding-left:2px;}
  .hrv-approve{background:var(--green-bg,rgba(109,214,160,0.12));border-color:rgba(109,214,160,0.35);color:var(--green);}
  .hrv-act{background:none;border:none;color:var(--text3);cursor:pointer;font-size:17px;padding:2px 4px;}
  .hrv-act:hover{color:var(--text);}
  .hrv-act.on{color:var(--accent);}
  /* Select mode: a tick box on every day that can still be approved, a tap
     ticks it, the glass bar approves the ticked days at once. */
  .hrv-day.can-pick{cursor:pointer;}
  .hrv-box{width:22px;height:22px;flex:none;border-radius:7px;border:2px solid rgba(255,255,255,.4);position:relative;transition:background .25s,border-color .25s;}
  .hrv-box::after{content:'';position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #0b0d14;border-width:0 3px 3px 0;transform:rotate(45deg);clip-path:inset(100% 0 0 0);transition:clip-path .35s .05s;}
  .hrv-day.picked{background:#1f2a2c;}
  .hrv-day.picked .hrv-box{background:var(--green);border-color:var(--green);}
  .hrv-day.picked .hrv-box::after{clip-path:inset(0);}
  .hrv-day.no-pick{opacity:.5;}
  .hrv-selhead{display:flex;align-items:center;gap:10px;margin:-2px 2px 10px;font-size:13px;color:var(--text2);}
  .hrv-selhead span{flex:1;}
  .hrv-selhead button{border:0;background:none;color:#fff;font:600 13px inherit;cursor:pointer;padding:2px 0;}
  .hrv-selbar{position:fixed;left:50%;bottom:16px;z-index:3400;width:min(520px,calc(100% - 28px));display:flex;align-items:center;gap:6px;padding:8px 8px 8px 14px;border-radius:18px;background:rgba(30,35,51,.8);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.24);box-shadow:0 12px 30px rgba(0,0,0,.4);color:#fff;transform:translate(-50%,0);}
  .hrv-selbar b{flex:1;font-size:14px;white-space:nowrap;}
  .hrv-selbar .gbtn{height:38px;padding:0 12px;font-size:13px;}
  .hrv-selbar .gbtn:disabled{opacity:.45;cursor:default;}
  </style>`;
}

function hrvHoursHtml(){
  const days = hrvMonthDays();
  if(!days.length) return hrvMsg(tr('No hours this month'));
  const counts = {};
  days.forEach(r => { const s = hrvDayState(r).st; counts[s] = (counts[s] || 0) + 1; });
  const done = (counts.approved || 0) + (counts.fixed || 0), open = days.length - done;
  const warn = (counts.changed || 0) + (counts.disputed || 0) + (counts.fix || 0) + (counts.rejected || 0);
  const stText = !open ? tr('Every day approved')
    : tr('{done} of {n} days approved', {done, n: days.length})
      + (counts.changed ? ' · ' + tr('{n} changed after approval', {n: counts.changed}) : '')
      + (counts.disputed ? ' · ' + tr('{n} disputed', {n: counts.disputed}) : '')
      + (counts.fix ? ' · ' + tr('{n} fixes waiting', {n: counts.fix}) : '');
  const canApproveAll = hrvCan('approve') && days.some(r => ['pending', 'changed', 'rejected'].includes(hrvDayState(r).st));
  const approveBtn = canApproveAll ? `<button class="btn sm hrv-approve" onclick="hrvApproveMonth()"><i class="ti ti-checks"></i> ${esc(tr('Approve the month'))}</button>` : '';
  const sel = __hrv.sel;
  const selectBtn = canApproveAll && !sel ? `<button class="btn sm" id="hrvSelectBtn" onclick="hrvStartSelect()"><i class="ti ti-list-check"></i> ${esc(tr('Select'))}</button>` : '';
  const exportBtn = hrvCan('export') ? `<button class="btn sm" onclick="hrvExport()"><i class="ti ti-file-spreadsheet"></i> ${esc(tr('Export'))}</button>` : '';
  const byW = {};
  days.forEach(r => { (byW[r.workerId] = byW[r.workerId] || []).push(r); });
  const total = days.reduce((t, r) => t + r.hours, 0);
  const wids = Object.keys(byW).sort((a, b) => hrvWorkerName(a).localeCompare(hrvWorkerName(b)));
  const left = wids.length - __hrv.shown;
  const cards = wids.slice(0, __hrv.shown).map(wid => {
    const list = byW[wid], hrs = list.reduce((t, r) => t + r.hours, 0);
    const rows = list.map(r => {
      const {st, e} = hrvDayState(r), S = HRV_STATES[st] || HRV_STATES.pending;
      const times = r.shifts.map(s => (s.inT || '--:--') + '–' + (s.outT || '--:--')).join(', ');
      let note = '';
      if(e && (st === 'disputed' || st === 'fix' || st === 'rejected' || st === 'fixed')){
        const fix = e.inT ? tr('Proposed: {in}–{out}', {in: e.inT, out: e.outT}) + (e.comment ? ' · ' : '') : '';
        note = `<div class="note" style="color:${S.color}"><i class="ti ${S.icon}"></i> ${esc(tr(S.label))}: ${esc(fix + (e.comment || ''))}${e.byName ? ' — ' + esc(e.byName) : ''}</div>`;
      }else if(st === 'changed') note = `<div class="note" style="color:${S.color}"><i class="ti ${S.icon}"></i> ${esc(tr('Changed after approval — check and approve again'))}</div>`;
      const k = esc(r.key);
      const acts = [
        hrvCan('approve') && !['approved', 'fixed'].includes(st) ? `<button class="hrv-act" title="${esc(tr('Approve this day'))}" onclick="hrvApproveDay('${k}')"><i class="ti ti-check"></i></button>` : '',
        hrvCan('dispute') ? `<button class="hrv-act${st === 'disputed' ? ' on' : ''}" title="${esc(tr('Dispute this day'))}" onclick="hrvOpenDispute('${k}')"><i class="ti ti-alert-triangle"></i></button>` : '',
        hrvCan('fix') ? `<button class="hrv-act${st === 'fix' ? ' on' : ''}" title="${esc(tr('Propose a fix'))}" onclick="hrvOpenFix('${k}')"><i class="ti ti-pencil"></i></button>` : '',
      ].join('');
      const pick = sel ? (HRV_PICKABLE.includes(st) ? (sel.has(r.key) ? ' can-pick picked' : ' can-pick') : ' no-pick') : '';
      return `<div class="hrv-day${pick}" data-key="${k}" style="--c:${S.color === 'var(--text3)' ? 'var(--border2)' : S.color}"${pick.includes('can-pick') ? ` onclick="hrvToggleDay('${k}')"` : ''}>
        ${sel ? (pick.includes('can-pick') ? '<span class="hrv-box"></span>' : '<span style="width:22px;flex:none"></span>') : ''}<span class="st" style="color:${S.color}" title="${esc(tr(S.label))}"><i class="ti ${S.icon}"></i></span>
        <span class="d">${esc(r.date.toLocaleDateString(uiLocale(), {weekday: 'short', day: '2-digit', month: 'short'}))}</span>
        <span class="t">${esc(times)}</span>
        <span class="h">${esc(tr('{h}h', {h: r.hours.toFixed(1)}))}</span>${sel ? '' : acts}${note}</div>`;
    }).join('');
    return `<div class="hrv-card"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
      <b>${esc(hrvWorkerName(wid))}</b><span style="color:var(--text2);font-size:12px">${esc(list.length === 1 ? tr('1 day') : tr('{n} days', {n: list.length}))} · <b style="color:var(--text)">${esc(tr('{h}h', {h: hrs.toFixed(1)}))}</b></span></div>${rows}</div>`;
  }).join('') + (left > 0 ? `<div class="hrv-more" style="text-align:center;padding:4px 0 10px"><button type="button" class="btn sm" onclick="hrvMore()"><i class="ti ti-chevron-down"></i> ${esc(tr('Show more ({0} left)', {0: left}))}</button></div>` : '');
  const fig = (n, l, col) => `<div><b style="color:${n ? col : 'var(--text3)'}">${n}</b>${esc(tr(l))}</div>`;
  const stats = `<div class="hrv-stats">${fig(done, 'Approved', 'var(--green)')}${fig(counts.pending || 0, 'Waiting for approval', 'var(--text)')}${fig((counts.disputed || 0) + (counts.changed || 0), 'Disputed', 'var(--amber)')}${fig(counts.fix || 0, 'Fix proposed', 'var(--accent)')}</div>`;
  return stats + `<div class="hrv-status ${!open ? 'ok' : warn ? 'warn' : ''}" id="hrvStatus"><span><i class="ti ${!open ? 'ti-circle-check' : warn ? 'ti-alert-triangle' : 'ti-clock'}"></i> ${esc(stText)}</span><span style="display:flex;gap:6px;flex-wrap:wrap">${exportBtn}${selectBtn}${approveBtn}</span></div>
    <div style="font-size:12px;color:var(--text2);margin:-4px 0 10px">${esc(tr('Total: {h}h', {h: total.toFixed(1)}))}</div>${sel ? hrvSelectHtml(days) : ''}${cards}`;
}

function hrvRow(key){ return hrvMonthDays().find(r => r.key === key); }
async function hrvSend(body, okText){
  if(__hrv.busy) return; __hrv.busy = true;
  try{
    const r = await __hrv.call(Object.assign({month: __hrv.data.month}, body));
    if(r.error){ showToast(r.error); return; }
    __hrv.data.days = r.days || {}; hrvRender(); showToast(okText);
  }catch(e){ showToast(tr('Could not save — check the connection and try again.')); }
  finally{ __hrv.busy = false; }
}
function hrvApproveDay(key){
  const r = hrvRow(key); if(!r) return;
  hrvSend({action: 'approve', lines: [r.line]}, tr('Day approved'));
}
// The month: every day still waiting (or changed, or whose fix was rejected);
// a day under an open dispute or fix stays as it is until the firm answers.
function hrvApproveMonth(){
  const lines = hrvMonthDays().filter(r => ['pending', 'changed', 'rejected'].includes(hrvDayState(r).st)).map(r => r.line);
  if(!lines.length || !confirm(tr('Approve all the hours of this month?'))) return;
  hrvSend({action: 'approve', lines}, tr('Approved — thank you'));
}
// Select mode: tick several days (only those still waiting, changed or whose
// fix was rejected — the same as the month button) and approve them at once.
const HRV_PICKABLE = ['pending', 'changed', 'rejected'];
function hrvPickable(){ return hrvMonthDays().filter(r => HRV_PICKABLE.includes(hrvDayState(r).st)); }
function hrvStartSelect(){ __hrv.sel = new Set(); hrvRender(); }
function hrvEndSelect(){ __hrv.sel = null; hrvRender(); }
function hrvToggleDay(key){
  const sel = __hrv.sel; if(!sel) return;
  sel.has(key) ? sel.delete(key) : sel.add(key);
  const y = window.scrollY; hrvRender(); window.scrollTo(0, y);
}
function hrvSelectAll(){
  const sel = __hrv.sel; if(!sel) return;
  const all = hrvPickable().map(r => r.key);
  if(all.every(k => sel.has(k))) sel.clear(); else all.forEach(k => sel.add(k));
  const y = window.scrollY; hrvRender(); window.scrollTo(0, y);
}
function hrvSelectHtml(days){
  const n = __hrv.sel.size, all = days.filter(r => HRV_PICKABLE.includes(hrvDayState(r).st)).length;
  return `<div class="hrv-selhead"><span>${esc(tr('{n} selected', {n}))}</span><button type="button" onclick="hrvSelectAll()">${esc(tr(n && n >= all ? 'Clear' : 'Select all'))}</button></div>
    <div class="hrv-selbar" id="hrvSelBar"><b>${esc(tr('{n} selected', {n}))}</b>
      <button type="button" class="gbtn primary" id="hrvApproveSel" onclick="hrvApproveSelected()" ${n ? '' : 'disabled'}><i class="ti ti-check"></i> ${esc(tr('Approve'))}</button>
      <button type="button" class="gbtn" onclick="hrvEndSelect()">${esc(tr('Done'))}</button></div>`;
}
async function hrvApproveSelected(){
  const sel = __hrv.sel; if(!sel || !sel.size) return;
  const lines = hrvPickable().filter(r => sel.has(r.key)).map(r => r.line);
  __hrv.sel = null;
  await hrvSend({action: 'approve', lines}, lines.length === 1 ? tr('Day approved') : tr('{n} days approved', {n: lines.length}));
}
function hrvDayTitle(r){
  return `<div style="font-size:13px;color:var(--text2);margin-bottom:10px">${esc(r.date.toLocaleDateString(uiLocale(), {weekday: 'long', day: 'numeric', month: 'long'}))} · ${esc(r.shifts.map(s => (s.inT || '--:--') + '–' + (s.outT || '--:--')).join(', '))}</div>`;
}
// A dispute window: no Save button — closing it (a tap outside) sends the
// comment; an empty comment takes the dispute back.
function hrvOpenDispute(key){
  const r = hrvRow(key); if(!r) return;
  const e = (__hrv.data.days || {})[key], was = e && e.status === 'disputed' ? e.comment || '' : '';
  document.getElementById('hoursReviewModal').innerHTML = `<div class="modal-title"><i class="ti ti-alert-triangle"></i> ${esc(tr('Dispute — {name}', {name: hrvWorkerName(r.workerId)}))}</div>
    ${hrvDayTitle(r)}
    <div class="field"><label>${esc(tr('What is wrong with this day?'))}</label><textarea id="hrvDisputeText" rows="4" placeholder="${esc(tr('e.g. left at 15:00, not 17:00'))}">${esc(was)}</textarea></div>
    <div style="font-size:11px;color:var(--text3)">${esc(tr('Saved when you close this window. Empty = no dispute.'))}</div>`;
  const ov = document.getElementById('hoursReviewOverlay');
  ov.__onUserClose = () => {
    const comment = document.getElementById('hrvDisputeText').value.trim();
    closeModal('hoursReviewOverlay');
    if(comment === was) return;
    hrvSend({action: 'dispute', workerId: r.workerId, day: r.day, line: r.line, comment}, comment ? tr('Dispute sent') : tr('Dispute removed'));
  };
  ov.classList.add('open');
  setTimeout(() => document.getElementById('hrvDisputeText').focus(), 50);
}
// A proposed fix: the right in / out (and why). Closing the window sends it
// when a time differs from the punches; the firm accepts or rejects it.
// A day with several shifts: the window first asks which shift.
function hrvOpenFix(key){
  const r = hrvRow(key); if(!r) return;
  const e = (__hrv.data.days || {})[key];
  let idx = e && e.status === 'fix' && Number.isInteger(e.shift) && r.shifts[e.shift] ? e.shift : 0;
  const s0 = r.shifts[idx];
  const inT = e && e.status === 'fix' ? e.inT : s0.inT, outT = e && e.status === 'fix' ? e.outT : s0.outT;
  const pick = r.shifts.length > 1 ? `<div class="field"><label>${esc(tr('Shift'))}</label><select id="hrvFixShift" onchange="hrvFixShiftPicked(this.value)">${r.shifts.map((x, i) =>
    `<option value="${i}"${i === idx ? ' selected' : ''}>${esc((x.inT || '--:--') + '–' + (x.outT || '--:--'))}</option>`).join('')}</select></div>` : '';
  window.__hrvFixRow = r;
  document.getElementById('hoursReviewModal').innerHTML = `<div class="modal-title"><i class="ti ti-pencil"></i> ${esc(tr('Fix — {name}', {name: hrvWorkerName(r.workerId)}))}</div>
    ${hrvDayTitle(r)}${pick}
    <div class="field-row" style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>${esc(tr('In'))}</label><input type="time" id="hrvFixIn" value="${esc(inT)}"></div>
      <div class="field" style="flex:1"><label>${esc(tr('Out'))}</label><input type="time" id="hrvFixOut" value="${esc(outT)}"></div>
    </div>
    <div class="field"><label>${esc(tr('Comment'))}</label><textarea id="hrvFixText" rows="2">${esc(e && e.status === 'fix' ? e.comment || '' : '')}</textarea></div>
    <div style="font-size:11px;color:var(--text3)">${esc(tr('Sent when you close this window. The firm accepts or rejects the fix.'))}</div>`;
  const ov = document.getElementById('hoursReviewOverlay');
  ov.__onUserClose = () => {
    const ni = document.getElementById('hrvFixIn').value, no = document.getElementById('hrvFixOut').value;
    const comment = document.getElementById('hrvFixText').value.trim();
    closeModal('hoursReviewOverlay');
    const sel = document.getElementById('hrvFixShift'); if(sel) idx = Number(sel.value) || 0;
    const s = r.shifts[idx];
    if(!ni || !no || (ni === inT && no === outT && comment === (e && e.status === 'fix' ? e.comment || '' : ''))) return;
    if(ni === s.inT && no === s.outT) return;
    hrvSend({action: 'fix', workerId: r.workerId, day: r.day, line: r.line, shift: idx, inT: ni, outT: no, comment}, tr('Fix sent'));
  };
  ov.classList.add('open');
}

function hrvFixShiftPicked(i){
  const s = (window.__hrvFixRow || {shifts: []}).shifts[Number(i) || 0]; if(!s) return;
  document.getElementById('hrvFixIn').value = s.inT || ''; document.getElementById('hrvFixOut').value = s.outT || '';
}

async function hrvExport(){
  try{ await loadXlsx(); }catch(e){ showToast(e.message); return; }
  const days = hrvMonthDays();
  const head = [tr('Worker'), tr('Date'), tr('In'), tr('Out'), tr('Hours'), tr('Status')];
  const rows = days.map(r => [hrvWorkerName(r.workerId), r.date.toLocaleDateString('en-GB'), r.shifts.map(s => s.inT).join(', '),
    r.shifts.map(s => s.outT).join(', '), Math.round(r.hours * 100) / 100, tr((HRV_STATES[hrvDayState(r).st] || HRV_STATES.pending).label)]);
  rows.push([tr('Total'), '', '', '', Math.round(days.reduce((t, r) => t + r.hours, 0) * 100) / 100, '']);
  const name = (__hrv.data.owner && __hrv.data.owner.name) || '';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[name + ' — ' + __hrv.data.month], [], head, ...rows]), tr('Hours'));
  XLSX.writeFile(wb, 'hours-' + __hrv.data.month + '.xlsx');
}

// Schedule: each worker's planned day for every day of the month — the
// weekly roster, a change for a single date winning on its date.
function hrvSchedDay(w, d){
  const day = (w.dates || {})[localYMD(d)] || (w.schedule || [])[d.getDay()] || {};
  return day.type === 'work' && day.start && day.end ? day.start + '–' + day.end : '';
}
function hrvScheduleHtml(){
  const ws = (__hrv.data.workers || []).filter(w => w.schedule);
  if(!ws.length) return hrvMsg(tr('No shifts planned yet'));
  const [y, m] = __hrv.data.month.split('-').map(Number);
  const days = []; for(let d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  const today = localYMD(new Date());
  return ws.map(w => {
    const rows = days.map(d => { const t = hrvSchedDay(w, d); return t ? `<div class="hrv-day"><span class="d"${localYMD(d) === today ? ' style="color:var(--accent);font-weight:700"' : ''}>${esc(d.toLocaleDateString(uiLocale(), {weekday: 'short', day: '2-digit', month: 'short'}))}</span><span class="t">${esc(t)}</span></div>` : ''; }).join('');
    return `<div class="hrv-card"><b>${esc(w.name)}</b>${rows || `<div style="color:var(--text3);font-size:12px;padding-top:6px">${esc(tr('No shifts planned yet'))}</div>`}</div>`;
  }).join('');
}
