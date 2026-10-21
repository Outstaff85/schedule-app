// The scanner lab's page (scan/) in the scan window, kept loaded for 3 minutes after the window
// closes (owner, 2026-10-20): the next worker's scan opens at once, without the models starting again
// (4–8 s). An iframe moved in the page is loaded again, so the frame lives in the page's body, laid
// over the window's slot every frame while the window is open; closed, it is hidden and its camera
// stopped (scan/embed.js, "scan-sleep"), and removed — the models' memory freed — when the time is up.
const KEEP_MS = 3 * 60 * 1000;
let frame: HTMLIFrameElement | null = null;
let timer = 0;

/** Shows the lab page over `slot` (made once, then kept) until the returned function is called. */
export function showLab(slot: HTMLElement, title: string): () => void {
  window.clearTimeout(timer);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.src = '/scan/?embed=1';
    frame.allow = 'camera';
    frame.dataset.testid = 'scan-lab-frame';
    frame.setAttribute('data-vaul-no-drag', '');
    frame.className = 'rounded-lg border-0 bg-background';
    // above the window (z-50); its own pointer events, as a modal window turns them off around it
    Object.assign(frame.style, { position: 'fixed', zIndex: '51', pointerEvents: 'auto' });
    document.body.append(frame);
  }
  const f = frame;
  f.title = title;
  f.style.visibility = 'visible';
  let raf = 0;
  const follow = () => {
    const r = slot.getBoundingClientRect();
    const box = (slot.closest('[data-testid="window"]') || document.documentElement).getBoundingClientRect();
    Object.assign(f.style, {
      left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
      // cut to the window: the part of the slot scrolled out of it is not shown
      clipPath: `inset(${Math.max(0, box.top - r.top)}px ${Math.max(0, r.right - box.right)}px ${Math.max(0, r.bottom - box.bottom)}px ${Math.max(0, box.left - r.left)}px)`,
    });
    raf = requestAnimationFrame(follow);
  };
  follow();
  return () => { cancelAnimationFrame(raf); hideLab(); };
}

/** The window's Looks good / Retake on the last batch: the lab folds it (or throws it away) and its camera goes on (scan/embed.js). */
export function continueLab(discard = false) {
  frame?.contentWindow?.postMessage({ type: 'scan-continue', discard }, location.origin);
}

/** Opens the lab's corner editor on a new page (scan/embed.js → fixCorners); the page comes back fixed as a 'scan-pages' message. */
export function labFix(att: string, pg: number) {
  frame?.contentWindow?.postMessage({ type: 'scan-fix', att, pg }, location.origin);
}

/** Pages the user removed from the window: the scanner's training learns they were not wanted (docs/scan-plan.md → S8; scan/embed.js). */
export function labDeleted(pages: { att?: string; pg?: number }[]) {
  const list = pages.filter(p => p.att).map(p => ({ att: p.att, pg: p.pg || 0 }));
  if (list.length) frame?.contentWindow?.postMessage({ type: 'scan-deleted', pages: list }, location.origin);
}

/** Done: the scan's kept attempts go for training (scan/embed.js → doneAttempts; docs/scan-plan.md → S8). */
export function labDone() {
  frame?.contentWindow?.postMessage({ type: 'scan-done' }, location.origin);
}

/** Stops the lab page's camera (the page stays loaded and shown). */
export function sleepLab() {
  frame?.contentWindow?.postMessage({ type: 'scan-sleep' }, location.origin);
}

function hideLab() {
  if (!frame) return;
  frame.style.visibility = 'hidden';
  sleepLab();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { frame?.remove(); frame = null; }, KEEP_MS);
}
