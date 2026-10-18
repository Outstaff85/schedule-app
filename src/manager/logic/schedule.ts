// The Schedule: what is on screen (the week, the site filter), the shifts of
// a worker in that week, who is shown, and the workers' requests (from
// schedule-manager.html; docs/app-core.md → Schedule tab). Never draws: a
// change emits `data` / `requests` (data/events.ts).
import { state, getDataObj, type Rec } from '../data/state';
import { emit, notify, tr } from '../data/events';
import { autoSave } from '../data/store';
import { API_URL } from '../data/api';
import { hasPermission } from './access';
import { localYMD } from './pay';
import { getSundayOfWeek, calcHours } from './util';
import { isActiveWorker } from './workers';

// Sunday first
export const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
export const DAYS_HE = ['א',  'ב',  'ג',  'ד',  'ה',  'ו',  'ש' ];
export const WORKER_COLORS = [
  {bg: 'rgba(62,207,142,0.15)', text: '#3ecf8e'},
  {bg: 'rgba(96,165,250,0.15)', text: '#60a5fa'},
  {bg: 'rgba(251,146,60,0.15)', text: '#fb923c'},
  {bg: 'rgba(196,140,250,0.15)', text: '#c48cf5'},
  {bg: 'rgba(251,191,36,0.15)', text: '#fbbf24'},
  {bg: 'rgba(248,113,113,0.15)', text: '#f87171'},
  {bg: 'rgba(52,211,153,0.15)', text: '#34d399'},
  {bg: 'rgba(167,139,250,0.15)', text: '#a78bfa'},
];
export const CLIENT_COLORS = ['#4f8ef7','#3ecf8e','#fb923c','#c48cf5','#fbbf24','#f87171','#34d399','#a78bfa'];

/** What the Schedule shows: the week (its Sunday) and the site filter (a client id, or null = all). */
export const view = {weekStart: getSundayOfWeek(new Date()), clientId: null as string | null};

// Shifts: the weekly roster (w.schedule[0..6], Sunday first) plus changes
// made for one date only (w.dateShifts['YYYY-MM-DD'] = {type, start, end}),
// which win over the roster on that date.
export function shiftOn(w: Rec, date: Date): Rec {
  const o = w.dateShifts && w.dateShifts[localYMD(date)];
  if (o) return Object.assign({dated: true}, o);
  return (w.schedule || [])[date.getDay()] || {type: 'off', start: null, end: null};
}
// The seven shifts of the shown week (Sunday first).
export function weekShifts(w: Rec): Rec[] { return [0,1,2,3,4,5,6].map(i => { const d = new Date(view.weekStart); d.setDate(d.getDate() + i); return shiftOn(w, d); }); }
export function workerTotalHours(w: Rec): number { return weekShifts(w).reduce((s, sh) => s + (sh.type === 'work' ? calcHours(sh.start, sh.end) : 0), 0); }
// A worker with no 'work' day at all was never given a schedule — "manages
// their own hours", left out of the combined roster rather than shown as a
// row of days off in the All-sites view.
export function hasSchedule(w: Rec): boolean { return (w.schedule || []).some((s: Rec) => s.type === 'work') || weekShifts(w).some(s => s.type === 'work'); }
/** Who the Schedule and its exports show: the site's active workers, or every active worker with a schedule. */
export function getVisible(): Rec[] {
  const act = state.workers.filter(isActiveWorker);
  return view.clientId ? act.filter(w => (w.clientIds || []).includes(view.clientId)) : act.filter(hasSchedule);
}
// The Schedule tab's site filter (ManagerBridge.setClient).
export function filterByClient(cid: string | null): void { view.clientId = cid; emit('data'); }
// Date changes older than 62 days are dropped, so the worker record stays small.
export function pruneDateShifts(d: Rec | null | undefined): Rec {
  const cut = new Date(); cut.setDate(cut.getDate() - 62); const ck = localYMD(cut);
  const out: Rec = {}; Object.keys(d || {}).sort().forEach(k => { if (k >= ck) out[k] = (d as Rec)[k]; });
  return out;
}

// Workers' requests (stage 5b): the days a worker marked they can't work and
// the shifts offered to a colleague, sent from the punch page (the punch
// function writes tenants/{t}/shiftRequests). The React Schedule tab draws
// them (ManagerBridge.schedule().requests); an offer changes nothing until a
// manager with the schedule section confirms it with one tap
// (decideShiftRequest): the worker's date becomes a day off and the
// colleague's date gets the shift (both "only this date", w.dateShifts,
// saved with the workers), and the request is marked confirmed.
let reqs: Rec[] = [], reqsAt = 0, reqsBusy = false;
export const shiftRequests = (): Rec[] => reqs;
export async function loadShiftRequests(force?: boolean): Promise<void> {
  if (reqsBusy || (!force && Date.now() - reqsAt < 60e3)) return;
  reqsBusy = true; reqsAt = Date.now();
  try {
    const j = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify({action: 'loadShiftRequests'})})).json();
    if (j && j.ok) { reqs = j.requests || []; emit('requests'); }
  } catch { /* kept as it was */ }
  finally { reqsBusy = false; }
}
export async function decideShiftRequest(id: string, ok: boolean): Promise<void> {
  const q = reqs.find(x => x.id === id); if (!q || !hasPermission('schedule')) return;
  // Confirming changes both workers' dates and the request in one write
  // (firestore-backend.js): either all of it is saved or nothing, and the
  // dates are put back here if it fails.
  let a: Rec | undefined, b: Rec | undefined, before: Rec[] | null = null;
  const body: Rec = {action: 'decideShiftRequest', id, status: ok ? 'confirmed' : 'declined'};
  if (ok) {
    a = state.workers.find(w => w.id === q.workerId); b = state.workers.find(w => w.id === q.toWorkerId);
    // An own-workers HR's list holds only its own workers: a colleague of another HR isn't found here (the manager hands that shift over).
    if (!a || !b) { notify(tr('This worker is not in your list')); return; }
    before = [a.dateShifts, b.dateShifts];
    a.dateShifts = pruneDateShifts(Object.assign({}, a.dateShifts, {[q.date]: {type: 'off', start: null, end: null}}));
    b.dateShifts = pruneDateShifts(Object.assign({}, b.dateShifts, {[q.date]: {type: 'work', start: q.start, end: q.end}}));
    Object.assign(body, {schedule: getDataObj(), workerIds: [a.id, b.id]});
  }
  let j: Rec | null = null;
  try { j = await (await fetch(API_URL, {method: 'POST', body: JSON.stringify(body)})).json(); } catch { /* j stays null */ }
  if (!j || !j.ok) {
    if (before && a && b) { a.dateShifts = before[0]; b.dateShifts = before[1]; emit('data'); }
    notify(tr('Could not save the decision')); loadShiftRequests(true); return;
  }
  if (ok) autoSave(); // nothing left to write; refreshes this device's cache
  q.status = ok ? 'confirmed' : 'declined';
  emit('data'); notify(ok ? tr('Shift handed over') : tr('Offer declined'));
}
