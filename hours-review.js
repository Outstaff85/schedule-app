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
let __hrv = {el: null, call: null, hideOwner: false, month: 0, tab: 'hours', data: null, loading: false, busy: false, shown: 10};

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
function hrvShiftMonth(n){ __hrv.month = Math.min(0, __hrv.month + n); __hrv.shown = 10; hoursReviewReload(); }
function hrvSwitchTab(t){ __hrv.tab = t; hrvRender(); }

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
  .hrv-tab{background:none;border:none;color:var(--text2);padding:7px 12px;font:600 13px inherit;cursor:pointer;border-radius:var(--radius-sm,8px);}
  .hrv-tab.active{background:var(--bg3);color:var(--text);}
  .hrv-month{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
  .hrv-month .m{font-size:16px;font-weight:700;text-transform:capitalize;flex:1;text-align:center;}
  .hrv-month button{width:36px;height:36px;border-radius:10px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);font-size:18px;cursor:pointer;}
  .hrv-owner{text-align:center;font-size:12px;color:var(--text2);margin-bottom:10px;}
  .hrv-status{border-radius:var(--radius,12px);padding:10px 14px;margin-bottom:12px;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:space-between;background:var(--bg2);border:1px solid var(--border2);}
  .hrv-status.ok{background:var(--green-bg,rgba(109,214,160,0.12));border-color:rgba(109,214,160,0.3);color:var(--green);}
  .hrv-status.warn{background:var(--amber-bg,rgba(245,166,35,0.12));border-color:rgba(245,166,35,0.3);color:var(--amber);}
  .hrv-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius,12px);padding:12px 14px;margin-bottom:10px;}
  .hrv-day{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--border);font-size:13px;flex-wrap:wrap;}
  .hrv-day .d{flex:1;min-width:90px;}
  .hrv-day .t{font-family:'DM Mono',ui-monospace,monospace;color:var(--text2);font-size:12px;}
  .hrv-day .h{min-width:42px;text-align:right;font-weight:600;}
  .hrv-day .st{font-size:16px;}
  .hrv-day .note{width:100%;font-size:11px;padding-left:2px;}
  .hrv-approve{background:var(--green-bg,rgba(109,214,160,0.12));border-color:rgba(109,214,160,0.35);color:var(--green);}
  .hrv-act{background:none;border:none;color:var(--text3);cursor:pointer;font-size:17px;padding:2px 4px;}
  .hrv-act:hover{color:var(--text);}
  .hrv-act.on{color:var(--accent);}
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
      return `<div class="hrv-day" data-key="${k}">
        <span class="st" style="color:${S.color}" title="${esc(tr(S.label))}"><i class="ti ${S.icon}"></i></span>
        <span class="d">${esc(r.date.toLocaleDateString(uiLocale(), {weekday: 'short', day: '2-digit', month: 'short'}))}</span>
        <span class="t">${esc(times)}</span>
        <span class="h">${esc(tr('{h}h', {h: r.hours.toFixed(1)}))}</span>${acts}${note}</div>`;
    }).join('');
    return `<div class="hrv-card"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
      <b>${esc(hrvWorkerName(wid))}</b><span style="color:var(--text2);font-size:12px">${esc(list.length === 1 ? tr('1 day') : tr('{n} days', {n: list.length}))} · <b style="color:var(--text)">${esc(tr('{h}h', {h: hrs.toFixed(1)}))}</b></span></div>${rows}</div>`;
  }).join('') + (left > 0 ? `<div class="hrv-more" style="text-align:center;padding:4px 0 10px"><button type="button" class="btn sm" onclick="hrvMore()"><i class="ti ti-chevron-down"></i> ${esc(tr('Show more ({0} left)', {0: left}))}</button></div>` : '');
  return `<div class="hrv-status ${!open ? 'ok' : warn ? 'warn' : ''}" id="hrvStatus"><span><i class="ti ${!open ? 'ti-circle-check' : warn ? 'ti-alert-triangle' : 'ti-clock'}"></i> ${esc(stText)}</span><span style="display:flex;gap:6px">${exportBtn}${approveBtn}</span></div>
    <div style="font-size:12px;color:var(--text2);margin:-4px 0 10px">${esc(tr('Total: {h}h', {h: total.toFixed(1)}))}</div>${cards}`;
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
