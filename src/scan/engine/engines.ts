// The scanner's engine (docs/scan-plan.md → S9): the ways the models run, ported unchanged from the lab's
// index.html (pageEngine, workerEngine, poolEngine, capOnly, WAYS, startSession / ensureSession,
// ensureCap, onStuck, growFiles / dropFileThreads) into one class per scanner, Engines(surface, log):
//  - the ways, best first: the GPU's live frame beside a CPU capture thread, a pool of CPU threads, one
//    background thread with several CPU threads, one with one, the page itself. Each is tried in turn: a way
//    that fails or goes silent for 25 s is dropped (with its throwaway background thread) and the next starts
//    clean; a way whose thread stopped answering while scanning is not tried again until the scanner closes.
//    Nothing is remembered between opens (owner, 2026-10-22) but the GPU layout that worked and the failures'
//    log: the lab reloaded its page on every open, the engine now outlives a close in the manager page, so
//    stopAll() forgets the stuck ways and a fall back to the page, and stops every start still loading (a
//    generation number: a load that ends after the close stops its threads instead of keeping them).
//  - every session is released when its way stops (the page way's sessions live in the page's own heap).
//  - the accurate model's capture thread first, on the CPU (owner, 2026-10-22): picked photos and PDFs need
//    only it; the live frame's pool shares it — one copy of the accurate model.
//  - picked files: at most one more thread with the accurate model, none under 4 GB of memory or 4 cores.
//  - the capture and file threads are keyed on the accurate model and the CPU's ONNX Runtime build together,
//    so the lab's CPU engine choice reaches them too.
// Every model and ONNX Runtime file comes from the surface (surface.ts): the site's from /scan/, the lab's
// from /scan-lab/.
import { S, warpRGBA } from './geometry';
import type { ScanLog } from './log';
import { cpuSession, detectRGBA, errText, openSession, type Ep, type Want } from './models';
import { loadOrt, type Ort, type OrtSession } from './ort';
import { CPU_ORT, GPU_ORT, surfaceRef, type OrtDir, type SurfaceRef } from './surface';
import { mkCanvas, uprightRGBA, type Upright } from './upright';
import type { WorkerIn, WorkerOut } from './worker';
import type { Corners, KeyValue, Quad } from './types';

/** A frame for the corners model: an S×S bitmap (handed to the thread as is) or its RGBA. */
export interface DetectInput { bitmap?: ImageBitmap; rgba?: Uint8ClampedArray }
export interface Detected { res: Corners; ms: number }

/** One interface for every way: in the page, in a background thread, a pool of them. */
export interface Engine {
  hasCap(): boolean;
  detect(which: 'live' | 'cap', input: DetectInput): Promise<Detected>;
  warp(rgba: Uint8ClampedArray, w: number, h: number, pts: Quad, upright: boolean): Promise<Upright>;
  stop(): void;
}
export interface LoadableEngine extends Engine {
  /** Loads the live model and (when named) the capture model; resolves to the backends used ("webgpu/wasm"). */
  load(live: string, cap: string | null, want: Want, withFace?: boolean): Promise<string>;
  /** A pool: its live threads and whether its capture thread is the shared one. */
  size?: number;
  shared?: boolean;
}
/** The capture thread as an engine of its own (picked files), or a file thread. */
export interface ThreadEngine extends Engine { label: string; raw?: LoadableEngine; dead?: boolean }

/** A background thread as the engine sees it (a Worker; the tests give a fake). */
export interface WorkerLike {
  postMessage(m: WorkerIn, transfer?: Transferable[]): void;
  onmessage: ((e: { data: WorkerOut }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

/** What the engine takes of the device and the browser (the tests give their own). */
export interface EngineEnv {
  /** navigator.hardwareConcurrency, deviceMemory (GB) — 0 when unknown —, whether WebGPU is there, whether
   *  the page is cross-origin isolated. */
  cores: number;
  memory: number;
  gpu: boolean;
  isolated: boolean;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** A new background thread (worker.ts). */
  spawn(): WorkerLike;
  /** Where the GPU layout that worked is kept (localStorage). */
  store: KeyValue | null;
}

export function defaultEnv(): EngineEnv {
  const nav = ((globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number; gpu?: unknown } }).navigator) || {};
  let store: KeyValue | null = null;
  try { store = (globalThis as { localStorage?: KeyValue }).localStorage || null; } catch { /* blocked */ }
  return {
    cores: nav.hardwareConcurrency || 0,
    memory: nav.deviceMemory || 0,
    gpu: !!nav.gpu,
    isolated: !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id as ReturnType<typeof setInterval>),
    spawn: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    store,
  };
}

/** A way to run the models. */
export interface Way { id: string; label: string; worker: boolean; gpuLive?: boolean; pool?: boolean; ep: Ep; threads: number }

/** The live model and the capture model ("live+cap", or one model for both); the lab's choice. */
export const DEFAULT_MODEL = 'lite.onnx+sa24_w16.onnx';
/** The settings the lab's tools change (the site keeps the defaults): the models, the backend asked for,
 *  whether background threads are used, the CPU's ONNX Runtime build. They stay what was asked for; a start
 *  that fell back to the page is kept apart (until the scanner closes, or inWorker is set again). */
export interface EngineSettings { model: string; backend: Want; inWorker: boolean; cpuDir: OrtDir }

/** Where the engine is: the way's label (or "loading…" / "failed") and the seconds its start took. */
export interface EngineState { phase: 'idle' | 'loading' | 'ready' | 'failed'; label: string; worker: boolean; loadSeconds: number | null }

const GPU_LAYOUT_KEY = 'scanGpuLayout';
const WATCH_MS = 25000;

export class Engines {
  readonly env: EngineEnv;
  readonly ref: SurfaceRef;
  /** Background threads for the live frame when the pool is used. */
  readonly POOL: number;
  /** CPU threads of one session: several only on a cross-origin isolated page. */
  readonly THREADS: number;
  /** The ways, best first. */
  readonly WAYS: Way[];

  settings: EngineSettings = { model: DEFAULT_MODEL, backend: 'auto', inWorker: true, cpuDir: CPU_ORT };
  engine: LoadableEngine | null = null;
  engineKey = '';
  /** The way the model runs on now (WAYS). */
  engineWay: string | null = null;
  /** Ways whose background thread stopped answering: not tried again until the scanner closes. */
  readonly stuckWays = new Set<string>();
  /** Every background way failed: the next starts go straight to the page (the lab unticked its "background
   *  threads"), until the scanner closes or inWorker is set again (setSettings). */
  private pageOnly = false;
  /** Bumped by stopAll(): a start or a thread load begun before it ends by stopping what it made. */
  private gen = 0;
  /** The engines still loading (a way being tried, the capture thread, a file thread): stopAll() stops them
   *  at once, so no thread outlives the close by waiting for its load. */
  private readonly inFlight = new Set<LoadableEngine>();
  private track<T>(e: LoadableEngine, p: Promise<T>): Promise<T> {
    this.inFlight.add(e);
    return p.finally(() => { this.inFlight.delete(e); });
  }
  state: EngineState = { phase: 'idle', label: '—', worker: true, loadSeconds: null };

  capThread: ThreadEngine | null = null;
  private capFor = '';
  private capLoading: Promise<ThreadEngine> | null = null;
  fileThreads: ThreadEngine[] = [];
  private fileThreadsFor: LoadableEngine | null = null;
  private ensuring: Promise<void> | null = null;
  private changes = new Set<(s: EngineState) => void>();
  private fileThreadsCap = '';

  constructor(surface: SurfaceRef, readonly log: ScanLog, env: Partial<EngineEnv> = {}) {
    this.env = { ...defaultEnv(), ...env };
    this.ref = surfaceRef(surface);
    this.POOL = Math.max(1, Math.min(3, Math.floor((this.env.cores || 2) / 2)));
    this.THREADS = this.env.isolated ? Math.min(4, this.env.cores || 1) : 1;
    this.WAYS = [
      { id: 'bg-gpulive', label: 'GPU live + CPU capture · bg', worker: true, gpuLive: true, ep: 'wasm', threads: 1 },
      { id: 'bg-pool', label: 'CPU · ' + this.POOL + ' bg threads + 1', worker: true, pool: true, ep: 'wasm', threads: 1 },
      { id: 'bg-cpu', label: 'CPU ×' + this.THREADS + ' · bg', worker: true, ep: 'wasm', threads: this.THREADS },
      { id: 'bg-cpu1', label: 'CPU ×1 · bg', worker: true, ep: 'wasm', threads: 1 },
      { id: 'page-cpu', label: 'CPU ×' + this.THREADS + ' · page', worker: false, ep: 'wasm', threads: this.THREADS },
    ];
  }

  /** Listen to the engine's state; returns the unsubscribe. */
  onChange(fn: (s: EngineState) => void): () => void { this.changes.add(fn); return () => { this.changes.delete(fn); }; }
  /** The lab's tools change the settings; setting inWorker asks for the background ways again. */
  setSettings(patch: Partial<EngineSettings>): void {
    if (patch.inWorker !== undefined) this.pageOnly = false;
    this.settings = { ...this.settings, ...patch };
  }
  /** Whether the next start tries the background ways. */
  private inWorkerNow(): boolean { return this.settings.inWorker && !this.pageOnly; }
  /** The accurate model's name, and the key of what the capture and file threads hold: it and the CPU's
   *  ONNX Runtime build. */
  private capKey(): { name: string; key: string } {
    const [live, cap] = this.settings.model.split('+'), name = cap || live;
    return { name, key: name + '|' + this.settings.cpuDir };
  }
  /** The error a start or load begun in generation g ends with when the scanner closed since; null if not. */
  private closed(g: number): Error | null { return g === this.gen ? null : new Error('the scanner was closed'); }
  private setState(s: Partial<EngineState>): void {
    this.state = { ...this.state, ...s };
    for (const fn of this.changes) { try { fn(this.state); } catch { /* the listener's own */ } }
  }

  // The GPU memory layout that worked on this device (models.ts openSession): started first next time.
  private layoutGet(): string | null { try { return this.env.store ? this.env.store.getItem(GPU_LAYOUT_KEY) : null; } catch { return null; } }
  private layoutSet(v: string | null | undefined): void { try { if (v && this.env.store) this.env.store.setItem(GPU_LAYOUT_KEY, v); } catch { /* blocked */ } }

  private rgbaOf(input: DetectInput): Uint8ClampedArray {
    if (input.rgba) return input.rgba;
    const c = mkCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    g.drawImage(input.bitmap as ImageBitmap, 0, 0); (input.bitmap as ImageBitmap).close(); return g.getImageData(0, 0, S, S).data;
  }

  /** The models in the page itself. */
  pageEngine(): LoadableEngine {
    let ort: Ort | null = null, live: OrtSession | null = null, cap: OrtSession | null = null, face: OrtSession | null = null;
    const { log } = this;
    return {
      load: async (liveName, capName, want, withFace) => {
        ort = await loadOrt(this.ref, this.settings.cpuDir, this.THREADS);
        const a = await openSession(ort, this.ref, liveName, want, log.status, log.any, this.layoutGet()); live = a.sess;
        const b = capName ? await openSession(ort, this.ref, capName, want, log.status, log.any, this.layoutGet()) : a; cap = b.sess;
        this.layoutSet(a.layout || b.layout);
        if (withFace !== false) face = await cpuSession(ort, this.ref, 'yunet.onnx');
        return a.ep + (b.ep !== a.ep ? '/' + b.ep : '');
      },
      hasCap: () => cap !== live,
      detect: async (which, input) => {
        const t = this.env.now();
        const res = await detectRGBA(ort as Ort, (which === 'cap' ? cap : live) as OrtSession, this.rgbaOf(input));
        return { res, ms: this.env.now() - t };
      },
      warp: async (rgba, w, h, pts, upright) => uprightRGBA(ort, upright ? face : null, warpRGBA(rgba, w, h, pts)),
      // the sessions live in the page's own ONNX Runtime heap: released, or every open adds to it
      stop() {
        for (const s of new Set([live, cap, face])) if (s) { try { s.release().catch(() => {}); } catch { /* gone already */ } }
        live = cap = face = null;
      },
    };
  }

  /** The models in a background thread (worker.ts) with `threads` CPU threads and the ONNX Runtime build `dir`.
   *  A thread that says nothing for 25 s while a call waits is taken as stuck: its calls fail and onHang runs. */
  workerEngine(threads: number, dir: OrtDir = this.settings.cpuDir, onHang: () => void = () => this.onStuck()): LoadableEngine {
    const { env, log } = this;
    const w = env.spawn(), waiting = new Map<number, { resolve: (m: WorkerOut & { type: 'reply' }) => void; reject: (e: Error) => void }>();
    let n = 0, two = false, heard = env.now();
    const failAll = (why: string) => { for (const p of waiting.values()) p.reject(new Error(why)); waiting.clear(); };
    const watch = env.setInterval(() => { if (waiting.size && env.now() - heard > WATCH_MS) { failAll('no answer for 25 s'); onHang(); } }, 1000);
    w.onmessage = ({ data: m }) => {
      heard = env.now();
      if (m.type === 'status') log.status(m.status, m.frac);
      else if (m.type === 'log') log.any(m.text);
      else if (m.type === 'reply') { const p = waiting.get(m.id); waiting.delete(m.id); if (p) { if (m.error) p.reject(new Error(m.error)); else p.resolve(m); } }  // a late answer to a call given up on: dropped
    };
    w.onerror = e => { log.err('Worker error: ' + (e.message || 'could not start')); failAll('the background thread failed: ' + (e.message || 'could not start')); };
    // a request to a thread that had nothing to do starts the clock again: an idle thread says nothing, so
    // its first request after 25 s was taken as stuck at once (every picked file, 2026-10-22)
    type Msg = WorkerIn extends infer T ? T extends { id: number } ? Omit<T, 'id'> : never : never;
    const call = (msg: Msg, transfer?: Transferable[]) => new Promise<WorkerOut & { type: 'reply' }>((resolve, reject) => {
      if (!waiting.size) heard = env.now();
      const id = ++n; waiting.set(id, { resolve, reject }); w.postMessage({ ...msg, id } as WorkerIn, transfer || []);
    });
    return {
      load: async (liveName, capName, want, withFace = true) => {
        two = !!capName;
        const r = await call({ type: 'load', surface: this.ref, ort: dir, live: liveName, cap: capName, want, threads, face: withFace, layout: this.layoutGet() });
        this.layoutSet(r.layout as string | null);
        return r.ep as string;
      },
      hasCap: () => two,
      detect: async (which, input) => {
        const m = input.bitmap ? await call({ type: 'detect', which, bitmap: input.bitmap }, [input.bitmap]) : await call({ type: 'detect', which, rgba: (input.rgba as Uint8ClampedArray).buffer as ArrayBuffer }, [(input.rgba as Uint8ClampedArray).buffer as ArrayBuffer]);
        return { res: m.res as Corners, ms: m.ms as number };
      },
      warp: async (rgba, wd, h, pts, upright) => (await call({ type: 'warp', rgba: rgba.buffer as ArrayBuffer, w: wd, h, pts, upright }, [rgba.buffer as ArrayBuffer])).out as Upright,
      stop() { env.clearInterval(watch); failAll('the model was stopped'); w.terminate(); },  // nothing left waiting on it
    };
  }

  // A background thread that stops answering while scanning (a phone's GPU was seen to hang, and every
  // later call then waited on it): the way it ran on is left for this page, and the model starts again on
  // the next way at the next use (the live frame, a picked file).
  onStuck(): void {
    if (!this.engine) return;
    const w = this.WAYS.find(x => x.id === this.engineWay), label = w ? w.label : String(this.engineWay);
    this.log.err('The model stopped answering on "' + label + '" — it starts again on the next way');
    this.log.noteFail(label, 'stopped answering while scanning');
    if (this.engineWay) this.stuckWays.add(this.engineWay);
    const old = this.engine; this.engine = null; this.engineKey = ''; this.dropFileThreads();
    try { old.stop(); } catch { /* gone already */ }
  }

  // Several single-thread background threads: the live frames go to them in
  // turn (2–3 frames worked on at once), the accurate model has its own thread,
  // so a capture never stops the live frame. Phones that refuse CPU threads
  // inside a background thread still run several background threads.
  // shared: the accurate model's thread already loaded (the capture thread — loaded first, picked files use it
  // at once); the pool then loads only its live threads and never stops the shared one.
  poolEngine(nLive: number = this.POOL, liveEp: Ep | null = null, capEp: Ep | null = null, shared: LoadableEngine | null = null): LoadableEngine {
    const lives = Array.from({ length: nLive }, () => this.workerEngine(1, liveEp === 'webgpu' ? GPU_ORT : this.settings.cpuDir));
    const capE = shared || this.workerEngine(1), free = lives.slice();
    let two = false;
    return {
      size: nLive,
      shared: !!shared,
      async load(liveName, capName, want) {
        two = !!capName;
        const eps = await Promise.all(lives.map((e, i) => e.load(liveName, null, liveEp || want, !two && i === 0)).concat(two && !shared ? [capE.load(capName as string, null, capEp || want, true)] : []));
        return eps[0] + (two && (shared || eps[eps.length - 1] !== eps[0]) ? '/' + (shared ? 'wasm' : eps[eps.length - 1]) : '');
      },
      hasCap: () => two,
      async detect(which, input) {
        if (which === 'cap' && two) return capE.detect('live', input);
        const e = free.shift() || lives[0];
        try { return await e.detect('live', input); } finally { if (!free.includes(e)) free.push(e); }
      },
      warp: (rgba, w, h, pts, upright) => (two ? capE : lives[0]).warp(rgba, w, h, pts, upright),
      stop() { lives.forEach(e => e.stop()); if (!shared) capE.stop(); },
    };
  }

  private capOnly(e: LoadableEngine): ThreadEngine {
    return { detect: (_which, input) => e.detect('live', input), warp: e.warp, hasCap: () => false, stop: () => e.stop(), raw: e, label: 'the capture thread' };
  }

  // The accurate model's thread is started first, on the CPU (owner, 2026-10-22): picked photos and PDFs need
  // only it, so they can go in a few seconds after the page opens; the live frame's models (the GPU's light
  // one) are loaded after it, in the background when nothing is being worked on, or when the camera starts,
  // and they share this thread for the shot — one copy of the accurate model. ensureCap() → the thread
  // (a capture-only engine for a picked picture), started again when it failed or the model was changed.
  ensureCap(): Promise<ThreadEngine> {
    const { log } = this, { name, key } = this.capKey(), g = this.gen;
    if (this.capThread && this.capFor === key) return Promise.resolve(this.capThread);
    if (this.capLoading && this.capFor === key) return this.capLoading;
    if (this.capThread) { this.capThread.stop(); this.capThread = null; }
    this.capFor = key;
    const t0 = this.env.now();
    log.status({ key: 'preparing_accurate' }, 0);
    const e: LoadableEngine = this.workerEngine(1, this.settings.cpuDir, () => {
      log.err('The capture thread stopped answering — it starts again');
      log.noteFail('Capture thread', 'stopped answering');
      if (this.capThread && this.capThread.raw === e) this.capThread = null;
      e.stop(); this.onStuck();
    });
    const p: Promise<ThreadEngine> = this.track(e, e.load(name, null, 'wasm', true)).then(() => {
      const gone = this.closed(g);
      if (gone || this.capFor !== key) { e.stop(); throw gone || new Error('the model was changed'); }  // closed or changed meanwhile
      const t = this.capOnly(e);
      this.capThread = t;
      log.log('The accurate model is ready (' + ((this.env.now() - t0) / 1000).toFixed(1) + ' s) — photos and PDFs can go in');
      if (!this.engine) log.status({ key: 'ready_files' }, 1);
      return t;
    }, err => { e.stop(); if (!this.closed(g)) log.noteFail('Capture thread', errText(err)); throw err; })
      .finally(() => { if (this.capLoading === p) this.capLoading = null; });
    this.capLoading = p;
    return p;
  }

  /** The ways a start tries, in order, for the settings (startSession's filtering): the background ones only
   *  when asked, the GPU's only with WebGPU, the GPU alone when it is asked for, minus the ways stuck since the
   *  scanner opened (unless every way is). */
  waysFor(want: Want = this.settings.backend, inWorker: boolean = this.inWorkerNow()): Way[] {
    let ways = this.WAYS.filter(w => (inWorker || !w.worker) && (want === 'auto' || w.ep === want));
    if (!this.env.gpu) ways = ways.filter(w => w.ep !== 'webgpu' && !w.gpuLive);
    if (want === 'webgpu') ways = inWorker ? [{ id: 'bg-gpu', label: 'GPU · bg', worker: true, ep: 'webgpu', threads: 1 }] : [{ id: 'page-gpu', label: 'GPU · page', worker: false, ep: 'webgpu', threads: 1 }];
    if (want === 'wasm') ways = ways.filter(w => !w.gpuLive);
    if (ways.some(w => !this.stuckWays.has(w.id))) ways = ways.filter(w => !this.stuckWays.has(w.id));
    return ways;
  }

  // One start of the model at a time (the live frame and a picked file may both ask).
  ensureSession(): Promise<void> {
    if (this.ensuring) return this.ensuring;
    const p: Promise<void> = this.startSession().finally(() => { if (this.ensuring === p) this.ensuring = null; });
    return (this.ensuring = p);
  }

  async startSession(): Promise<void> {
    const { log } = this, { model, backend: want, cpuDir } = this.settings, inWorker = this.inWorkerNow(), g = this.gen;
    const [live, cap] = model.split('+') as [string, string | undefined];
    const key = model + '|' + want + '|' + inWorker + '|' + cpuDir;
    if (this.engine && this.engineKey === key) return;
    if (this.engine) this.engine.stop();
    this.dropFileThreads();
    this.engine = null; this.setState({ phase: 'loading', label: 'loading…', loadSeconds: null }); log.status({ key: 'preparing' }, 0);
    const t0 = this.env.now();
    let e: LoadableEngine | null = null, used: Way | null = null;
    for (const w of this.waysFor(want, inWorker)) {
      log.status({ key: 'trying_way', way: w.label }, 0);
      const shared = cap && (w.gpuLive || w.pool) ? await this.ensureCap().then(t => t.raw || null, () => null) : null;
      let gone = this.closed(g);
      if (gone) throw gone;  // closed while the capture thread loaded
      const cand = w.gpuLive ? this.poolEngine(2, 'webgpu', 'wasm', shared) : w.pool ? this.poolEngine(this.POOL, null, null, shared) : w.worker ? this.workerEngine(w.threads, w.ep === 'webgpu' ? GPU_ORT : cpuDir) : this.pageEngine();
      try { await this.track(cand, cand.load(live, cap || null, w.ep)); } catch (err) {
        cand.stop();
        gone = this.closed(g); if (gone) throw gone;
        log.noteFail(w.label, errText(err)); log.log('Trying the next way'); continue;
      }
      gone = this.closed(g);
      if (gone) { cand.stop(); throw gone; }  // closed while it loaded: its threads and sessions go
      e = cand; used = w; break;
    }
    if (!e || !used) { this.setState({ phase: 'failed', label: 'failed' }); log.status({ key: 'failed' }); throw new Error('no way to run the model'); }
    log.log('Live ' + live + (cap ? ', capture ' + cap : '') + ' running as ' + used.label);
    this.engine = e; this.engineWay = used.id;
    // a start that fell back to the page stays there until the scanner closes (the lab unticked its
    // "background threads"); the key then matches the next asks, so the model is not started again each use
    if (inWorker && !used.worker) this.pageOnly = true;
    this.engineKey = model + '|' + want + '|' + this.inWorkerNow() + '|' + cpuDir;
    log.status({ key: 'ready' }, 1);
    this.setState({ phase: 'ready', label: used.label, worker: used.worker, loadSeconds: (this.env.now() - t0) / 1000 });
  }

  /** The file threads left (the engine changed, or it stuck). */
  dropFileThreads(): void { for (const t of this.fileThreads) { t.dead = true; t.stop(); } this.fileThreads = []; this.fileThreadsFor = null; this.fileThreadsCap = ''; }

  // A file thread is started only when a pick has a second picture, in the background (the first picture
  // does not wait for it), and at most one (owner's phone, 2026-10-22: with two more copies of the accurate
  // model loading the engine's own capture thread stopped answering — memory — and one photo took 30 s).
  // It is kept for the next picks of the same engine. growFiles(lane) — called with each lane that comes up.
  growFiles(onLane: (lane: number) => void): void {
    const { log } = this, { name, key } = this.capKey(), g = this.gen;
    if (this.fileThreadsFor !== this.engine || this.fileThreadsCap !== key) { this.dropFileThreads(); this.fileThreadsFor = this.engine; this.fileThreadsCap = key; }
    if (this.fileThreads.length) { this.fileThreads.forEach((t, k) => { if (!t.dead) onLane(k + 1); }); return; }
    const cores = this.env.cores || 2, mem = this.env.memory || 4;
    if (mem < 4 || cores < 4) return;  // each thread holds its own copy of the accurate model (~80 MB at work)
    let me: ThreadEngine | null = null;
    const e: LoadableEngine = this.workerEngine(1, this.settings.cpuDir, () => { log.err('The file thread stopped answering — its pictures go to the main thread'); if (me) me.dead = true; e.stop(); });
    const forEngine = this.engine;
    this.track(e, e.load(name, null, 'wasm', true)).then(() => {
      if (this.closed(g) || this.fileThreadsFor !== forEngine || this.fileThreadsCap !== key) { e.stop(); return; }  // closed or changed meanwhile
      me = { detect: (_which, input) => e.detect('live', input), warp: e.warp, hasCap: () => false, stop: () => e.stop(), label: 'the file thread' };
      this.fileThreads = [me];
      log.log('Picked files: a second thread is working too');
      onLane(1);
    }, err => { e.stop(); if (!this.closed(g)) log.noteFail('File thread', errText(err)); });
  }

  /** Everything stopped (the scanner closed): every thread and session, every start and thread load still
   *  running (each stops what it made when it ends), and what this open learnt — the stuck ways, a fall back
   *  to the page —, as the lab's reload did; the GPU layout and the failures' log stay. */
  stopAll(): void {
    this.gen++;
    for (const e of this.inFlight) { try { e.stop(); } catch { /* gone */ } }
    this.inFlight.clear();
    this.ensuring = null; this.capLoading = null;
    this.dropFileThreads();
    if (this.engine) { try { this.engine.stop(); } catch { /* gone */ } this.engine = null; this.engineKey = ''; }
    if (this.capThread) { this.capThread.stop(); this.capThread = null; }
    this.capFor = '';
    this.stuckWays.clear(); this.engineWay = null; this.pageOnly = false;
    this.setState({ phase: 'idle', label: '—', worker: true, loadSeconds: null });
  }
}
