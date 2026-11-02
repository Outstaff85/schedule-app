// The phone's back (docs/scan.md → The scan window → Back): the Android back gesture and the browser's Back button
// go one step back inside the scanner, the innermost first — the corner editor, the page opened large, the lab's
// Lab tools drawer (and its "What the models read" sheet), then the scan window itself on the site (closed as by
// hand: back to where it was opened from) — and never leave the site. One history entry per step that is open
// (pushed when it opens, its state { scanBack: its depth }); on popstate every step above the depth landed on is
// closed, the top first. A step closed by hand (a tap, Cancel, Done, a swipe down) takes its entry back off: the
// entries above the open steps go in one history.go(-n) a moment later, and a step opened again before that reuses the
// stale top entry (React's StrictMode mounting an effect twice), so the history never grows nor keeps stale entries.
// That history.go is on its way for a moment: its popstate is ours and closes nothing, and a step opened meanwhile gets
// its entry only when it has landed (settle), as a pushState under a traversal under way is what that traversal then
// lands below, which closed the new step (a window opened right after the last one closed by hand).
//
// The lab (/scan-lab/ is the scanner page itself, opened in a tab of its own by Admin → Scanner lab): with nothing
// open, back goes to the page it was opened from when that is in this tab's history (a same-site page before it);
// as the first page of its tab, or an installed app, it keeps the person in the lab: a guard entry under the
// steps (labGuard), armed on the person's first touch or key (an entry pushed with no user activation is skipped by
// Chrome's back), so back from it lands on the lab again — and the guard is armed again on the next touch.
import * as React from 'react';

type Step = { close: () => void };
const KEY = 'scanBack';
/** How long our own history.go may stay unanswered before the history is taken as landed (ms). */
const GO_WAIT_MS = 1000;
const steps: Step[] = [];
let entries = 0;        // our entries in the history, once a history.go under way has landed
let going: number | null = null;  // our own history.go under way (its give-up timer)
let timer: number | null = null;
let listening = false;

const depthOf = (state: unknown): number => {
  const d = state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  return typeof d === 'number' && d >= 0 ? d : 0;
};
const stateAt = (depth: number): Record<string, unknown> => {
  const cur = history.state && typeof history.state === 'object' ? history.state as Record<string, unknown> : {};
  return { ...cur, [KEY]: depth };
};

/** The history made to match the steps open: entries too many gone back over at once, the missing ones pushed — not
 *  while a history.go of ours is under way (its popstate comes back here). */
function settle(): void {
  if (going != null) return;
  if (entries > steps.length) {
    const n = entries - steps.length;
    entries = steps.length;
    going = window.setTimeout(landed, GO_WAIT_MS);
    history.go(-n);
    return;
  }
  while (entries < steps.length) history.pushState(stateAt(++entries), '');
}

function landed(): void {
  if (going != null) window.clearTimeout(going);
  going = null;
  settle();
}

function onPop(e: PopStateEvent): void {
  const depth = depthOf(e.state);
  // our own history.go landed: nothing to close, and a step opened on its way gets its entry now
  if (going != null) { entries = depth; landed(); return; }
  entries = depth;
  // landed lower than the steps open: each above it closed, the top first (a close may close others: ours too)
  while (steps.length > depth) {
    const top = steps.pop()!;
    try { top.close(); } catch { /* the step's own */ }
  }
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('popstate', onPop);
}

function flush(): void {
  timer = null;
  settle();
}

/** A step opened: its history entry pushed (or the stale top one reused); the function given back takes it off
 *  when the step is closed by hand (nothing when back closed it). */
export function pushBack(close: () => void): () => void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return () => {};
  listen();
  const step: Step = { close };
  steps.push(step);
  if (timer == null) settle();  // else the entries left over are gone over a moment later: a stale one stays this step's
  return () => {
    const i = steps.indexOf(step);
    if (i < 0) return;  // closed by back: its entry is gone already
    // it and every step above it (closed with it) taken off
    steps.length = i;
    if (timer == null) timer = window.setTimeout(flush, 0);
  };
}

/** A step's back while `on`: the entry pushed when it turns on, taken off when it turns off by hand; `close` is
 *  what back does (the same as closing it by hand). */
export function useBack(on: boolean, close: () => void): void {
  const fn = React.useRef(close);
  fn.current = close;
  React.useEffect(() => {
    if (!on) return;
    return pushBack(() => fn.current());
  }, [on]);
}

/** The lab's guard (see above): armed on the person's first touch or key, unless the lab was opened from a
 *  same-site page in this tab (back then goes to it). Back with nothing open lands under it — the lab stays —
 *  and the next touch arms it again. */
export function labGuard(): void {
  if (typeof window === 'undefined') return;
  let opener = false;
  try {
    const r = document.referrer ? new URL(document.referrer) : null;
    opener = history.length > 1 && !!r && r.origin === location.origin && !r.pathname.startsWith('/scan-lab');
  } catch { opener = false; }
  if (opener) return;
  let armed = false;
  const arm = () => {
    // the guard is the bottom step: armed only while no step is open (tried again on the next touch)
    if (armed || steps.length || entries || going != null) return;
    armed = true;
    pushBack(() => { armed = false; });
  };
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, arm, true);
}

