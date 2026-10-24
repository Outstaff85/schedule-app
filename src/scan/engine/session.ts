// The scanner's engine (docs/scan-plan.md → S9): one scan session — the controller the full-screen scanner
// (site and lab alike) drives, with no framework and no text of its own: the models' ways (engines.ts), the
// readers (readers.ts), the camera (camera.ts), the live frame and its follow (live.ts), the shot and its
// other documents (shot.ts). Ported from the lab's index.html (startCam, showShot, Auto, the Keep / Retake
// restart, the scan window's sleep through scan/embed.js).
//
//   const s = new ScanSession(siteSurface(token));
//   s.on('status', st => …); s.on('frame', (quad, ok) => …); s.on('page', p => …); s.on('figures', f => …);
//   await s.startCamera(video); … s.snap(); s.setAuto(false); s.wake(); s.sleep(); s.stop();
//
// Events: frame — the frame to draw, every screen frame (null when there is none; ok — green); status — the
// status line as a key (status.ts SessionStatus; the screen words it through tr()); figures — the lab's
// figures; page — each cut page the moment it exists, and again under the same id when it is refined or its
// readouts come, so the screen can delete or fix it at once.
//
// After a shot the live frame waits (as the lab's did until Looks good / Retake): wake() starts it again from a
// fresh frame — so Auto does not take the same document again.
import { Camera, type GetUserMedia, type VideoLike } from './camera';
import { Engines } from './engines';
import { Live, trackFollower, type Bitmapper, type Figures, type Follower, type SessionClock } from './live';
import { ScanLog } from './log';
import { Readers } from './readers';
import { takeShot, type ShotPage } from './shot';
import type { SessionStatus } from './status';
import { autoShot, hintOf, type SteadyAnswer } from './steady';
import type { ScanSurface } from './surface';
import type { Corners, Quad } from './types';

export interface SessionEvents {
  frame: (quad: Quad | null, ok: boolean) => void;
  status: (s: SessionStatus) => void;
  figures: (f: Figures) => void;
  page: (p: ShotPage) => void;
}

/** What the session takes of the browser (the tests give fakes). */
export interface SessionEnv extends SessionClock {
  bitmap: Bitmapper | null;
  getUserMedia: GetUserMedia;
  follower: Follower;
  /** A new training attempt's id. */
  newId(): string;
}

export function defaultSessionEnv(): SessionEnv {
  const now = (): number => performance.now();
  return {
    now,
    raf: fn => { requestAnimationFrame(() => fn()); },
    setTimeout: (fn, ms) => { setTimeout(fn, ms); },
    bitmap: typeof createImageBitmap === 'function' ? (src, opts) => createImageBitmap(src as ImageBitmapSource, opts) : null,
    getUserMedia: c => navigator.mediaDevices.getUserMedia(c),
    follower: trackFollower(now),
    newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  };
}

/** The status line for a live answer: the steady frame's hint as the session's key. */
export function liveStatus(raw: Corners, res: SteadyAnswer): SessionStatus {
  const h = hintOf(raw, res);
  switch (h.key) {
    case 'no_document': return { key: 'finding' };
    case 'corners_out': return { key: 'corners_out', n: h.n };
    case 'edges_unclear': return { key: 'edges_unclear' };
    case 'hold': return { key: 'hold', seconds: h.seconds };
    case 'found': return { key: 'found', count: 1 };
  }
}

export interface SessionParts { engines?: Engines; readers?: Readers | null; log?: ScanLog; env?: Partial<SessionEnv> }

export class ScanSession {
  readonly log: ScanLog;
  readonly engines: Engines;
  readonly readers: Readers | null;
  readonly camera: Camera;
  readonly live: Live;
  readonly env: SessionEnv;
  /** Auto takes the shot once the frame is still for a second (the lab's Auto capture, on by default). */
  auto = true;
  private shotId = 0;
  /** Bumped by sleep() / stop(): a camera start still waiting (the model loading, the permission asked) finds
   *  it changed and turns nothing on. */
  private camGen = 0;
  /** A shot is in work (from its snap until it settles, or a wake / sleep): a second snap does nothing. */
  private shotInWork = false;
  private captureMs: number | null = null;
  private listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = { frame: new Set(), status: new Set(), figures: new Set(), page: new Set() };

  constructor(readonly surface: ScanSurface, parts: SessionParts = {}) {
    this.env = { ...defaultSessionEnv(), ...parts.env };
    this.log = parts.log || parts.engines?.log || new ScanLog();
    this.engines = parts.engines || new Engines(surface, this.log);
    this.readers = parts.readers !== undefined ? parts.readers : new Readers(surface, this.log.log, this.engines.settings.cpuDir);
    this.camera = new Camera(this.env.getUserMedia);
    const env = this.env;
    this.live = new Live({
      engine: () => this.engines.engine,
      ensureSession: () => this.engines.ensureSession(),
      cameraOn: () => this.camera.on,
      log: this.log,
      answer: (raw, res) => this.answer(raw, res),
      frame: (quad, ok) => this.emit('frame', quad, ok),
      figures: () => this.emitFigures(),
      stopped: () => this.emit('status', { key: 'stopped' }),
    }, env, env.follower, env.bitmap);
    this.engines.onChange(() => this.emitFigures());
  }

  /** Listen; returns the unsubscribe. */
  on<K extends keyof SessionEvents>(ev: K, fn: SessionEvents[K]): () => void {
    this.listeners[ev].add(fn);
    return () => { this.listeners[ev].delete(fn); };
  }
  private emit<K extends keyof SessionEvents>(ev: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const fn of this.listeners[ev]) {
      try { (fn as (...a: Parameters<SessionEvents[K]>) => void)(...args); } catch { /* a listener's fault stays its own */ }
    }
  }

  /** The lab's figures now. */
  figures(): Figures {
    const st = this.engines.state;
    return { ...this.live.fig, captureMs: this.captureMs, resolution: this.camera.resolution(), loadSeconds: st.loadSeconds, runsOn: st.label };
  }
  private emitFigures(): void { this.emit('figures', this.figures()); }

  /** The models made ready as the lab's page did on open: the accurate model first (photos and PDFs can go
   *  in), then the camera's models; the readers beside them. */
  async prepare(): Promise<void> {
    if (this.readers) void this.readers.load();
    await this.engines.ensureCap().catch(e => this.log.log('Accurate model: ' + ((e as Error)?.message || e)));
    await this.engines.ensureSession().catch(e => this.log.log('Model: ' + ((e as Error)?.message || e)));
  }

  /** The camera shown in video, once the model is ready; the live frame and its follow start. */
  async startCamera(video: VideoLike): Promise<void> {
    const gen = this.camGen;
    try {
      if (this.readers) void this.readers.load();
      await this.engines.ensureSession();
      if (gen !== this.camGen) return;  // put away while the model loaded: the camera is not turned on
      const started = await this.camera.start(video);
      if (!started || gen !== this.camGen) return;  // put away while the camera started (camera.stop gave it back)
      this.emitFigures();
      this.live.show(video);
      this.emit('status', { key: 'finding' });
      this.live.start();
    } catch (e) {
      if (gen !== this.camGen) return;  // put away meanwhile: no error to show
      this.log.err('Camera / model error: ' + ((e as Error)?.message || e));
      this.emit('status', { key: 'camera_failed' });
    }
  }

  private answer(raw: Corners, res: SteadyAnswer): void {
    this.emit('status', liveStatus(raw, res));
    if (this.auto && autoShot(res)) void this.snap();
  }

  /** Take the shot (Capture, or Auto): the number of documents it held, 0 when nothing was taken — and 0 with
   *  nothing done while a shot is still in work (a shutter tap just after Auto would cut the same frame again). */
  async snap(): Promise<number> {
    if (this.shotInWork) return 0;
    this.shotInWork = true;
    let id = -1;
    try {
      return await takeShot({
        engine: () => this.engines.engine,
        live: this.live,
        readers: this.readers,
        now: () => this.env.now(),
        sleep: ms => new Promise<void>(r => this.env.setTimeout(r, ms)),
        newId: () => this.env.newId(),
        way: () => this.engines.engineWay || '',
        modelVersion: () => (this.readers && this.readers.info ? this.readers.info.version : ''),
        begin: () => (id = ++this.shotId),
        current: () => this.shotId,
        status: s => this.emit('status', s),
        page: p => this.emit('page', p),
        captured: ms => { this.captureMs = ms; this.emitFigures(); },
        log: this.log,
      });
    } catch (e) {
      this.log.err('Shot failed: ' + ((e as Error)?.message || e));
      this.emit('status', { key: 'shot_failed' });
      // the camera goes on (not when it was put away, or a newer shot took over)
      if (this.camera.on && this.live.video && (id < 0 || id === this.shotId)) { this.live.clearFrame(); this.live.start(); }
      return 0;
    } finally {
      // settled: a snap may take a shot again (not when a wake / sleep already freed it for a newer one)
      if (id < 0 || id === this.shotId) this.shotInWork = false;
    }
  }

  setAuto(on: boolean): void { this.auto = on; }
  /** The follow between the model's answers on or off (the lab's tools). */
  setFollow(on: boolean): void { this.live.follow = on; }

  /** The live frame starts again from a fresh frame (after a shot: the lab's Looks good / Retake); with the
   *  camera put away by sleep(), it starts again on the video it was shown in. */
  wake(video?: VideoLike): void {
    this.shotId++;
    this.shotInWork = false;
    this.live.clearFrame();
    const v = video || this.camera.video;
    if (this.camera.on && this.live.video) { this.emit('status', { key: 'finding' }); this.live.start(); }
    else if (v) void this.startCamera(v);
  }

  /** The scanner put away with its models kept (the scan window closed; scan/embed.js's scan-sleep): the
   *  camera stops (one still starting is not turned on), the loops end, a shot in work is dropped. */
  sleep(): void {
    this.shotId++;
    this.shotInWork = false;
    this.camGen++;
    this.live.running = false;
    this.camera.stop();
    this.live.hide();
  }

  /** Everything stopped: sleep(), and every model thread and reader session released. */
  stop(): void {
    this.sleep();
    this.engines.stopAll();
    if (this.readers) this.readers.release();
  }
}
