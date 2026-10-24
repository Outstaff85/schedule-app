// The scanner's engine (docs/scan-plan.md → S9): one scan session — the controller the full-screen scanner
// (site and lab alike) drives, with no framework and no text of its own: the models' ways (engines.ts), the
// readers (readers.ts), the camera (camera.ts), the live frame and its follow (live.ts), the shot and its
// other documents (shot.ts). Ported from the lab's index.html (startCam, showShot, Auto, the Keep / Retake
// restart, the scan window's sleep through scan/embed.js).
//
//   const s = new ScanSession(siteSurface(token));
//   s.on('status', st => …); s.on('frame', (quad, ok) => …); s.on('page', p => …); s.on('figures', f => …);
//   await s.startCamera(video); … s.snap(); s.setAuto(false); s.wake(); s.sleep(); s.stop();
//   await s.pick(files); s.keep(pageId); s.retake(pageId); s.remove(pageId); await s.fix(pageId, pts); s.done();
//
// Events: frame — the frame to draw, every screen frame (null when there is none; ok — green); status — the
// status line as a key (status.ts SessionStatus; the screen words it through tr()); figures — the lab's
// figures; page — each cut page the moment it exists, and again under the same id when it is refined or its
// readouts come, so the screen can delete or fix it at once; preview — the picked picture being worked on (its
// url, which file and page, the frame of each document as it is found), so the preview switches to it at once.
//
// Picked files (pick, files.ts): each pick is a batch of its own, its pages in the files' order. The training
// attempts (attempts.ts): every shot and picked picture is one; a page is kept when Looks good is tapped on it
// (keep), at Done (done: the ones left alone too), retaken by Retake (retake: the next shot shares its group),
// deleted by remove; nothing is decided by a new shot or pick (owner, 2026-10-24). fix(pageId, pts): the corners
// set by hand go with the attempt (edgesFixed / edgesMoreFixed) and the page is cut again under the same id.
//
// After a shot the live frame waits (as the lab's did until Looks good / Retake): wake() starts it again from a
// fresh frame — so Auto does not take the same document again.
import { Attempts, type AttemptsEnv } from './attempts';
import { Camera, type GetUserMedia, type VideoLike } from './camera';
import { Engines } from './engines';
import { Live, trackFollower, type Bitmapper, type Figures, type Follower, type SessionClock } from './live';
import { ScanLog } from './log';
import { Readers } from './readers';
import { analyzePicture, defaultFilesEnv, pickedPictures, workPictures, type FilesEnv, type LaneEngine, type PickFile, type PictureStage } from './files';
import { info, readPage, takeShot, toCanvas, type ShotPage, type ShotRecord } from './shot';
import type { SessionStatus } from './status';
import { autoShot, hintOf, type SteadyAnswer } from './steady';
import type { ScanSurface } from './surface';
import type { Corners, Pt, Quad } from './types';

const copy = (q: Quad): Quad => q.map(p => p.slice() as Pt);
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

export interface SessionParts { engines?: Engines; readers?: Readers | null; log?: ScanLog; env?: Partial<SessionEnv>; attempts?: Attempts; attemptsEnv?: Partial<AttemptsEnv> }

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
  /** One pick at a time, in the order picked. */
  private pickChain: Promise<unknown> = Promise.resolve();
  private listeners: { [K in keyof SessionEvents]: Set<SessionEvents[K]> } = { frame: new Set(), status: new Set(), figures: new Set(), page: new Set(), preview: new Set() };

  constructor(readonly surface: ScanSurface, parts: SessionParts = {}) {
    this.env = { ...defaultSessionEnv(), ...parts.env };
    this.log = parts.log || parts.engines?.log || new ScanLog();
    this.engines = parts.engines || new Engines(surface, this.log);
    this.readers = parts.readers !== undefined ? parts.readers : new Readers(surface, this.log.log, this.engines.settings.cpuDir);
    this.camera = new Camera(this.env.getUserMedia);
    this.attempts = parts.attempts || new Attempts(surface, this.log, parts.attemptsEnv);
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

  /** A page given (or given again under its id). */
  private putPage(p: ShotPage, fromFix = false): void {
    if (this.removed.has(p.id) || (!fromFix && this.fixedPages.has(p.id))) return;
    this.pages.set(p.id, p);
    this.emit('page', p);
  }
  private modelVersion(): string { return this.readers && this.readers.info ? this.readers.info.version : ''; }
  private sleepMs(ms: number): Promise<void> { return new Promise<void>(r => this.env.setTimeout(r, ms)); }

  /** The models made ready as the lab's page did on open: the accurate model first (photos and PDFs can go
   *  in), then the camera's models; the readers beside them. */
  async prepare(): Promise<void> {
    this.attempts.start();
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
        sleep: ms => this.sleepMs(ms),
        newId: () => this.env.newId(),
        way: () => this.engines.engineWay || '',
        modelVersion: () => this.modelVersion(),
        begin: () => (id = ++this.shotId),
        batch: () => ++this.batchSeq,
        recorded: r => { this.attempts.newAttempt(r.frame, r.w, r.h, r.input, { id: r.attempt, way: r.way, model: r.model, src: r }); },
        current: () => this.shotId,
        status: s => this.emit('status', s),
        page: p => this.putPage(p),
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

  /** Looks good on a page: its attempt kept (sent at once in the lab, held for Done on the site). */
  keep(pageId: string): void {
    const p = this.pages.get(pageId);
    if (p) this.attempts.decide('kept', [p.record.attempt]);
  }

  /** Done (the site): every attempt kept — the ones looked at and the ones left alone — and sent. */
  done(): void { this.attempts.done(); }

  /** Retake a camera shot: its attempt retaken (the next shot shares its group), its pages gone, the live frame
   *  started again. Returns the ids of the pages gone. */
  retake(pageId: string, video?: VideoLike): string[] {
    const p = this.pages.get(pageId);
    if (!p) return [];
    this.attempts.decide('retaken', [p.record.attempt]);
    const gone = [...this.pages.values()].filter(x => x.record.attempt === p.record.attempt).map(x => x.id);
    for (const id of gone) { this.removed.add(id); this.pages.delete(id); }
    this.wake(video);
    return gone;
  }

  /** A page deleted (right after it is found, or later): never given again, and told to its attempt. */
  remove(pageId: string): void {
    const p = this.pages.get(pageId);
    this.removed.add(pageId);
    this.pages.delete(pageId);
    if (p) void this.attempts.pageDeleted(p.record.attempt, p.pg);
  }

  /** What the corner editor needs for a page: its photo and the corners to start from — null when the photo is
   *  no longer kept or the attempt was sent already (Retake it). */
  fixable(pageId: string): { frame: OffscreenCanvas; w: number; h: number; pts: Quad } | null {
    const p = this.pages.get(pageId), f = p && this.attempts.frameOf(p.record.attempt);
    if (!p || !f || !this.attempts.canFix(p.record.attempt)) return null;
    return { frame: f.frame, w: f.w, h: f.h, pts: copy(this.attempts.cornersOf(p.record.attempt, p.pg) || p.quad) };
  }

  /** The corners set by hand on a page (the corner editor's Apply): they go with its attempt as the right answer,
   *  and the page is cut again from them (set upright) and given again under the same id, then read again. */
  async fix(pageId: string, pts: Quad): Promise<boolean> {
    const p = this.pages.get(pageId), f = p && this.attempts.frameOf(p.record.attempt);
    if (!p || !f || !this.attempts.fixed(p.record.attempt, p.pg, pts)) { this.log.log('This page can no longer be fixed — Retake it'); return false; }
    this.log.log('Corners fixed by hand (page ' + (p.pg + 1) + ')');
    this.fixedPages.add(pageId);
    let page: ShotPage;
    try {
      const eng = this.engines.engine || await this.engines.ensureCap();
      const pix = (f.frame.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D).getImageData(0, 0, f.w, f.h).data;
      const out = await eng.warp(pix, f.w, f.h, pts, true);
      if (out.turnError) this.log.err('Face finder: ' + out.turnError);
      if (this.removed.has(pageId)) return false;
      page = { ...p, quad: copy(pts), page: info(out), canvas: toCanvas(out), turn: out.turn, readouts: null };
    } catch (e) { this.log.err('The page could not be cut again: ' + errText(e)); return false; }
    this.putPage(page, true);
    const readouts = await readPage(this.readers, page.canvas, this.env.now);
    if (this.pages.get(pageId) === page) this.putPage({ ...page, readouts }, true);
    return true;
  }

  /** Picked photos and PDFs (files.ts): a batch of its own, worked on the lanes, its pages given in the files'
   *  order; the pages before it are left as they are (nothing is marked looked at). The live frame waits for
   *  wake() after it, as after a shot. Returns how many pages it gave. */
  pick(files: PickFile[]): Promise<number> {
    const run = this.pickChain.then(() => this.runPick(files));
    this.pickChain = run.catch(() => 0);
    return run;
  }

  private async runPick(files: PickFile[]): Promise<number> {
    if (!files.length) return 0;
    const batch = ++this.batchSeq, t0 = this.env.now(), log = this.log;
    this.shotId++; this.shotInWork = false;  // a shot in work is dropped (the lab's pick bumped it too)
    this.live.running = false;
    while (this.live.inFlight) await this.sleepMs(10);
    try { await this.engines.ensureCap(); }
    catch (e) { log.err('Accurate model: ' + errText(e)); this.emit('status', { key: 'pick_failed' }); return 0; }
    let pages = 0;
    const where = (pic: { file: number; files: number; page: number; pages: number }) => ({ file: pic.file, files: pic.files, page: pic.page, pages: pic.pages });
    const res = await workPictures(pickedPictures(files, this.env.files, log.log), {
      engineOf: async (k): Promise<LaneEngine> => {
        const t = k ? this.engines.fileThreads[k - 1] : undefined;
        if (t && !t.dead) return t;
        const e = this.engines.engine;
        return e && e.shared ? e : this.engines.ensureCap();
      },
      growFiles: addLane => this.engines.growFiles(addLane),
      analyze: (pic, eng, onStep) => analyzePicture(pic.url, pic.pdfPage, eng, onStep, { decode: url => this.env.files.decode(url), log: log.log, now: this.env.now }),
      step: (n, pic, stage, q) => {
        this.emit('preview', { batch, n, url: pic.url, ...where(pic), stage, quad: q ? copy(q) : null });
        this.emit('status', { key: stage === 'finding' ? 'picture_finding' : 'picture_cutting', ...where(pic) });
      },
      show: async (n, pic, picture) => {
        const way = this.engines.engineWay || '', model = this.modelVersion();
        let readMs = 0;
        for (const part of picture.parts) {
          const input = part.whole ? 'pdf' as const : 'photo' as const;
          const rec: ShotRecord = { shot: 0, batch, attempt: this.env.newId(), input, frame: part.frame, w: part.w, h: part.h,
            edgesModel: part.whole ? null : copy(part.docs[0].pts), edgesMore: part.docs.slice(1).map(d => copy(d.pts)), pages: part.docs.length, way, model };
          this.attempts.newAttempt(part.frame, part.w, part.h, input, { id: rec.attempt, way, model, src: rec });
          const made = part.docs.map((d, i): ShotPage => {
            if (d.out.turnError) log.err('Face finder: ' + d.out.turnError);
            return { id: rec.attempt + ':' + i, record: rec, pg: i, quad: copy(d.pts), page: info(d.out), canvas: toCanvas(d.out), turn: d.out.turn, readouts: null, refined: false };
          });
          for (const p of made) this.putPage(p);
          pages += made.length;
          this.emit('preview', { batch, n, url: pic.url, ...where(pic), stage: 'done', quad: part.whole ? null : part.onPicture(part.docs[0].pts) });
          const t = this.env.now();
          for (const p of made) {
            const readouts = await readPage(this.readers, p.canvas, this.env.now);
            if (this.pages.get(p.id) === p) this.putPage({ ...p, readouts });
          }
          readMs += this.env.now() - t;
        }
        log.log('Picture timing, ms: ' + picture.timing + (readMs >= 1 ? '; then the readouts (type, passport zone, Hebrew) ' + Math.round(readMs) : ''));
      },
      sleep: ms => this.sleepMs(ms),
      log: log.log,
      err: log.err,
    });
    if (res.failed) this.emit('status', { key: 'pick_failed' });
    else if (res.openFailed) this.emit('status', { key: 'pick_open_failed' });
    else this.emit('status', { key: 'picked', pages, files: files.length });
    log.log('Picked files: ' + pages + ' page(s) from ' + files.length + ' file(s) in ' + Math.round(this.env.now() - t0) + ' ms on ' + res.lanes + ' thread(s)');
    return pages;
  }

  /** Everything stopped: sleep(), and every model thread and reader session released. */
  stop(): void {
    this.attempts.stop();
    this.sleep();
    this.engines.stopAll();
    if (this.readers) this.readers.release();
  }
}
