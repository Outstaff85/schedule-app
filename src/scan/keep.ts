// The site's scan session kept for 3 minutes after the scan window closes (owner, 2026-10-20): its engines and
// the models they loaded stay, so the next worker's scan opens at once, without the models starting again
// (4–8 s). The camera stops the moment the window closes (session.sleep); when the time is up the session is
// stopped — its background threads terminated, the readers' sessions released — and the next scan makes a new
// one.
//
// Started early (owner, 2026-10-27): when the manager opens the Workers tab (owner, 2026-10-27 — its New worker
// button opens the scanner itself) or a new worker's window, the session is made and its models started in the
// background (prepareEarly: no camera, no screen), kept the same 3 minutes as after a closed window; the scan
// window opened meanwhile takes it (takeSession), so its models are ready or well on their way. Never a second
// session: nothing is started while one is kept or in use; a kept one (not in use) is given a fresh 3 minutes
// instead — the Workers tab opened again only refreshes it.
import type { ScanSession } from './engine/session';

export const KEEP_MS = 3 * 60 * 1000;

let kept: ScanSession | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The session kept from the last scan (its timer stopped), or a new one from make(). */
export function takeSession(make: () => ScanSession): ScanSession {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!kept) kept = make();
  return kept;
}

/** s stopped in KEEP_MS unless taken again meanwhile. */
function stopLater(s: ScanSession): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (kept !== s) return;
    kept = null;
    try { s.stop(); } catch { /* stopped already */ }
  }, KEEP_MS);
}

/** The scan window closed: the camera stops now, the session is stopped in KEEP_MS unless taken again. */
export function releaseSession(): void {
  const s = kept;
  if (!s) return;
  s.sleep();
  stopLater(s);
}

/** Whether a phone has the memory for the models to start ahead of the window: not under 4 GB
 *  (navigator.deviceMemory; unknown counts as 4 — as the picked files' second thread, engines.ts growFiles). */
export const earlyAllowed = (memoryGb: number | undefined | null): boolean => (memoryGb || 4) >= 4;

/** Whether to start the session early now (the Workers tab or a new worker's window opened): only for a login that
 *  may add workers (the New worker button's right, access.ts canAddWorkers), never while the scan window is open,
 *  and not on a phone under 4 GB (earlyAllowed). */
export const earlyWanted = (o: { mayAdd: boolean; scanOpen: boolean; memoryGb?: number | null }): boolean =>
  o.mayAdd && !o.scanOpen && earlyAllowed(o.memoryGb);

/** The session made and its models started ahead of the scan window (the Workers tab or a new worker's window
 *  opened), kept KEEP_MS
 *  like a closed window's; null (nothing started) when a session is kept or in use already. A kept session not in
 *  use (its stop timer running) is given a fresh KEEP_MS instead, so the Scan tap still finds it ready; one in use
 *  (no timer) is left alone. */
export function prepareEarly(make: () => ScanSession): ScanSession | null {
  if (kept) { if (timer) stopLater(kept); return null; }
  const s = (kept = make());
  void s.prepare(true);
  stopLater(s);
  return s;
}

/** The session kept now (the browser tests), or null. */
export function keptSession(): ScanSession | null { return kept; }
