// The scanner's engine (docs/scan-plan.md → S9): the sticky green frame. The corners are averaged over the
// model's answers so the frame does not jitter, a big jump starts it again; once green it sticks (owner,
// 2026-10-24: it kept moving and the 1 s countdown kept starting again): an answer within HOLD of it leaves
// it where it is, a weak or missed answer is outlived for MISS_MS (a blur, a glare), and the follow between
// answers starts the countdown again only when the document went DRIFT away since it stuck, or jumped (JERK
// in one camera frame) — not on every tremble of the hand. Ported unchanged from the lab's former plain page
// (smoothen, restartSteady, the follow's restart rule and the hint; tests/scan/engine.test.mjs).
import type { Corners, Pt, Quad } from './types';

/** Green after 0.25 s on the edges, the shot after 1 s; a move over MOVE is not still. */
export const STEADY_MS = 1000, MOVE = 0.02, LOCK_MS = 250;
export const HOLD = 0.04, MISS_MS = 600, DRIFT = 0.03, JERK = 0.02;
/** Auto turns itself off after this many of its shots in a row with no touch (owner, 2026-10-31: pointed at a
 *  keyboard it went on shooting keys and the phone grew hot). */
export const AUTO_MAX = 5;
/** Auto asks the document type model once a frame, one question at a time: a frame it refused is asked about again only
 *  once it moved LOOK_MOVE (the jump at which the sticky frame takes it for a new document; session.ts) or after
 *  LOOK_AGAIN_MS (the same frame may read better on a new look), so a keyboard in front of the camera adds little heat. */
export const LOOK_MOVE = MOVE * 3, LOOK_AGAIN_MS = 3000;
/** Auto waits at most this long for readers still loading, then goes on without them (a first open downloads them;
 *  a download that hangs must not stop Auto). */
export const READERS_WAIT_MS = 20000;
/** Auto's second counts while at least this share of the answers of the last STEADY_MS are the model's own: a lone
 *  blur or glare does not start it again (a real card under a lamp dips every 10–20 answers on a fast phone), a
 *  model that only flickers on something never gets there. */
export const SURE_SHARE = 0.8;

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
  /** Since when the model has been finding it (SURE_SHARE of its answers); null: it is not. */
  sureSince: number | null = null;
  /** The answers of the last STEADY_MS since sureSince: when, and whether it was the model's own. */
  private recent: { t: number; real: boolean }[] = [];
  private readonly now: () => number;

  /** now: the clock in ms (performance.now on the page, a fake one in the tests). */
  constructor(now: () => number = () => performance.now()) { this.now = now; }

  reset(): void { this.smooth = this.anchor = null; this.steadySince = this.missSince = 0; this.smoothConf = 0; this.sureSince = null; this.recent = []; }

  /** For how long the model has really found it (a frame only held up by the sticky frame does not count: Auto does
   *  not take what the model only flickers on — owner, 2026-10-31; a lone miss among its answers does not end it). */
  sureFor(): number { return this.sureSince === null ? 0 : this.now() - this.sureSince; }

  /** One answer counted towards sureFor. */
  private noteAnswer(now: number, real: boolean): void {
    if (real && this.sureSince === null) { this.sureSince = now; this.recent = []; }
    if (this.sureSince === null) return;
    this.recent.push({ t: now, real });
    while (this.recent[0].t <= now - STEADY_MS) this.recent.shift();
    if (this.recent.filter(a => a.real).length < SURE_SHARE * this.recent.length) { this.sureSince = null; this.recent = []; }
  }

  /** The countdown starts again from now, the frame as it is now its anchor. */
  restart(now: number): void { this.steadySince = now; this.anchor = this.smooth && this.smooth.map(p => p.slice() as Pt); }

  /** One model answer (already carried to now by the follow) → the frame to show. */
  answer(res: Corners): SteadyAnswer {
    const now = this.now(), stuck = !!this.smooth && now - this.steadySince >= LOCK_MS;
    const real = !res.pts.some(p => !p) && res.conf >= 0.5;
    this.noteAnswer(now, real);
    if (!real) {
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

/** After a shot Auto does not take the same document again (owner, 2026-10-26: the live frame goes on by itself
 *  after a shot, with no Next to tap): the frames of the documents the shot took are kept, carried along by the
 *  follow as the phone moves, and Auto waits while the model still finds one of them. It takes again once they
 *  have left the frame — no document found for AWAY_MS (longer than the sticky frame outlives a miss, MISS_MS, so
 *  the next document starts a fresh countdown; a missed frame or a glare is shorter) — or the scene
 *  changed enough: the document found lies AWAY_MOVE (a share of the picture, its farthest corner) from every
 *  one taken (another document, or the same moved well away). A document only partly in the frame (a corner
 *  out) has not left it. The shutter is never held by this. */
export const AWAY_MS = MISS_MS + 100, AWAY_MOVE = 0.12;

export class Taken {
  /** The frames of the documents of the last shot (empty: nothing to wait for). */
  quads: Quad[] = [];
  private missSince = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  /** A shot settled: these are the documents it took. */
  set(quads: Quad[]): void { this.quads = quads.map(q => q.map(p => p.slice() as Pt)); this.missSince = 0; }
  clear(): void { this.quads = []; this.missSince = 0; }
  get waiting(): boolean { return this.quads.length > 0; }

  /** The follow moved the picture by apply on one camera frame: the documents taken move with it. */
  follow(apply: (q: Quad) => Quad): void { if (this.quads.length) this.quads = this.quads.map(apply); }

  /** One model answer (raw, carried to now): whether a document taken is still in front of the camera — Auto
   *  waits while it is. */
  still(raw: Corners): boolean {
    if (!this.quads.length) return false;
    const now = this.now(), missing = raw.pts.filter(p => !p).length;
    if (missing === 4) {
      if (!this.missSince) this.missSince = now;
      if (now - this.missSince >= AWAY_MS) { this.clear(); return false; }
      return true;
    }
    this.missSince = 0;
    if (missing) return true;  // partly out of the frame: not gone
    const pts = raw.pts as Quad;
    if (this.quads.every(q => farthest(pts, q) > AWAY_MOVE)) { this.clear(); return false; }
    return true;
  }
}
