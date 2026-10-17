// Days off and shift offers (stage 5b, docs/punch.md → My schedule): the worker
// marks a day they can't work, or offers their shift of a date to a colleague
// of their site. Everything goes through the punch function with the link's
// token; nothing changes in the schedule until a manager confirms an offer on
// the Schedule tab.
import { tr } from '@/lib/i18n';
import { getState, punchFn, set, showToast, URL_TOKEN, wpToken, type ShiftReq } from './core';

/** The worker's requests from today on and the colleagues they may offer a shift to. */
export async function loadRequests() {
  if (!URL_TOKEN || !navigator.onLine) return;
  try {
    const r = await (await punchFn({ action: 'myRequests', token: wpToken() })).json();
    if (r && !r.error) set({ requests: r.requests || [], colleagues: r.colleagues || [] });
  } catch { /* keep what is shown */ }
}

// The punch function's refusals, as the worker reads them.
const ERRORS: Record<string, () => string> = {
  'Bad date': () => tr('Pick a day from today on'),
  'No shift on this date': () => tr('You have no shift on this day'),
  'Pick a colleague from your site': () => tr('Pick a colleague from your site'),
  'This shift was already handed over': () => tr('This shift was already handed over'),
  'The manager has already decided': () => tr('The manager has already decided'),
};
const errText = (e: unknown) => (ERRORS[String(e)] || (() => tr('Could not send — try again')))();

async function call(body: Record<string, unknown>, done: () => string) {
  if (!navigator.onLine) { showToast(tr('Could not send — no connection')); return false; }
  try {
    const r = await (await punchFn({ ...body, token: wpToken() })).json();
    if (!r || r.error) { showToast(errText(r && r.error)); return false; }
    showToast(done());
    await loadRequests();
    return true;
  } catch { showToast(tr('Could not send — try again')); return false; }
}

export const setUnavailable = (date: string, on: boolean) =>
  call({ action: 'setUnavailable', date, on }, () => (on ? tr("Marked: you can't work this day") : tr('The mark is removed')));
export const offerShift = (date: string, toWorkerId: string) =>
  call({ action: 'offerShift', date, toWorkerId }, () => tr('Sent to your manager'));
export const cancelRequest = (id: string) => call({ action: 'cancelRequest', id }, () => tr('The offer is withdrawn'));

/** This date's requests: the day-off mark and the shift offer. */
export function requestsOn(date: string): { na?: ShiftReq; swap?: ShiftReq } {
  const out: { na?: ShiftReq; swap?: ShiftReq } = {};
  (getState().requests || []).forEach(q => { if (q.date === date) { if (q.kind === 'unavailable') out.na = q; else out.swap = q; } });
  return out;
}
