// The scanner's engine (docs/scan-plan.md → S9): the live frame on the camera — ported unchanged from the
// lab's former plain page (loop, runOnce, frameInput, smallRGBA, followLoop, animate, the figures):
//  - up to engine.size frames are worked on at once, sent evenly spaced (the mean model time / n); 5 failed
//    frames in a row stop it; with no engine (a way that stuck was dropped) the model starts again first;
//  - each frame is scaled to S×S on the GPU (createImageBitmap) and handed to the model's thread as is — no
//    full-size copy in the page —, drawn through a small canvas where that is not possible; an answer that
//    comes after a later frame's is dropped (seq), a late one is carried to now by the follow (since);
//  - the answer goes through the sticky frame (steady.ts), then to the session (the status line, Auto);
//  - on every camera frame the follow (Lucas–Kanade, track.ts) moves the frame between the model's answers
//    (requestVideoFrameCallback, rAF where there is none); a jump or a drift starts the countdown again;
//  - every screen frame the drawn frame glides 0.35 of the way toward the latest answer.
// No DOM of its own: the clock, the frame scaling and the follow come in (the tests give fakes).
import { S } from './geometry';
import type { LoadableEngine, DetectInput } from './engines';
import type { ScanLog } from './log';
import { Steady, isGreen, type SteadyAnswer } from './steady';
import { Tracker, videoGrabber, type FollowStep } from './track';
import { mkCanvas, type Drawable } from './upright';
import type { VideoLike } from './camera';
import type { Corners, Pt, Quad } from './types';

/** The session's clock and timers (performance.now, requestAnimationFrame, setTimeout; fakes in the tests). */
export interface SessionClock {
  now(): number;
  raf(fn: () => void): void;
  setTimeout(fn: () => void, ms: number): void;
}

/** createImageBitmap, or null where the browser has none. */
export type Bitmapper = (src: VideoLike | Drawable, opts: ImageBitmapOptions) => Promise<ImageBitmap>;

/** The follow between the model's answers (a Tracker on the video's gray pyramids; the tests script one). */
export interface Follower {
  reset(): void;
  /** A model answer for the frame taken at t0, carried to now. */
  since(t0: number, pts: Quad): Quad;
  /** One camera frame: the quad moved by the motion since the last one, or null when it cannot tell. */
  step(video: VideoLike, quad: Quad | null): Promise<FollowStep | null>;
}

/** The lab's follow: track.ts's Tracker on the video's frames, grabbed TW wide (a new size starts it again). */
export function trackFollower(now: () => number): Follower {
  const t = new Tracker(), grab = videoGrabber(() => t.forget());
  return {
    reset: () => t.reset(),
    since: (t0, pts) => t.since(t0, pts) as Quad,
    step: async (video, quad) => {
      const at = now(), P = await grab(video as unknown as HTMLVideoElement);
      return P ? t.stepGray(P, quad, at) : null;
    },
  };
}

/** The lab's figures: model ms per frame, frames per second, screen frames per second, confidence, the
 *  follow's frames per second and ms, the capture ms, the camera's resolution, the model's load seconds and
 *  where it runs — null (or '') until known. */
export interface Figures {
  modelMs: number | null;
  fps: number | null;
  uiFps: number | null;
  conf: number | null;
  followFps: number | null;
  followMs: number | null;
  captureMs: number | null;
  resolution: string;
  loadSeconds: number | null;
  runsOn: string;
}

/** What the live frame needs of the session. */
export interface LiveHooks {
  engine(): LoadableEngine | null;
  ensureSession(): Promise<void>;
  /** Whether the camera is still on (a dropped engine started again resumes only then). */
  cameraOn(): boolean;
  log: ScanLog;
  /** A model answer after the sticky frame: the status line and Auto. */
  answer(raw: Corners, res: SteadyAnswer): void;
  /** The frame to draw (each screen frame), null when there is none; ok — green. */
  frame(quad: Quad | null, ok: boolean): void;
  /** A figure changed. */
  figures(): void;
  /** 5 frames failed in a row: the live frame stopped. */
  stopped(): void;
}

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const copy = (q: Quad): Quad => q.map(p => p.slice() as Pt);

// The S×S canvas a frame is scaled through when the GPU cannot scale it (one, as the lab's).
let small: OffscreenCanvas | null = null;
/** A picture (w×h) scaled to S×S → its RGBA. */
export function smallRGBA(src: VideoLike | Drawable, w: number, h: number): Uint8ClampedArray {
  if (!small) small = mkCanvas(S, S);
  const g = small.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  g.drawImage(src as CanvasImageSource, 0, 0, w, h, 0, 0, S, S);
  return g.getImageData(0, 0, S, S).data;
}

export class Live {
  running = false;
  inFlight = 0;
  private lastSent = 0;
  private seq = 0;
  private applied = 0;
  private fails = 0;
  /** The latest answer to glide toward, and the frame drawn now. */
  target: { pts: Quad; ok: boolean } | null = null;
  shown: Quad | null = null;
  /** The latest answer (after the sticky frame): what a shot takes. */
  lastRes: SteadyAnswer | null = null;
  readonly steady: Steady;
  /** The follow on (the lab's tools can turn it off). */
  follow = true;
  /** The video on the screen while the camera is shown (null once it is put away). */
  video: VideoLike | null = null;
  readonly times: number[] = [];
  private readonly frames: number[] = [];
  private readonly uiFrames: number[] = [];
  private readonly followTimes: number[] = [];
  private readonly followMs: number[] = [];
  private following = false;
  /** Bumped by startFollow() and hide(): a follow step of an earlier start (its camera-frame callback still
   *  pending on a video put away) ends instead of running beside the new one. */
  private followGen = 0;
  /** Bumped by start(): a loop of an earlier start ends instead of running beside the new one. */
  private loopGen = 0;
  private animating = false;
  private bitmapOk: boolean;
  fig: Pick<Figures, 'modelMs' | 'fps' | 'uiFps' | 'conf' | 'followFps' | 'followMs'> = { modelMs: null, fps: null, uiFps: null, conf: null, followFps: null, followMs: null };

  constructor(private readonly hooks: LiveHooks, private readonly clock: SessionClock, readonly follower: Follower, private readonly bitmap: Bitmapper | null) {
    this.steady = new Steady(() => clock.now());
    this.bitmapOk = !!bitmap;
  }

  /** The camera's video is shown: the frame is drawn every screen frame from now on. */
  show(video: VideoLike): void {
    this.video = video;
    if (!this.animating) { this.animating = true; this.clock.raf(() => this.animate()); }
  }
  /** The video put away (the scanner closed): no frame, the loops end. */
  hide(): void {
    this.video = null; this.running = false; this.target = this.shown = null;
    this.following = false; this.followGen++; this.follower.reset();
    this.hooks.frame(null, false);
  }

  /** The live frame and its follow start (again). */
  start(): void { this.running = true; this.loop(++this.loopGen); this.startFollow(); }

  /** The frame starts again from nothing (the lab's Looks good / Retake). */
  clearFrame(): void { this.steady.smooth = null; this.steady.steadySince = 0; this.target = this.shown = null; }

  /** Everything learnt about the frame forgotten (a new way: no frame, no figures from the old one). */
  forget(): void {
    this.target = this.shown = this.steady.smooth = this.lastRes = null; this.steady.steadySince = 0; this.follower.reset();
    this.times.length = this.frames.length = this.followTimes.length = this.followMs.length = 0;
    this.fig = { ...this.fig, modelMs: null, fps: null, conf: null, followFps: null, followMs: null };
    this.hooks.figures();
  }

  /** The camera frame for the model: an S×S bitmap scaled on the GPU, else its RGBA; null when the video
   *  had no frame (being hidden or stopped). */
  async frameInput(src: VideoLike, w: number, h: number): Promise<DetectInput | null> {
    if (this.bitmapOk && this.bitmap) {
      try { return { bitmap: await this.bitmap(src, { resizeWidth: S, resizeHeight: S, resizeQuality: 'low' }) }; }
      catch (e) {
        if ((e as { name?: string } | null)?.name === 'InvalidStateError') return null;
        this.bitmapOk = false; this.hooks.log.err('Frame scaling on the GPU is not available here: ' + ((e as Error)?.message || e));
      }
    }
    return { rgba: smallRGBA(src, w, h) };
  }

  /** Every screen frame the drawn frame glides toward the latest model result. */
  private animate(): void {
    const now = this.clock.now(), ui = this.uiFrames; ui.push(now); while (ui.length && now - ui[0] > 1000) ui.shift();
    this.fig.uiFps = ui.length;
    if (!this.video) { this.animating = false; return; }
    const t = this.target;
    if (!t) this.shown = null;
    else if (!this.shown) this.shown = copy(t.pts);
    else this.shown = this.shown.map((q, i) => [q[0] + (t.pts[i][0] - q[0]) * 0.35, q[1] + (t.pts[i][1] - q[1]) * 0.35] as Pt);
    this.hooks.frame(this.shown, !!(t && t.ok));
    this.clock.raf(() => this.animate());
  }

  private async runOnce(v: VideoLike): Promise<void> {
    const engine = this.hooks.engine();
    if (!engine) return;
    const my = ++this.seq;
    const t0 = this.clock.now();  // when this frame was taken: the answer is carried forward from here
    const input = await this.frameInput(v, v.videoWidth, v.videoHeight);
    if (!input) return;  // the video had no frame (being hidden or stopped)
    const { res: raw0, ms } = await engine.detect('live', input);
    let raw = raw0;
    if (!this.running || my < this.applied || !this.video) return;  // a later frame already answered, or a capture began
    this.applied = my;
    if (this.follow && !raw.pts.some(p => !p)) raw = { ...raw, pts: this.follower.since(t0, raw.pts as Quad) };
    const res = this.steady.answer(raw);
    const times = this.times, frames = this.frames;
    times.push(ms); if (times.length > 20) times.shift();
    const now = this.clock.now(); frames.push(now); while (frames.length && now - frames[0] > 2000) frames.shift();
    this.fig.modelMs = Math.round(mean(times));
    this.fig.fps = frames.length / Math.max(0.5, (now - frames[0]) / 1000);
    this.fig.conf = res.conf;
    this.target = res.pts.some(p => !p) ? null : { pts: res.pts as Quad, ok: isGreen(res, true) };
    this.lastRes = res;
    this.hooks.figures();
    this.hooks.answer(raw, res);
  }

  /** On every camera frame the frame follows the document between the model's answers. */
  private followLoop(gen: number): void {
    if (gen !== this.followGen) return;  // a newer follow runs (or the video was put away)
    const v = this.video;
    if (!this.running || !v) { this.following = false; this.follower.reset(); return; }
    const next = (): void => { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.followLoop(gen)); else this.clock.raf(() => this.followLoop(gen)); };
    if (!this.follow || !this.target) { this.follower.reset(); next(); return; }
    const t = this.clock.now();
    this.follower.step(v, this.target.pts).then(r => {
      if (r && this.target && this.running && gen === this.followGen) {
        this.target = { ...this.target, pts: r.pts };
        if (this.shown) this.shown = r.apply(this.shown);
        if (this.lastRes && !this.lastRes.pts.some(p => !p)) this.lastRes = { ...this.lastRes, pts: r.apply(this.lastRes.pts as Quad) };
        // the phone or the document moved: not still (a tremble moves the stuck frame with it, the countdown goes on)
        this.steady.follow(r.apply, r.moved);
        const now = this.clock.now(), ft = this.followTimes, fm = this.followMs;
        ft.push(now); while (ft.length && now - ft[0] > 1000) ft.shift();
        fm.push(now - t); if (fm.length > 30) fm.shift();
        this.fig.followFps = ft.length; this.fig.followMs = Math.round(mean(fm));
        this.hooks.figures();
      }
    }).catch(e => this.hooks.log.log('Follow: ' + ((e as Error)?.message || e))).finally(next);
  }
  startFollow(): void { if (!this.following) { this.following = true; this.follower.reset(); this.followLoop(++this.followGen); } }

  /** Up to engine.size frames are worked on at once, sent evenly spaced. */
  private loop(gen: number): void {
    if (!this.running || gen !== this.loopGen) return;
    const engine = this.hooks.engine();
    if (!engine) {  // dropped (a way that stuck): started again, then the live frame goes on
      this.running = false;
      this.hooks.ensureSession().then(() => { if (this.hooks.cameraOn() && this.video) this.start(); })
        .catch(e => this.hooks.log.log('Model: ' + ((e as Error)?.message || e)));
      return;
    }
    const v = this.video, n = engine.size || 1, now = this.clock.now();
    const avg = this.times.length ? mean(this.times) : 300;
    if (v && this.inFlight < n && v.readyState >= 2 && now - this.lastSent >= avg / n) {
      this.inFlight++; this.lastSent = now;
      this.runOnce(v).then(() => { this.fails = 0; }).catch(e => {
        if (!this.running || !this.video) return;
        this.hooks.log.err('Frame error: ' + ((e as Error)?.message || e));
        if (++this.fails >= 5) { this.running = false; this.hooks.log.err('Stopped after 5 failed frames'); this.hooks.stopped(); }
      }).finally(() => { this.inFlight--; });
    }
    this.clock.raf(() => this.loop(gen));
  }
}
