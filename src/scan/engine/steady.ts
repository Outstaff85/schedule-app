// The scanner's engine (docs/scan-plan.md → S9): the sticky green frame. The corners are averaged over the
// model's answers so the frame does not jitter, a big jump starts it again; once green it sticks (owner,
// 2026-10-24: it kept moving and the 1 s countdown kept starting again): an answer within HOLD of it leaves
// it where it is, a weak or missed answer is outlived for MISS_MS (a blur, a glare), and the follow between
// answers starts the countdown again only when the document went DRIFT away since it stuck, or jumped (JERK
// in one camera frame) — not on every tremble of the hand. Ported unchanged from the lab's index.html
// (smoothen, restartSteady, the follow's restart rule and the hint; tests/scan/engine.test.mjs).
import type { Corners, Pt, Quad } from './types';

/** Green after 0.25 s on the edges, the shot after 1 s; a move over MOVE is not still. */
export const STEADY_MS = 1000, MOVE = 0.02, LOCK_MS = 250;
export const HOLD = 0.04, MISS_MS = 600, DRIFT = 0.03, JERK = 0.02;

/** How far the farthest corner of a is from its corner in b. */
export const farthest = (a: Quad, b: Quad): number => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

/** An answer after smoothing: steady — ms the frame has been still (absent when no frame); held — a weak
 *  or missed answer outlived by the stuck frame. */
export interface SteadyAnswer { pts: (Pt | null)[]; conf: number; steady?: number; held?: boolean }

/** What the status line says, as a key with its figures (the text is the screen's, through tr()). */
export type SteadyHint =
  | { key: 'no_document' }
  | { key: 'corners_out'; n: number }
  | { key: 'edges_unclear' }
  | { key: 'hold'; seconds: number }
  | { key: 'found' };

export class Steady {
  smooth: Quad | null = null;
  steadySince = 0;
  anchor: Quad | null = null;
  missSince = 0;
  smoothConf = 0;
  private readonly now: () => number;

  /** now: the clock in ms (performance.now on the page, a fake one in the tests). */
  constructor(now: () => number = () => performance.now()) { this.now = now; }

  reset(): void { this.smooth = this.anchor = null; this.steadySince = this.missSince = 0; this.smoothConf = 0; }

  /** The countdown starts again from now, the frame as it is now its anchor. */
  restart(now: number): void { this.steadySince = now; this.anchor = this.smooth && this.smooth.map(p => p.slice() as Pt); }

  /** One model answer (already carried to now by the follow) → the frame to show. */
  answer(res: Corners): SteadyAnswer {
    const now = this.now(), stuck = !!this.smooth && now - this.steadySince >= LOCK_MS;
    if (res.pts.some(p => !p) || res.conf < 0.5) {
      if (stuck && now - (this.missSince || (this.missSince = now)) < MISS_MS) return { pts: this.smooth!, conf: this.smoothConf, steady: now - this.steadySince, held: true };
      this.smooth = this.anchor = null; this.steadySince = this.missSince = 0; return res;
    }
    const pts = res.pts as Quad;
    this.missSince = 0; this.smoothConf = res.conf;
    const move = this.smooth ? farthest(pts, this.smooth) : 1;
    if (move > MOVE * 3 || !this.smooth) { this.smooth = pts.map(p => p.slice() as Pt); this.restart(now); }
    else if (!(stuck && move <= HOLD)) { const s = this.smooth; this.smooth = s.map((q, i) => [q[0] * 0.6 + pts[i][0] * 0.4, q[1] * 0.6 + pts[i][1] * 0.4] as Pt); if (move > MOVE) this.restart(now); }
    return { pts: this.smooth, conf: res.conf, steady: now - this.steadySince };
  }

  /** The follow moved the document by apply (its corners went up to moved, shares) on one camera frame:
   *  the frame moves with it; a jump, or a drift from where it stuck, starts the countdown again. */
  follow(apply: (q: Quad) => Quad, moved: number): boolean {
    if (this.smooth) this.smooth = apply(this.smooth);
    if (moved > JERK || (this.anchor && this.smooth && farthest(this.smooth, this.anchor) > DRIFT)) { this.restart(this.now()); return true; }
    return false;
  }
}

/** The frame is green: sure, and (on the camera) still for LOCK_MS. */
export const isGreen = (res: SteadyAnswer, live: boolean): boolean => res.conf >= 0.5 && (!live || (res.steady as number) >= LOCK_MS);
/** Auto takes the shot: still for STEADY_MS on a real answer (not a held one). */
export const autoShot = (res: SteadyAnswer): boolean => (res.steady as number) >= STEADY_MS && !res.held;

/** The status line for the raw answer and the smoothed one. */
export function hintOf(raw: Corners, res: SteadyAnswer): SteadyHint {
  const missing = raw.pts.filter(p => !p).length;
  if (missing) return missing === 4 ? { key: 'no_document' } : { key: 'corners_out', n: missing };
  if (res.conf < 0.5) return { key: 'edges_unclear' };
  if (res.steady != null && res.steady < STEADY_MS) return { key: 'hold', seconds: (STEADY_MS - res.steady) / 1000 };
  return { key: 'found' };
}
