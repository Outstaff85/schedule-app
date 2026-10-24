// The site's scan session kept for 3 minutes after the scan window closes (owner, 2026-10-20): its engines and
// the models they loaded stay, so the next worker's scan opens at once, without the models starting again
// (4–8 s). The camera stops the moment the window closes (session.sleep); when the time is up the session is
// stopped — its background threads terminated, the readers' sessions released — and the next scan makes a new
// one. (It replaces lab.ts, which kept the lab's page loaded in a frame the same way.)
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

/** The scan window closed: the camera stops now, the session is stopped in KEEP_MS unless taken again. */
export function releaseSession(): void {
  const s = kept;
  if (!s) return;
  s.sleep();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (kept !== s) return;
    kept = null;
    try { s.stop(); } catch { /* stopped already */ }
  }, KEEP_MS);
}

/** The session kept now (the browser tests), or null. */
export function keptSession(): ScanSession | null { return kept; }
