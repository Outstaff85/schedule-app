// The scanner's engine (docs/scan-plan.md → S9): one scan session — the controller the full-screen scanner
// (site and lab alike) drives, with no framework and no text of its own: the models' ways (engines.ts), the
// readers (readers.ts), the camera (camera.ts), the live frame and its follow (live.ts), the shot and its
// other documents (shot.ts). Ported from the lab's former plain page (startCam, showShot, Auto, the Keep / Retake
// restart, the scan window's sleep).
//
//   const s = new ScanSession(siteSurface(token));
//   s.on('status', st => …); s.on('frame', (quad, ok) => …); s.on('page', p => …); s.on('figures', f => …);
//   await s.startCamera(video); … s.snap(); s.setAuto(false); s.wake(); s.sleep(); s.stop();
//   await s.pick(files); s.keep(pageId); s.retake(pageId); s.remove(pageId); await s.fix(pageId, pts);
//   s.hold(); s.resume();  // a page opened large over the camera (or the corner editor): the live frame paused under it
//   s.inject(page);  // a page given back from outside (the site's page turned upright); inject(page, true): a new one (the browser tests)
//   s.done();  // or s.discard(): the window closed without Done
//
// Events: frame — the frame to draw, every screen frame (null when there is none; ok — green); status — the
// status line as a key (status.ts SessionStatus; the screen words it through tr()); figures — the lab's
// figures; page — each cut page the moment it exists, and again under the same id when it is refined or its
// readouts come, so the screen can delete or fix it at once; preview — the picked picture being worked on (its
// url, which file and page, the frame of each document as it is found), so the preview switches to it at once.
//
// Picked files (pick, files.ts): each pick is a batch of its own, its pages in the files' order. The training
// attempts (attempts.ts): every shot and picked picture is one; it is kept once Looks good was tapped on every
// page of it still shown (keep — the pages deleted do not count; while its shot is still looking for more
// documents, once the search is over, so the attempt goes with every document the shot gave, and a page found
// later must be looked at too; until then every page of it can still be fixed), at Done (done: the ones left
// alone too), retaken by Retake (retake: the
// next shot shares its group; a page already kept goes as a deleted page instead) — and so is a camera shot
// whose every page was deleted while it was undecided (remove: the screen's Delete stands for the lab's
// Retake, so a badly cut shot is never sent as kept with its pages deleted — "nothing here" on a photo that
// holds a document) —, a page deleted otherwise told to its attempt; nothing is decided by a new shot or pick
// (owner, 2026-10-24). fix(pageId, pts): the corners set by hand go with the
// attempt (edgesFixed / edgesMoreFixed) and the page is cut again under the same id. done() and discard() end
// the scan: a shot or pick in work stops, the pages are let go (the session outlives a closed window on the
// site); discard() sends nothing (the site's window closed without Done).
//
// After a shot the live frame goes on by itself once the shot has settled (owner, 2026-10-26: no Next to tap) —
// with its frame kept on the document just taken (green while held there; owner, 2026-10-27: wiped, it came back
// red and flickering), and Auto does not take the same document again: the documents the shot took are kept
// (steady.ts Taken, carried by the follow) and Auto waits until they have left the frame or the scene changed
// enough (another document found away from them); the status line says `taken` meanwhile. The shutter is never
// held by it (a person may take the same document again on purpose). After a pick the picked picture stays on
// the screen PICK_SHOWN_MS, then the live frame goes on too (a camera that gets ready meanwhile waits for it). hold() pauses the live frame (its follow, Auto)
// while a page is opened large over the camera or its corners are being fixed — a shot or a pick in work goes
// on, and the live frame does not go on after it while held — and resume() lets it go on again from a fresh
// frame. wake() starts it at once and forgets the documents taken (Retake: the same document again).
//
// keepCanvases (the lab, which has no Done and keeps its session for the page's life): only the newest that
// many pages read keep their full-size pixels; an older one is given again `released` (a 1×1 canvas: its
// thumbnail, made already, and its readouts stay), so a long lab session does not hold every cut page.
import { Attempts, type AttemptsEnv } from './attempts';
import { Camera, type GetUserMedia, type VideoLike } from './camera';
import { Engines, type EngineSettings } from './engines';
import { Live, trackFollower, type Bitmapper, type Figures, type Follower, type SessionClock } from './live';
import { ScanLog } from './log';
import { Readers } from './readers';
import { analyzePicture, defaultFilesEnv, pickedPictures, workPictures, type FilesEnv, type LaneEngine, type PickFile, type PictureStage } from './files';
import { info, readPage, takeShot, toCanvas, type ShotPage, type ShotRecord } from './shot';
import { mkCanvas } from './upright';
import type { SessionStatus } from './status';
import { autoShot, hintOf, type SteadyAnswer } from './steady';
import type { ScanSurface } from './surface';
import type { Corners, Pt, Quad } from './types';

const copy = (q: Quad): Quad => q.map(p => p.slice() as Pt);
/** How long a picked picture stays on the screen after its pick, with the frame of each document found on it,
 *  before the live frame goes on (ms; owner, 2026-10-27: 1.5 s was too short to see the frames). */
export const PICK_SHOWN_MS = 2500;
const errText = (e: unknown): string => String((e as Error)?.message || e);

/** The picked picture being worked on: its pick (batch), its place in the pick (n, 1-based), its url, which file
 *  and page it is, what is being done — finding the document, cutting one out (quad: its frame on the picture),
 *  done (quad: the first document's frame, null when the page was taken whole). */
export interface PreviewEvent { batch: number; n: number; url: string; file: number; files: number; page: number; pages: number; stage: PictureStage | 'done'; quad: Quad | null }

export interface SessionEvents {
  frame: (quad: Quad | null, ok: boolean) => void;
  status: (s: SessionStatus) => void;
  figures: (f: Figures) => void;
  page: (p: ShotPage) => void;
  preview: (p: PreviewEvent) => void;
}

/** What the session takes of the browser (the tests give fakes). */
export interface SessionEnv extends SessionClock {
  bitmap: Bitmapper | null;
  getUserMedia: GetUserMedia;
  follower: Follower;
  /** A new training attempt's id. */
  newId(): string;
  /** Opening picked files (pdf.js, object URLs, decoding). */
  files: FilesEnv;
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
    files: defaultFilesEnv(),
  };
}

/** The status line for a live answer: the steady frame's hint as the session's key — `taken` in place of the
 *  countdown and found while a document the last shot took is still in front of the camera (Auto waits). */
export function liveStatus(raw: Corners, res: SteadyAnswer, waiting = false): SessionStatus {
  const h = hintOf(raw, res);
  if (waiting && (h.key === 'hold' || h.key === 'found')) return { key: 'taken' };
  switch (h.key) {
    case 'no_document': return { key: 'finding' };
    case 'corners_out': return { key: 'corners_out', n: h.n };
    case 'edges_unclear': return { key: 'edges_unclear' };
    case 'hold': return { key: 'hold', seconds: h.seconds };
    case 'found': return { key: 'found', count: 1 };
  }
}

export interface SessionParts {
  engines?: Engines; readers?: Readers | null; log?: ScanLog; env?: Partial<SessionEnv>; attempts?: Attempts; attemptsEnv?: Partial<AttemptsEnv>;
  /** Only the newest this many pages read keep their full-size pixels (the lab); unset: all of them, until Done. */
  keepCanvases?: number;
}

export class ScanSession {
  readonly log: ScanLog;
  readonly engines: Engines;
  readonly readers: Readers | null;
  readonly camera: Camera;
  readonly live: Live;
  readonly attempts: Attempts;
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
  private batchSeq = 0;
  /** The pages given so far (by id), for fix / remove / keep; the ones removed or retaken are never given again
   *  (a late refine or readouts of a page deleted at once), nor a fixed one by the shot or pick that made it. */
  readonly pages = new Map<string, ShotPage>();
  private removed = new Set<string>();
  private fixedPages = new Set<string>();
  /** Looks good on a page of the shot still in work: attempt → shot, decided once that shot settles. */
  private keepAfterShot = new Map<string, number>();
  /** Every page of the shot still in work deleted: attempt → shot, retaken once that shot settles with none left. */
  private retakeAfterShot = new Map<string, number>();
  /** Pages being cut again by fix() (their pixels are not released meanwhile). */
  private fixing = new Set<string>();
  private readonly keepCanvases: number | null;
  /** switchWay one at a time, the newest settings winning; switching: one is at work (the live frame does not go
   *  on meanwhile — the switch starts it on the new way when it is over). */
  private switchSeq = 0;
  private switchChain: Promise<void> = Promise.resolve();
  private switching = 0;
  /** The pages Looks good was tapped on, by attempt: the attempt is kept once every page of it still shown is. */
  private looked = new Map<string, Set<string>>();
  /** The screen holds the live frame (a page opened large over it): it does not go on until resume(). */
  private held = false;
  /** Picks in work (wake waits for them). */
  private picking = 0;
  /** The last pick's picture still shown (PICK_SHOWN_MS after it settled): the camera getting ready meanwhile does
   *  not start the live frame over it. */
  private pickShown = false;
  private pickShownGen = 0;
  /** Bumped by done() / discard(): a pick still in work gives nothing more. */
  private scanGen = 0;
  /** One pick at a time, in the order picked. */
  private pickChain: Promise<unknown> = Promise.resolve();
  private listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = { frame: new Set(), status: new Set(), figures: new Set(), page: new Set(), preview: new Set() };

  constructor(readonly surface: ScanSurface, parts: SessionParts = {}) {
    this.env = { ...defaultSessionEnv(), ...parts.env };
    this.log = parts.log || parts.engines?.log || new ScanLog();
    this.engines = parts.engines || new Engines(surface, this.log);
    // the readers share the engines' one read of models.json per open
    this.readers = parts.readers !== undefined ? parts.readers : new Readers(surface, this.log.log, this.engines.settings.cpuDir, () => this.engines.modelsInfo());
    this.camera = new Camera(this.env.getUserMedia);
    this.attempts = parts.attempts || new Attempts(surface, this.log, parts.attemptsEnv);
    this.keepCanvases = parts.keepCanvases ?? null;
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
    // a new listener of the pages hears the ones held now, in the order given: the scan window listens in its
    // effects, a moment after its first paint, and a page given meanwhile (the browser tests give one as soon as
    // the window shows) was never shown in its strip nor typed (as the screen's fake session, ui/fake-session.ts)
    if (ev === 'page') {
      for (const p of [...this.pages.values()]) {
        try { (fn as SessionEvents['page'])(p); } catch { /* a listener's fault stays its own */ }
      }
    }
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

  /** A page given (or given again under its id). */
  private putPage(p: ShotPage, fromFix = false): void {
    if (this.removed.has(p.id) || (!fromFix && this.fixedPages.has(p.id))) return;
    this.pages.set(p.id, p);
    this.emit('page', p);
    if (p.readouts) this.releaseOld();
  }
  /** keepCanvases: the pages read beyond the newest that many given again with a 1×1 canvas (released). */
  private releaseOld(): void {
    const n = this.keepCanvases;
    if (n == null) return;
    const heavy = [...this.pages.values()].filter(p => !p.released && p.readouts && !this.fixing.has(p.id));
    for (const p of heavy.slice(0, Math.max(0, heavy.length - n))) {
      const light: ShotPage = { ...p, canvas: mkCanvas(1, 1), released: true };
      this.pages.set(p.id, light);
      this.emit('page', light);
    }
  }
  /** A page given from outside the scan's own work, under its id: the site's scan window gives back a page it
   *  turned upright (Haiku said it lay on its side) — only a page this scan still holds (one of a scan that
   *  ended, given back late, is not taken into the next) —, and the browser tests give new pages with no camera
   *  (`fresh`). A page removed is never given again. */
  inject(p: ShotPage, fresh = false): void {
    if (!fresh && !this.pages.has(p.id)) return;
    this.putPage(p, true);
  }
  private modelVersion(): string { return this.readers && this.readers.info ? this.readers.info.version : ''; }
  private sleepMs(ms: number): Promise<void> { return new Promise<void>(r => this.env.setTimeout(r, ms)); }

  /** The models made ready on open — the light model first (owner, 2026-10-27): the live frame's model on its way,
   *  so the camera and its frame come as soon as it is ready, then the accurate model right after it (photos and
   *  PDFs picked meanwhile wait for it); the readers beside them. */
  //
  // early (the manager's new worker window, keep.ts prepareEarly): the same start with no scanner open yet — the
  // scanner's open is not marked (its "Ready" line counts from the open that takes the session).
  async prepare(early = false): Promise<void> {
    if (!early) this.markOpen();
    this.attempts.start();
    if (this.readers) void this.readers.load();
    await this.engines.ensureSession().catch(e => this.log.log('Model: ' + ((e as Error)?.message || e)));
    await this.engines.ensureCap().catch(e => this.log.log('Accurate model: ' + ((e as Error)?.message || e)));
  }

  /** When the scanner opened (env.now()), until its first live frame: "Ready: first frame after N ms" goes to the
   *  log then (the lab's loading log; the owner's measure of Preparing…). */
  private openedAt: number | null = null;
  /** The scanner opened now (the site's window, the lab's page): the log's "Time:" lines count from here too. */
  markOpen(): void {
    this.openedAt = this.env.now();
    this.log.markOpen();
    this.log.log('Time: scanner opened' + (this.engines.engine ? ' — its models kept from the last scan' : ''));
  }

  /** The camera shown in video, once the model is ready; the live frame and its follow start. */
  async startCamera(video: VideoLike): Promise<void> {
    const gen = this.camGen;
    try {
      if (this.readers) void this.readers.load();
      await this.engines.ensureSession();
      if (gen !== this.camGen) return;  // put away while the model loaded: the camera is not turned on
      const tc = this.env.now();
      const started = await this.camera.start(video);
      if (started) this.log.log('Time: camera started — ' + Math.round(this.env.now() - tc) + ' ms');
      if (!started || gen !== this.camGen) return;  // put away while the camera started (camera.stop gave it back)
      this.emitFigures();
      this.live.show(video);
      // a picked picture on the screen (a pick in work, or just over) or a page opened over the camera: the live frame
      // goes on after them (goOn), not now — its first answer would put the camera back over the picture
      if (this.picking || this.pickShown || this.held) return;
      this.emit('status', { key: 'finding' });
      this.live.start();
    } catch (e) {
      if (gen !== this.camGen) return;  // put away meanwhile: no error to show
      this.log.err('Camera / model error: ' + ((e as Error)?.message || e));
      this.emit('status', { key: 'camera_failed' });
    }
  }

  private answer(raw: Corners, res: SteadyAnswer): void {
    if (this.openedAt !== null) { this.log.log('Ready: first frame after ' + Math.round(this.env.now() - this.openedAt) + ' ms'); this.openedAt = null; }
    // a document the last shot took still in front of the camera: Auto waits (told even with Auto off, so turning
    // it on does not take it again)
    const waiting = this.live.taken.still(raw);
    this.emit('status', liveStatus(raw, res, waiting && this.auto));
    if (this.auto && !waiting && autoShot(res)) void this.snap();
  }

  /** The live frame goes on by itself (after a shot settled, a pick, a page closed) from a fresh frame — unless
   *  something still holds it: a page opened over it, a shot or a pick in work, the camera off or put away, or it
   *  runs already. */
  //
  // keep (after a shot that took documents): the frame stays where it was — on the document just taken, green while
  // it is still held there — and is not found again from nothing (owner, 2026-10-27: the square vanished after each
  // shot and came back red and flickering, so nothing could be aimed with); Auto still does not take it again (the
  // documents taken: steady.ts Taken), and a new document moves the frame over MOVE × 3, which starts its countdown
  // from nothing, red first. Otherwise (a pick, a page closed, a failed shot) the frame starts from nothing.
  private goOn(keep = false): void {
    if (this.held || this.picking || this.switching || this.shotInWork || this.live.running || !this.camera.on || !this.live.video) return;
    if (!keep) this.live.clearFrame();
    this.live.lastRes = null;  // a shutter tap before the first new answer takes nothing from an old frame
    this.live.start();
  }

  /** Take the shot (Capture, or Auto): the number of documents it held, 0 when nothing was taken — and 0 with
   *  nothing done while a shot is still in work (a shutter tap just after Auto would cut the same frame again). */
  async snap(): Promise<number> {
    if (this.shotInWork) return 0;
    this.shotInWork = true;
    let id = -1, got = 0;
    let rec = null as ShotRecord | null;
    try {
      got = await takeShot({
        engine: () => this.engines.engine,
        live: this.live,
        readers: this.readers,
        now: () => this.env.now(),
        sleep: ms => this.sleepMs(ms),
        newId: () => this.env.newId(),
        way: () => this.engines.engineWay || '',
        modelVersion: () => this.modelVersion(),
        begin: () => (id = ++this.shotId),
        batch: () => ++this.batchSeq,
        recorded: (r, frame) => { rec = r; this.attempts.newAttempt(frame, r.w, r.h, r.input, { id: r.attempt, way: r.way, model: r.model, src: r }); },
        current: () => this.shotId,
        has: pageId => this.pages.has(pageId),
        status: s => this.emit('status', s),
        page: p => this.putPage(p),
        captured: ms => { this.captureMs = ms; this.emitFigures(); },
        log: this.log,
      });
      return got;
    } catch (e) {
      this.log.err('Shot failed: ' + ((e as Error)?.message || e));
      this.emit('status', { key: 'shot_failed' });
      return 0;  // the camera goes on as the shot settles (below)
    } finally {
      // settled: a snap may take a shot again (not when a wake / sleep already freed it for a newer one)
      if (id < 0 || id === this.shotId) this.shotInWork = false;
      // the Looks good tapped while it looked for more documents: its record is whole now
      const kept = [...this.keepAfterShot].filter(([, shot]) => shot === id).map(([a]) => a);
      for (const a of kept) { this.keepAfterShot.delete(a); this.keepIfAllLooked(a); }
      // every page it had so far deleted while it looked for more: retaken unless it found another since
      const gone = [...this.retakeAfterShot].filter(([, shot]) => shot === id).map(([a]) => a);
      for (const a of gone) { this.retakeAfterShot.delete(a); this.retakeIfEmpty(a); }
      // settled and not taken over (a wake, a sleep, a pick or a switch): Auto waits for the documents it took to
      // go, and the live frame goes on — after a failed shot too, and after a tap with no frame while the live frame
      // was not running (a picked picture still shown: the camera comes back)
      if (id < 0 || id === this.shotId) {
        const r = rec as ShotRecord | null;
        const took = !!(got && r && r.edgesModel);
        if (took) this.live.taken.set([r!.edgesModel as Quad, ...r!.edgesMore]);
        this.goOn(took);
      }
    }
  }

  setAuto(on: boolean): void { this.auto = on; }
  /** The follow between the model's answers on or off (the lab's tools). */
  setFollow(on: boolean): void { this.live.follow = on; }

  /** The lab's settings changed (the models, the backend): nothing of the old way stays on the screen — no
   *  frame, no figures — and the frame and its follow start again on the new way (the lab's former plain page, its
   *  settings' onchange). A shot in work is dropped. */
  //
  // One change at a time, the newest winning: a change made while an earlier one still waits applies its
  // settings, and only the newest starts the model and the live frame again. A start of the models already
  // running (the camera's models load for many seconds after the lab opens) was begun on the old settings: it
  // is waited for, then the model is started again on the new ones.
  switchWay(patch: Partial<EngineSettings>): Promise<void> {
    const seq = ++this.switchSeq;
    const run = this.switchChain.then(() => this.runSwitch(patch, seq));
    this.switchChain = run.catch(() => {});
    return run;
  }
  private async runSwitch(patch: Partial<EngineSettings>, seq: number): Promise<void> {
    this.switching++;
    try { await this.switchTo(patch, seq); } finally { this.switching--; }
  }
  private async switchTo(patch: Partial<EngineSettings>, seq: number): Promise<void> {
    this.live.running = false;
    this.shotId++; this.shotInWork = false;
    while (this.live.inFlight) await this.sleepMs(30);
    this.live.forget();
    this.captureMs = null;
    this.emit('frame', null, false);
    this.emitFigures();
    const stale = this.engines.starting;  // begun before this change: on the old settings
    this.engines.setSettings(patch);
    if (seq !== this.switchSeq) return;  // a newer change follows: it starts the model
    await this.engines.ensureSession().catch(e => this.log.log('Model: ' + errText(e)));
    if (stale && seq === this.switchSeq) await this.engines.ensureSession().catch(e => this.log.log('Model: ' + errText(e)));
    if (seq !== this.switchSeq) return;
    // the live frame goes on, on the new way — unless the screen holds it (resume() lets it go on) or a pick is in
    // work (it goes on after it), or the camera is off
    if (!this.held && !this.picking && this.camera.on && this.live.video) { this.emit('status', { key: 'finding' }); this.live.start(); }
  }

  /** The live frame starts again at once from a fresh frame, the documents taken forgotten (the lab's Retake: the
   *  same document may be taken again; a shot in work is dropped); with the camera put away by sleep(), it starts
   *  again on the video it was shown in. */
  wake(video?: VideoLike): void {
    if (this.picking) return;  // a pick in work: its pictures are on the screen, the models busy with them
    this.held = false;
    this.pickShown = false; this.pickShownGen++;
    this.shotId++;
    this.shotInWork = false;
    this.live.clearFrame();
    this.live.taken.clear();
    const v = video || this.camera.video;
    if (this.camera.on && this.live.video) { this.emit('status', { key: 'finding' }); this.live.start(); }
    else if (v) void this.startCamera(v);
  }

  /** The scanner put away with its models kept (the scan window closed): the
   *  camera stops (one still starting is not turned on), the loops end, a shot in work is dropped. */
  sleep(): void {
    this.held = false;
    this.pickShown = false; this.pickShownGen++;
    this.shotId++;
    this.shotInWork = false;
    this.camGen++;
    this.live.running = false;
    this.live.taken.clear();
    this.camera.stop();
    this.live.hide();
  }

  /** The live frame paused while a page is opened large over the camera (its follow and Auto with it); a shot
   *  or a pick in work goes on, and the live frame does not go on after it until resume(). */
  hold(): void {
    this.held = true;
    this.live.running = false;
  }
  /** The live frame goes on again (from a fresh frame) after hold() — once no shot or pick is in work (it goes
   *  on when they settle), and only with the camera on. */
  resume(): void {
    if (!this.held) return;
    this.held = false;
    this.goOn();
  }

  /** Looks good on a page: its attempt kept (sent at once in the lab, held for Done on the site) once every page
   *  of it still shown was looked at — and once its shot has settled when it is still looking for more
   *  documents (its record still growing). */
  keep(pageId: string): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    const { attempt, shot } = p.record;
    const seen = this.looked.get(attempt) || new Set<string>();
    seen.add(pageId);
    this.looked.set(attempt, seen);
    if (shot > 0 && shot === this.shotId && this.shotInWork) { this.keepAfterShot.set(attempt, shot); return; }
    this.keepIfAllLooked(attempt);
  }

  /** The attempt kept when Looks good was tapped on each of its pages still shown (and on one at least). */
  private keepIfAllLooked(attempt: string): void {
    const seen = this.looked.get(attempt);
    if (!seen || !seen.size || !this.attempts.undecided(attempt)) return;
    for (const x of this.pages.values()) if (x.record.attempt === attempt && !seen.has(x.id)) return;
    this.looked.delete(attempt);
    this.attempts.decide('kept', [attempt]);
  }

  /** The scan ended: a shot in work stops (its record stays as it is), a pick in work gives nothing more, the
   *  pages are let go. */
  private endScan(): void {
    this.shotId++;
    this.shotInWork = false;
    this.scanGen++;
    this.keepAfterShot.clear();
    this.retakeAfterShot.clear();
    this.fixing.clear();
    this.looked.clear();
    this.held = false;
    this.pages.clear();
    this.removed.clear();
    this.fixedPages.clear();
  }

  /** Done (the site): every attempt kept — the ones looked at and the ones left alone — and sent (a shot still
   *  looking for more documents goes as it is: its record is read now, and the search stops with endScan); the
   *  scan ends (the pages let go: sent, they can no longer be fixed). */
  done(): void {
    this.attempts.done();
    this.endScan();
  }

  /** The window closed without Done (the site): nothing is sent, the scan ends. */
  discard(): void {
    this.attempts.drop();
    this.endScan();
  }

  /** Retake a camera shot: its attempt retaken (the next shot shares its group) — or, when it was kept already,
   *  each of its pages told to it as deleted —, its pages gone, the live frame started again. Returns the ids of
   *  the pages gone. */
  retake(pageId: string, video?: VideoLike): string[] {
    const p = this.pages.get(pageId);
    if (!p) return [];
    const attempt = p.record.attempt;
    const gone = [...this.pages.values()].filter(x => x.record.attempt === attempt);
    this.keepAfterShot.delete(attempt);
    this.retakeAfterShot.delete(attempt);
    this.looked.delete(attempt);
    if (this.attempts.undecided(attempt)) this.attempts.decide('retaken', [attempt]);
    else for (const x of gone) void this.attempts.pageDeleted(attempt, x.pg);
    for (const x of gone) { this.removed.add(x.id); this.pages.delete(x.id); }
    this.wake(video);
    return gone.map(x => x.id);
  }

  /** A page deleted (right after it is found, or later): never given again, and told to its attempt — or, when
   *  it was the last page shown of a camera shot still undecided, the shot retaken (the lab's Retake: the photo
   *  goes as a hard example with no label, the next shot shares its group), once the shot has settled. */
  remove(pageId: string): void {
    const p = this.pages.get(pageId);
    this.removed.add(pageId);
    this.pages.delete(pageId);
    if (!p) return;
    const { attempt, shot } = p.record;
    const inWork = shot > 0 && shot === this.shotId && this.shotInWork;
    if (shot > 0 && this.attempts.undecided(attempt) && !this.hasPagesOf(attempt)) {
      if (inWork) { this.retakeAfterShot.set(attempt, shot); void this.attempts.pageDeleted(attempt, p.pg); return; }
      this.looked.delete(attempt);
      this.attempts.decide('retaken', [attempt]);
      return;
    }
    void this.attempts.pageDeleted(attempt, p.pg);
    // the pages left of it may all be looked at now (not while its shot still looks for more)
    if (!inWork) this.keepIfAllLooked(attempt);
  }
  private hasPagesOf(attempt: string): boolean {
    for (const x of this.pages.values()) if (x.record.attempt === attempt) return true;
    return false;
  }
  /** A camera shot whose pages were all deleted while it looked for more: retaken now it has settled with none
   *  shown; with a page found since, it waits for Looks good like any other. */
  private retakeIfEmpty(attempt: string): void {
    if (!this.attempts.undecided(attempt)) return;
    if (this.hasPagesOf(attempt)) { this.keepIfAllLooked(attempt); return; }
    this.looked.delete(attempt);
    this.attempts.decide('retaken', [attempt]);
  }

  /** What the corner editor needs for a page: its photo and the corners to start from — null when the photo is
   *  no longer kept or the attempt was sent already (every page of it looked at, or Done). */
  fixable(pageId: string): { frame: OffscreenCanvas; w: number; h: number; pts: Quad } | null {
    const p = this.pages.get(pageId), f = p && this.attempts.frameOf(p.record.attempt);
    if (!p || !f || !this.attempts.canFix(p.record.attempt)) return null;
    return { frame: f.frame, w: f.w, h: f.h, pts: copy(this.attempts.cornersOf(p.record.attempt, p.pg) || p.quad) };
  }

  /** The corners set by hand on a page (the corner editor's Apply): they go with its attempt as the right answer,
   *  and the page is cut again from them (set upright) and given again under the same id, then read again. */
  async fix(pageId: string, pts: Quad): Promise<boolean> {
    const p = this.pages.get(pageId), f = p && this.attempts.frameOf(p.record.attempt);
    if (!p || !f || !this.attempts.fixed(p.record.attempt, p.pg, pts)) { this.log.log('This page can no longer be fixed (its photo is gone, or it was sent)'); return false; }
    this.log.log('Corners fixed by hand (page ' + (p.pg + 1) + ')');
    this.fixedPages.add(pageId);
    this.fixing.add(pageId);
    try { return await this.refix(pageId, p, f, pts); } finally { this.fixing.delete(pageId); }
  }
  private async refix(pageId: string, p: ShotPage, f: { frame: OffscreenCanvas; w: number; h: number }, pts: Quad): Promise<boolean> {
    let page: ShotPage;
    try {
      const eng = this.engines.engine || await this.engines.ensureCap();
      const pix = (f.frame.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D).getImageData(0, 0, f.w, f.h).data;
      const out = await eng.warp(pix, f.w, f.h, pts, true);
      if (out.turnError) this.log.err('Face finder: ' + out.turnError);
      if (this.removed.has(pageId) || this.pages.get(pageId) !== p) return false;  // deleted, or the scan ended
      page = { ...p, quad: copy(pts), page: info(out), canvas: toCanvas(out), turn: out.turn, readouts: null, released: false };
    } catch (e) { this.log.err('The page could not be cut again: ' + errText(e)); return false; }
    this.putPage(page, true);
    const readouts = await readPage(this.readers, page.canvas, this.env.now);
    if (this.pages.get(pageId) === page) this.putPage({ ...page, readouts }, true);
    return true;
  }

  /** Picked photos and PDFs (files.ts): a batch of its own, worked on the lanes, its pages given in the files'
   *  order; the pages before it are left as they are (nothing is marked looked at). The live frame goes on by
   *  itself PICK_SHOWN_MS after the last pick in work settled (the picked picture shown that long). Returns how
   *  many pages it gave. */
  pick(files: PickFile[]): Promise<number> {
    this.picking++;
    const run = this.pickChain.then(() => this.runPick(files));
    this.pickChain = run.catch(() => 0);
    const settled = (): void => {
      if (--this.picking) return;
      const gen = ++this.pickShownGen;
      this.pickShown = true;
      this.env.setTimeout(() => { if (gen !== this.pickShownGen || this.picking) return; this.pickShown = false; this.goOn(); }, PICK_SHOWN_MS);
    };
    run.then(settled, settled);
    return run;
  }

  private async runPick(files: PickFile[]): Promise<number> {
    if (!files.length) return 0;
    const batch = ++this.batchSeq, t0 = this.env.now(), log = this.log, gen = this.scanGen;
    this.shotId++; this.shotInWork = false;  // a shot in work is dropped (the lab's pick bumped it too)
    this.live.running = false;
    this.live.lastRes = null;  // the picked picture replaces the camera: no shot from the frame found before it
    while (this.live.inFlight) await this.sleepMs(10);
    // picked files go only to the accurate model: one picked before it is up waits for it (it starts right after
    // the live frame's model), the status line says so
    if (!this.engines.capReady()) { this.emit('status', { key: 'preparing_accurate' }); log.log('Picked files wait for the accurate model'); }
    try { await this.engines.ensureCap(); }
    catch (e) { log.err('Accurate model: ' + errText(e)); this.emit('status', { key: 'pick_failed' }); return 0; }
    let pages = 0;
    // the readouts (type, passport zone, Hebrew) one page after another, apart from the list: a picture's pages
    // are all given at once and the next picture is not held up by them
    let reads: Promise<void> = Promise.resolve();
    const where = (pic: { file: number; files: number; page: number; pages: number }) => ({ file: pic.file, files: pic.files, page: pic.page, pages: pic.pages });
    const res = await workPictures(pickedPictures(files, this.env.files, log.log), {
      // only the accurate model's threads: the capture thread (lane 0, shared with the live frame's pool) and a
      // file thread — never the live frame's (a picked picture sent to the light model's GPU thread hung, 2026-10-20)
      engineOf: async (k): Promise<LaneEngine> => {
        const t = k ? this.engines.fileThreads[k - 1] : undefined;
        if (t && !t.dead) return t;
        return this.engines.ensureCap();
      },
      growFiles: addLane => this.engines.growFiles(addLane),
      analyze: (pic, eng, onStep) => analyzePicture(pic.url, pic.pdfPage, eng, onStep, { decode: url => this.env.files.decode(url), log: log.log, now: this.env.now }),
      step: (n, pic, stage, q) => {
        if (gen !== this.scanGen) return;
        this.emit('preview', { batch, n, url: pic.url, ...where(pic), stage, quad: q ? copy(q) : null });
        this.emit('status', { key: stage === 'finding' ? 'picture_finding' : 'picture_cutting', ...where(pic) });
      },
      show: async (n, pic, picture) => {
        if (gen !== this.scanGen) return;  // the scan ended (Done, or the window closed)
        const way = this.engines.engineWay || '', model = this.modelVersion(), given: ShotPage[] = [];
        for (const part of picture.parts) {
          const input = part.whole ? 'pdf' as const : 'photo' as const;
          const rec: ShotRecord = { shot: 0, batch, attempt: this.env.newId(), input, w: part.w, h: part.h,
            edgesModel: part.whole ? null : copy(part.docs[0].pts), edgesMore: part.docs.slice(1).map(d => copy(d.pts)), pages: part.docs.length, way, model };
          this.attempts.newAttempt(part.frame, part.w, part.h, input, { id: rec.attempt, way, model, src: rec });
          const made = part.docs.map((d, i): ShotPage => {
            if (d.out.turnError) log.err('Face finder: ' + d.out.turnError);
            return { id: rec.attempt + ':' + i, record: rec, pg: i, quad: copy(d.pts), page: info(d.out), canvas: toCanvas(d.out), turn: d.out.turn, readouts: null, refined: false };
          });
          for (const p of made) this.putPage(p);
          given.push(...made);
          pages += made.length;
          this.emit('preview', { batch, n, url: pic.url, ...where(pic), stage: 'done', quad: part.whole ? null : part.onPicture(part.docs[0].pts) });
        }
        const timing = picture.timing;
        reads = reads.then(async () => {
          let readMs = 0;
          for (const p of given) {
            if (this.pages.get(p.id) !== p) continue;  // deleted (or fixed: read on its own cut) before its turn
            const t = this.env.now(), readouts = await readPage(this.readers, p.canvas, this.env.now);
            readMs += this.env.now() - t;
            if (this.pages.get(p.id) === p) this.putPage({ ...p, readouts });
          }
          log.log('Picture timing, ms: ' + timing + (readMs >= 1 ? '; then the readouts (type, passport zone, Hebrew) ' + Math.round(readMs) : ''));
        }).catch(e => log.err('Readouts: ' + errText(e)));
      },
      sleep: ms => this.sleepMs(ms),
      log: log.log,
      err: log.err,
    });
    await reads;
    if (res.failed) this.emit('status', { key: 'pick_failed' });
    else if (res.openFailed) this.emit('status', { key: 'pick_open_failed' });
    else this.emit('status', { key: 'picked', pages, files: files.length });
    log.log('Picked files: ' + pages + ' page(s) from ' + files.length + ' file(s) in ' + Math.round(this.env.now() - t0) + ' ms on ' + res.lanes + ' thread(s)');
    return pages;
  }

  /** Everything stopped: the scan discarded (an attempt not sent yet is not sent), sleep(), and every model
   *  thread and reader session released. */
  stop(): void {
    this.discard();
    this.attempts.stop();
    this.sleep();
    this.engines.stopAll();
    if (this.readers) this.readers.release();
  }
}
