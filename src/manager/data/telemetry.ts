// Error and speed telemetry (React migration stage 8b; from schedule-manager.html).
// Errors and timings are collected and written as one `logBatch` (one
// Firestore batch write), so they never compete with the requests the user is
// waiting for: the first send waits TELEMETRY_FIRST_FLUSH_MS after page load,
// later ones go out every TELEMETRY_FLUSH_MS, and whatever is left goes out
// when the page is hidden or closed. Nothing is sent before the Firebase
// sign-in. The errors land in the errors collection, the timings in the
// timings collection (Admin → Errors / Timings). The page's own hooks
// (console.error / console.warn, error toasts, form error lines) feed reportError().
import { API_URL } from './api';
import { getSession } from './session';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;

const TELEMETRY_FIRST_FLUSH_MS = 8000, TELEMETRY_FLUSH_MS = 5000;
let queue: Rec[] = [], timer: ReturnType<typeof setTimeout> | null = null;
export function queueTelemetry(item: Rec): void {
  queue.push(item);
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  if (!timer) {
    const sinceLoad = performance.now();
    timer = setTimeout(flushTelemetry, Math.max(TELEMETRY_FLUSH_MS, TELEMETRY_FIRST_FLUSH_MS - sinceLoad));
  }
}
export function flushTelemetry(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const items = queue; queue = [];
  const body = JSON.stringify({action: 'logBatch', items});
  try {
    fetch(API_URL, {method: 'POST', body}).catch(() => {});
  } catch { /* never throws for the caller */ }
}
export function installTelemetryFlush(): void {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushTelemetry(); });
  window.addEventListener('pagehide', () => flushTelemetry());
}
export function reportTiming(kind: string, totalMs: number, details?: Rec): void {
  try {
    const s: Rec = getSession() || {};
    queueTelemetry({type: 'timing', kind, totalMs: Math.round(totalMs),
      tenantId: s.viewingTenantId || s.tenantId || '', user: s.username || '', role: s.role || '',
      details: Object.assign({device: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop'}, details || {})});
  } catch { /* telemetry never breaks the caller */ }
}
// Login → first content → fresh data, measured across the reload that
// follows a login (submitLogin stores its start in sessionStorage). Without
// a pending login it measures a plain app open from page start instead.
// markFirstContent(): cached or fresh content first painted;
// markFreshContent(screen): fresh server data shown — reports once per page.
const pageStartEpoch = Math.round(performance.timeOrigin || Date.now());
let firstContentAt: number | null = null, openTimingSent = false;
export function markFirstContent(): void { if (!firstContentAt) firstContentAt = Date.now(); }
export function markFreshContent(screen: string): void {
  if (openTimingSent) return; openTimingSent = true;
  markFirstContent();
  const now = Date.now();
  let pending: Rec | null = null;
  try { pending = JSON.parse(sessionStorage.getItem('pendingLoginTiming') || 'null'); sessionStorage.removeItem('pendingLoginTiming'); } catch { /* none */ }
  if (pending && pending.t0 && now - pending.t0 < 120000) {
    reportTiming('login', now - pending.t0, {screen, loginRequestMs: pending.loginMs, firstContentMs: firstContentAt! - pending.t0,
      reloadToFreshMs: now - pageStartEpoch, pingMs: pending.pingMs, pingDoneBeforeClick: pending.pingDone});
  } else {
    reportTiming('open', now - pageStartEpoch, {screen, firstContentMs: firstContentAt! - pageStartEpoch});
  }
}
// Throttled: at most 40 per page, the same text at most once a minute.
const errSent: Record<string, number> = {};
let errCount = 0;
export function reportError(message: unknown, source?: unknown, stack?: unknown): void {
  try {
    if (errCount > 40) return;                                  // hard cap per session
    const key = String(message || '').slice(0, 120), nowT = Date.now();
    if (errSent[key] && nowT - errSent[key] < 60000) return;    // dedupe same error within 1 min
    errSent[key] = nowT; errCount++;
    queueTelemetry({type: 'error',
      page: (location.pathname.split('/').pop() || location.href),
      role: 'manager', worker: (getSession() || {} as Rec).username || '',
      message: String(message || '').slice(0, 500),
      source: String(source || '').slice(0, 300),
      stack: String(stack || '').slice(0, 1200)});
  } catch { /* telemetry never breaks the caller */ }
}
