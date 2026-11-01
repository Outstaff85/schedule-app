// The scanner's engine (docs/scan-plan.md → S9): the ways the models run, ported unchanged from the lab's
// former plain page (pageEngine, workerEngine, poolEngine, capOnly, WAYS, startSession / ensureSession,
// ensureCap, onStuck, growFiles / dropFileThreads) into one class per scanner, Engines(surface, log):
//  - the ways: a pool of CPU threads first (2026-11-01: the frame in about 4 s; a session on the owner's phone's GPU
//    took 6 s, on its CPU 2 s — it replaced "every open tries the best way first", 2026-10-22), the GPU's live frame
//    beside a CPU capture thread as its fall back, then one background thread with several CPU threads, one with one,
//    the page itself; one model for both keeps the GPU first (the pool would hold three copies of the accurate model).
//    Each is tried in turn: a way that fails or goes silent for 25 s is dropped (with its throwaway background thread)
//    and the next starts clean; a way whose live thread stopped answering while scanning, or whose GPU keeps failing,
//    is not tried again until the scanner closes. The capture thread is no way: when it stops answering it alone is
//    dropped and started again, the live frame goes on.
//  - the GPU joins the pool (stage 2, 2026-11-01; docs/scan-plan.md → The CPU first): the CPU gives the first frame, but
//    three CPU threads starve the page's thread (the owner's phone: the screen and the follow at half the GPU's rate).
//    So once the capture thread is up and GPU_AFTER answers were given, on `auto` with WebGPU there, the way not stuck
//    and no pick in work (gpuJoin, asked at each answer), two ONNX Runtime 1.30 threads load in the background inside
//    the same pool and take turns with the CPU's for a trial of GPU_TRIAL answers. Accepted if the GPU's time per frame
//    beats the CPU's (GPU_ms / 2 < CPU_ms / POOL): the CPU threads leave the turn and stop when their frames are done,
//    the way becomes bg-gpulive; the `engine` object stays, so a shot, the file threads and the live frame see nothing
//    (no live.forget()). Refused, failed or hung: the GPU's threads stop and the pool carries on, not tried again until
//    the settings change or the scanner closes (a put-away during it is no refusal: the next open tries again). Accepted,
//    any detect error or GPU_SILENT_MS of silence leaves the way (onStuck): a new pool in about 3 s, the capture thread
//    kept. The lab's explicit backends never hand over: they stay comparisons.
//    Nothing is remembered between opens (owner, 2026-10-22) but the GPU layout that worked, the failures' log and
//    a GPU check that passed (owner, 2026-10-27: kept with the model's stamp, the ONNX Runtime version and the
//    browser — the same three skip the check next time; removed by a run-time failure of that GPU session; a
//    failure never kept): the lab reloaded its page on every open, the engine now outlives a close in the manager page, so
//    stopAll() forgets the stuck ways and a fall back to the page, and stops every start still loading (a
//    generation number: a load that ends after the close stops its threads instead of keeping them).
//  - every session is released when its way stops (the page way's sessions live in the page's own heap).
//  - the light model first (owner, 2026-10-27 — it replaced "the accurate model first", 2026-10-22): the live
//    frame's model on its way, so the camera and its frame come as soon as it is ready; the accurate model's
//    capture thread (on the CPU) after it, never beside it — never two models loading at once —, and after the
//    session's gate too (capHold: the first answer, then the readers; a pick goes past the readers). Picked photos
//    and PDFs go only to the accurate model and wait for it; the live frame's pool shares it — one copy of it.
//  - picked files: at most one more thread with the accurate model, none under 4 GB of memory or 4 cores.
//  - the pool: at most 3 live threads, 2 under 4 GB of memory (each holds its own ONNX Runtime).
//  - models.json read once per open (modelsInfo, shared with the readers): each thread's 'load' carries the
//    model files' stamps, so a kept model of the same version is used with no request (models.ts fetchModel).
//  - the capture and file threads are keyed on the accurate model and the CPU's ONNX Runtime build together,
//    so the lab's CPU engine choice reaches them too.
// Every model and ONNX Runtime file comes from the surface (surface.ts): the site's from /scan/, the lab's
// from /scan-lab/.
import { S, warpRGBA } from './geometry';
import type { ScanLog } from './log';
import { cpuSession, detectRGBA, downloadProgress, errText, fetchModel, gpuPassed, modelStamps, newGpuPass, openSession, ortVersion, readModels, userAgent, WRONG_GPU, type Ep, type GpuPasses, type ModelsInfo, type Opened, type Want } from './models';
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
  /** A thread on the GPU joining the pool: from now on any detect error, or ms of silence on a detect, goes to its
   *  onHang (a thread at a warp keeps WATCH_MS: the face finder's looks are no silence). */
  strict?(ms: number): void;
  /** The CPU pool's side of the GPU joining it (Engines.gpuJoin). */
  hand?: PoolHand;
  /** A pool whose accurate model comes after its live models: whether it is up now, and the wait for it (true once
   *  up, false when it could not start — the shot then keeps the live frame's corners). The pool asks the engines'
   *  capture thread each time, so a thread started again, or up after a failure, is its thread at once. */
  capUp?(): boolean;
  capWait?(): Promise<boolean>;
}
/** What a pool does for the GPU joining it. */
export interface PoolHand {
  /** The live answers it gave so far. */
  answers(): number;
  /** The GPU's threads, still loading: from now on they stop with the pool. */
  coming(threads: LoadableEngine[]): void;
  /** They join the frames' turn; resolves with n GPU answers' ms and the last CPU answers' ms, rejects on an answer
   *  over maxMs, or when they leave or the pool stops. */
  trial(n: number, maxMs: number): Promise<{ gpu: number[]; cpu: number[] }>;
  /** Accepted: the CPU threads leave the turn, each stopped when its work is done. */
  accept(): void;
  /** Refused: the GPU's threads leave, each stopped when its work is done; the pool goes on as it was. */
  refuse(): void;
}
/** The capture thread as an engine of its own (picked files), or a file thread. */
export interface ThreadEngine extends Engine { label: string; raw?: LoadableEngine; dead?: boolean }

/** A background thread as the engine sees it (a Worker; the browser tests' stand-in speaks the same messages,
 *  src/scan/hooks.ts stubWorkers). */
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
/** Where the GPU checks that passed are kept: this key + ':' + the surface's cache name, so the site's and the lab's
 *  are apart (scanGpuPassed:scan-models, scanGpuPassed:scan-lab-models). */
export const GPU_PASS_KEY = 'scanGpuPassed';
const WATCH_MS = 25000;
/** Detects in a row a thread that runs a model on the GPU may fail before its way is left for the next (a lost GPU
 *  device rejects every run; 2, or the live frame's own stop after 5 failed frames comes first on two threads). */
export const GPU_ERRORS = 2;
/** The GPU joining the pool: its live threads, the answers given before it starts, the trial's GPU answers, and the
 *  silence (or the one answer's time) that fails it — after the hand-over too, where the way is left. */
export const GPU_THREADS = 2;
export const GPU_AFTER = 20;
export const GPU_TRIAL = 10;
export const GPU_SILENT_MS = 3000;
// How long a model start waits for models.json's stamps before it checks its kept copy by ETag instead (engines.stampsFor).
export const STAMPS_WAIT_MS = 4000;

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
  /** The GPU was tried on this pool (it joined, or was refused): not again until the settings change or the scanner closes. */
  private gpuTried = false;
  /** The GPU is coming (loading, or on trial): ends that, as no failure of the GPU. */
  private gpuStop: ((why: string) => void) | null = null;
  /** The GPU's threads' load running now: the accurate model's load waits for it — never two models loading at once. */
  private gpuLoads: Promise<unknown> | null = null;
  /** Called at the hand-over: the figures of the CPU's answers go (the session's). */
  handed: (() => void) | null = null;
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
  /** The capture thread's own load running now (past its wait for the live frame's models): a start of the live
   *  frame's models waits for it — never two models loading at once. */
  private capBusy: Promise<unknown> | null = null;
  /** A capture thread's load stopped answering this open and was started again: a second one is not. */
  private capRetried = false;
  /** What the accurate model waits for once the live frame's models are up (the session's gate: session.ts capHold),
   *  resolving to what that was, for the log; unset: nothing. */
  capHold: (() => Promise<string>) | null = null;
  fileThreads: ThreadEngine[] = [];
  private fileThreadsFor: LoadableEngine | null = null;
  private ensuring: Promise<void> | null = null;
  private changes = new Set<(s: EngineState) => void>();
  private fileThreadsCap = '';

  constructor(surface: SurfaceRef, readonly log: ScanLog, env: Partial<EngineEnv> = {}) {
    this.env = { ...defaultEnv(), ...env };
    this.ref = surfaceRef(surface);
    this.POOL = Math.max(1, Math.min((this.env.memory || 4) < 4 ? 2 : 3, Math.floor((this.env.cores || 2) / 2)));
    this.THREADS = this.env.isolated ? Math.min(4, this.env.cores || 1) : 1;
    this.WAYS = [
      { id: 'bg-gpulive', label: 'GPU live + CPU capture · bg', worker: true, gpuLive: true, ep: 'wasm', threads: 1 },
      { id: 'bg-pool', label: 'CPU · ' + this.POOL + ' bg threads + 1', worker: true, pool: true, ep: 'wasm', threads: 1 },
      { id: 'bg-cpu', label: 'CPU ×' + this.THREADS + ' · bg', worker: true, ep: 'wasm', threads: this.THREADS },
      { id: 'bg-cpu1', label: 'CPU ×1 · bg', worker: true, ep: 'wasm', threads: 1 },
      { id: 'page-cpu', label: 'CPU ×' + this.THREADS + ' · page', worker: false, ep: 'wasm', threads: this.THREADS },
    ];
  }

  /** The surface's models.json, read once per open (the readers share it: ScanSession), again after stopAll() —
   *  a new deploy is seen by the next open. Its model version and file fingerprints are what a kept model is
   *  checked against (models.ts fetchModel: no request while they match). A failed read is tried again next time. */
  private info: Promise<ModelsInfo> | null = null;
  modelsInfo(): Promise<ModelsInfo> {
    if (!this.info) {
      const t0 = this.env.now(), p = readModels(this.ref);
      this.info = p;
      p.then(i => this.log.log('Time: models.json read (version ' + (i.version || 'unknown') + ') — ' + Math.round(this.env.now() - t0) + ' ms'),
        () => { if (this.info === p) this.info = null; });
    }
    return this.info;
  }
  /** The stamps of the model files a thread loads (null when models.json could not be read, or did not answer in
   *  STAMPS_WAIT_MS: the ETag check — a slow models.json never holds the models back; the readers still wait for it). */
  private stampsFor(names: string[]): Promise<Record<string, string> | null> {
    return new Promise(resolve => {
      const t = setTimeout(() => { this.log.log('models.json not read in ' + STAMPS_WAIT_MS / 1000 + ' s — the models checked by their ETag'); resolve(null); }, STAMPS_WAIT_MS);
      this.modelsInfo().then(i => modelStamps(i, names), () => null).then(st => { clearTimeout(t); resolve(st); });
    });
  }

  /** Listen to the engine's state; returns the unsubscribe. */
  onChange(fn: (s: EngineState) => void): () => void { this.changes.add(fn); return () => { this.changes.delete(fn); }; }
  /** The lab's tools change the settings; setting inWorker asks for the background ways again. */
  setSettings(patch: Partial<EngineSettings>): void {
    if (patch.inWorker !== undefined) this.pageOnly = false;
    this.gpuTried = false;
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

  // The GPU checks that passed on this device (models.ts GpuPass), by model — the surface's own key.
  private passKey(): string { return GPU_PASS_KEY + ':' + this.ref.cache; }
  gpuPasses(): GpuPasses {
    try {
      const v = this.env.store ? this.env.store.getItem(this.passKey()) : null, o = v ? JSON.parse(v) : null;
      return o && typeof o === 'object' && !Array.isArray(o) ? o as GpuPasses : {};
    } catch { return {}; }
  }
  private passesWrite(p: GpuPasses): void { try { if (this.env.store) this.env.store.setItem(this.passKey(), JSON.stringify(p)); } catch { /* blocked */ } }
  /** Checks that passed now: kept (a failed one never comes here). */
  private passesPut(p: unknown): void {
    if (!p || typeof p !== 'object') return;
    const add = p as GpuPasses, names = Object.keys(add);
    if (!names.length) return;
    this.passesWrite({ ...this.gpuPasses(), ...add });
    for (const n of names) this.log.log('GPU check passed for ' + n + ' (' + add[n].layout + ') — remembered on this device');
  }
  /** A GPU session failed at run time (its way dropped, an error, a hang, a wrong answer): the passes of its models
   *  removed, so the next open checks the GPU again. */
  forgetGpuPasses(models: string[], why: string): void {
    const cur = this.gpuPasses(), hit = models.filter(m => Object.prototype.hasOwnProperty.call(cur, m));
    if (!hit.length) return;
    for (const m of hit) delete cur[m];
    this.passesWrite(cur);
    this.log.log('GPU check of ' + hit.join(', ') + ' forgotten (' + why + ') — the next open checks the GPU again');
  }

  private rgbaOf(input: DetectInput): Uint8ClampedArray {
    if (input.rgba) return input.rgba;
    const c = mkCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    g.drawImage(input.bitmap as ImageBitmap, 0, 0); (input.bitmap as ImageBitmap).close(); return g.getImageData(0, 0, S, S).data;
  }

  /** The models in the page itself. */
  pageEngine(): LoadableEngine {
    let ort: Ort | null = null, live: OrtSession | null = null, cap: OrtSession | null = null, face: OrtSession | null = null;
    let liveCheck = false, capCheck = false, gpuModels: string[] = [];
    const { log } = this;
    return {
      load: async (liveName, capName, want, withFace) => {
        // as in a thread (worker.ts): ONNX Runtime at once; beside it the stamps, then the first model's file and the
        // face finder's; the sessions in turn
        const dir = this.settings.cpuDir, t0 = this.env.now();
        const ortP = loadOrt(this.ref, dir, this.THREADS, want !== 'wasm').then(o => { log.log('Time: ONNX Runtime (' + dir + ') loaded for ' + liveName + ' (page) — ' + Math.round(this.env.now() - t0) + ' ms'); return o; });
        ortP.catch(() => {});  // its failure is the load's, below
        const stamps = await this.stampsFor([liveName, ...(capName ? [capName] : []), ...(withFace !== false ? ['yunet.onnx'] : [])]);
        const stamp = (n: string): string | null => (stamps && stamps[n]) || null;
        const firstBytes = fetchModel(this.ref, liveName, downloadProgress(liveName, log.status), { stamp: stamp(liveName), said: log.log });
        const faceBytes = withFace !== false ? fetchModel(this.ref, 'yunet.onnx', () => {}, { stamp: stamp('yunet.onnx'), said: log.log }) : null;
        firstBytes.catch(() => {}); if (faceBytes) faceBytes.catch(() => {});
        ort = await ortP;
        // the GPU checks remembered on this device (as in a thread, worker.ts)
        const ov = ortVersion(ort, dir), ua = userAgent(), known = this.gpuPasses(), passes: GpuPasses = {}, gpu: string[] = [];
        const passed = (n: string) => gpuPassed(known[n], stamp(n), ov, ua);
        const noted = (n: string, o: Opened): Opened => { if (o.ep === 'webgpu') gpu.push(n); const p = newGpuPass(o, stamp(n), ov, ua); if (p) passes[n] = p; return o; };
        const a = noted(liveName, await openSession(ort, this.ref, liveName, want, log.status, log.any, this.layoutGet(), { bytes: firstBytes, time: log.log, passed: passed(liveName) })); live = a.sess;
        const b = capName ? noted(capName, await openSession(ort, this.ref, capName, want, log.status, log.any, this.layoutGet(), { stamp: stamp(capName), time: log.log, passed: passed(capName) })) : a; cap = b.sess;
        liveCheck = a.checked === 'skipped'; capCheck = b.checked === 'skipped'; gpuModels = gpu;
        this.layoutSet(a.layout || b.layout);
        this.passesPut(passes);
        if (faceBytes) {
          const t1 = this.env.now();
          face = await cpuSession(ort, this.ref, 'yunet.onnx', faceBytes);
          log.log('Time: face finder ready (page) — ' + Math.round(this.env.now() - t1) + ' ms');
        }
        return a.ep + (b.ep !== a.ep ? '/' + b.ep : '');
      },
      hasCap: () => cap !== live,
      detect: async (which, input) => {
        const t = this.env.now();
        try {
          const res = await detectRGBA(ort as Ort, (which === 'cap' ? cap : live) as OrtSession, this.rgbaOf(input), which === 'cap' ? capCheck : liveCheck);
          return { res, ms: this.env.now() - t };
        } catch (e) { if (gpuModels.length) this.forgetGpuPasses(gpuModels, 'an error on the GPU: ' + errText(e)); throw e; }
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
   *  A thread that says nothing for 25 s while a call waits is taken as stuck: its calls fail and onHang runs — as
   *  when a GPU session whose check was skipped gives a wrong answer (onHang(why)). A run-time failure of a thread
   *  that runs a model on the GPU (a hang, a thread error, an error or a wrong answer on a detect) removes that
   *  model's remembered GPU check. strict(ms) (the GPU joining a pool): any detect error goes to onHang, and so does
   *  ms of silence on a detect — not counting a page that was frozen meanwhile (a phone's screen off, no timers run). */
  workerEngine(threads: number, dir: OrtDir = this.settings.cpuDir, onHang: (why?: string) => void = why => this.onStuck(why)): LoadableEngine {
    const { env, log } = this;
    const w = env.spawn(), waiting = new Map<number, { resolve: (m: WorkerOut & { type: 'reply' }) => void; reject: (e: Error) => void; kind: string }>();
    let n = 0, two = false, heard = env.now(), stopped = false, gpuModels: string[] = [], gpuErrors = 0, silence = 0, tick = heard;
    const forgetGpu = (why: string) => { if (gpuModels.length) this.forgetGpuPasses(gpuModels, why); };
    const failAll = (why: string) => { for (const p of waiting.values()) p.reject(new Error(why)); waiting.clear(); };
    const limit = (): number => (silence && ![...waiting.values()].some(p => p.kind !== 'detect') ? silence : WATCH_MS);
    const watch = env.setInterval(() => {
      const t = env.now(), max = limit();
      if (silence && t - tick > 3000) heard = t;  // the timers stood still: so did the thread
      tick = t;
      if (waiting.size && t - heard > max) { failAll('no answer for ' + max / 1000 + ' s'); forgetGpu('the thread stopped answering'); onHang(); }
    }, 1000);
    w.onmessage = ({ data: m }) => {
      heard = env.now();
      if (m.type === 'status') log.status(m.status, m.frac);
      else if (m.type === 'log') log.any(m.text);
      else if (m.type === 'reply') {
        const p = waiting.get(m.id); waiting.delete(m.id);
        if (!p) return;  // a late answer to a call given up on: dropped
        if (!m.error) { if (p.kind === 'detect') gpuErrors = 0; p.resolve(m); return; }
        p.reject(new Error(m.error));
        if (p.kind === 'detect' && silence) { forgetGpu('an error on the GPU: ' + m.error); onHang(m.error.startsWith(WRONG_GPU) ? 'gave a wrong answer on the GPU' : 'failed on the GPU (' + m.error + ')'); }
        else if (p.kind === 'detect' && gpuModels.length) {
          forgetGpu('an error on the GPU: ' + m.error);
          if (m.error.startsWith(WRONG_GPU)) onHang('gave a wrong answer on the GPU');  // the way is left, as a hung one
          // a lost GPU device rejects every run and never goes silent: the way is left too, when there is another
          else if (++gpuErrors >= GPU_ERRORS && this.waysFor().some(way => way.id !== this.engineWay)) onHang('kept failing on the GPU');
        }
      }
    };
    w.onerror = e => { log.err('Worker error: ' + (e.message || 'could not start')); failAll('the background thread failed: ' + (e.message || 'could not start')); forgetGpu('the thread failed'); };
    // a request to a thread that had nothing to do starts the clock again: an idle thread says nothing, so
    // its first request after 25 s was taken as stuck at once (every picked file, 2026-10-22)
    type Msg = WorkerIn extends infer T ? T extends { id: number } ? Omit<T, 'id'> : never : never;
    const call = (msg: Msg, transfer?: Transferable[]) => new Promise<WorkerOut & { type: 'reply' }>((resolve, reject) => {
      if (stopped) { reject(new Error('the model was stopped')); return; }  // a stopped thread is sent nothing more
      if (!waiting.size) heard = env.now();
      const id = ++n; waiting.set(id, { resolve, reject, kind: msg.type }); w.postMessage({ ...msg, id } as WorkerIn, transfer || []);
    });
    return {
      load: async (liveName, capName, want, withFace = true) => {
        two = !!capName;
        // the load sent at once (the thread starts ONNX Runtime's load now); the files' stamps from models.json (read
        // once per open) follow in a 'stamps' message — a kept copy of the same version is used with no request
        const r = call({ type: 'load', surface: this.ref, ort: dir, live: liveName, cap: capName, want, threads, face: withFace, layout: this.layoutGet(), passes: this.gpuPasses() });
        void this.stampsFor([liveName, ...(capName ? [capName] : []), ...(withFace ? ['yunet.onnx'] : [])]).then(stamps => {
          if (!stopped) w.postMessage({ type: 'stamps', stamps } as WorkerIn, []);
        });
        const m = await r;
        this.layoutSet(m.layout as string | null);
        gpuModels = Array.isArray(m.gpu) ? m.gpu as string[] : [];
        if (!stopped) this.passesPut(m.passes);
        return m.ep as string;
      },
      hasCap: () => two,
      detect: async (which, input) => {
        const m = input.bitmap ? await call({ type: 'detect', which, bitmap: input.bitmap }, [input.bitmap]) : await call({ type: 'detect', which, rgba: (input.rgba as Uint8ClampedArray).buffer as ArrayBuffer }, [(input.rgba as Uint8ClampedArray).buffer as ArrayBuffer]);
        return { res: m.res as Corners, ms: m.ms as number };
      },
      warp: async (rgba, wd, h, pts, upright) => (await call({ type: 'warp', rgba: rgba.buffer as ArrayBuffer, w: wd, h, pts, upright }, [rgba.buffer as ArrayBuffer])).out as Upright,
      strict(ms) { silence = ms; },
      stop() { stopped = true; env.clearInterval(watch); failAll('the model was stopped'); w.terminate(); },  // nothing left waiting on it
    };
  }

  // A live thread that stops answering while scanning (a phone's GPU was seen to hang, and every later call then
  // waited on it): the way it ran on is left for this page, and the model starts again on the next way at the next
  // use (the live frame, a picked file). The capture thread does not come here: capLost.
  onStuck(why = 'stopped answering'): void {
    if (!this.engine) return;
    const w = this.WAYS.find(x => x.id === this.engineWay), label = w ? w.label : String(this.engineWay);
    this.log.err('The model ' + why + ' on "' + label + '" — it starts again on the next way');
    this.log.noteFail(label, why + ' while scanning');
    if (this.engineWay) this.stuckWays.add(this.engineWay);
    const old = this.engine; this.engine = null; this.engineKey = ''; this.dropFileThreads();
    try { old.stop(); } catch { /* gone already */ }
  }

  // Several single-thread background threads: the live frames go to them in
  // turn (2–3 frames worked on at once), the accurate model has its own thread,
  // so a capture never stops the live frame. Phones that refuse CPU threads
  // inside a background thread still run several background threads.
  // capOf (the light model first, owner 2026-10-27): the accurate model's thread — the engines' one capture thread
  // (ensureCap), which picked files use too — asked for only once the live threads are loaded, never beside them;
  // the pool is ready (the camera and its frame go on) without waiting for it. A shot taken before it is up is cut
  // by the live frame's corners at once (on the first live thread, which has the face finder for that) and waits
  // for it to refine them (capWait); one that could not start leaves the shot with the live frame's corners, until a
  // later ensureCap (a pick, the next open) brings it up. The pool never stops the shared thread, and asks for it
  // each time (cap): a thread started again is its thread at once.
  // hand (the GPU joining, gpuCome): the threads that come and go are this pool's `lives`, the object stays. A thread
  // that leaves stops only when its work is done (work: its frames and warps), so no frame or shot is lost with it.
  poolEngine(nLive: number = this.POOL, liveEp: Ep | null = null, capOf: (() => Promise<LoadableEngine>) | null = null): LoadableEngine {
    const { log } = this;
    const leaving = new Set<LoadableEngine>(), work = new Map<LoadableEngine, number>();
    const thread = (): LoadableEngine => {
      // one that left and hung has nothing more to give: it alone stops
      const e: LoadableEngine = this.workerEngine(1, liveEp === 'webgpu' ? GPU_ORT : this.settings.cpuDir, why => { if (leaving.delete(e)) e.stop(); else this.onStuck(why); });
      return e;
    };
    const lives = Array.from({ length: nLive }, thread);
    const free = lives.slice();
    let two = false, capFailed = false, stopped = false, given = 0;
    let gpus: LoadableEngine[] = [], trial: { n: number; maxMs: number; ok: (r: { gpu: number[]; cpu: number[] }) => void; no: (e: Error) => void } | null = null;
    const cpuMs: number[] = [], gpuMs: number[] = [];
    const cap = (): LoadableEngine | null => (two && this.capReady() && this.capThread ? this.capThread.raw as LoadableEngine : null);
    const ask = (): Promise<LoadableEngine | null> => (capOf as () => Promise<LoadableEngine>)().then(e => { capFailed = false; return stopped ? null : e; }, err => {
      capFailed = true;
      log.log('The accurate model could not start for the shots (' + errText(err) + ') — they keep the live frame\'s corners');
      return null;
    });
    const out = (a: LoadableEngine[], e: LoadableEngine): void => { const i = a.indexOf(e); if (i >= 0) a.splice(i, 1); };
    const leave = (e: LoadableEngine): void => { out(lives, e); out(free, e); if (work.get(e)) leaving.add(e); else e.stop(); };
    const using = async <T>(e: LoadableEngine, f: () => Promise<T>): Promise<T> => {
      work.set(e, (work.get(e) || 0) + 1);
      try { return await f(); } finally {
        const left = (work.get(e) || 1) - 1;
        work.set(e, left);
        if (!left && leaving.delete(e)) e.stop();
      }
    };
    const endTrial = (why: string): void => { const t = trial; trial = null; if (t) t.no(new Error(why)); };
    const answered = (e: LoadableEngine, ms: number): void => {
      given++;
      if (!gpus.includes(e)) { cpuMs.push(ms); if (cpuMs.length > 20) cpuMs.shift(); return; }
      if (!trial) return;
      if (ms > trial.maxMs) { endTrial('an answer took ' + (ms / 1000).toFixed(1) + ' s'); return; }
      gpuMs.push(ms);
      if (gpuMs.length >= trial.n) { const t = trial; trial = null; t.ok({ gpu: gpuMs.slice(), cpu: cpuMs.slice() }); }
    };
    return {
      get size() { return lives.length; },
      shared: !!capOf,
      hand: {
        answers: () => given,
        coming: threads => { gpus = threads; },
        trial: (n, maxMs) => new Promise((ok, no) => {
          if (stopped) { no(new Error('the model was stopped')); return; }
          trial = { n, maxMs, ok, no };
          lives.push(...gpus); free.push(...gpus);
        }),
        accept: () => { for (const e of lives.filter(x => !gpus.includes(x))) leave(e); },
        refuse: () => { endTrial('the GPU left'); for (const e of gpus) leave(e); },
      },
      async load(liveName, capName, want) {
        two = !!capName && !!capOf;
        // the first live thread holds the face finder: a shot before the accurate model is up is cut there
        const eps = await Promise.all(lives.map((e, i) => e.load(liveName, null, liveEp || want, i === 0)));
        if (two && !stopped) void ask();  // the accurate model right after the live frame's — not waited for here
        return eps[0] + (two ? '/wasm' : '');
      },
      hasCap: () => two && (!capFailed || !!cap()),
      capUp: () => !!cap(),
      capWait: async () => !!cap() || (two && !capFailed && !!(await ask())),
      async detect(which, input) {
        if (which === 'cap' && two) {
          const c = cap() || (capFailed ? null : await ask());
          if (c) return c.detect('live', input);
        }
        const e = free.shift() || lives[0];
        try {
          const r = await using(e, () => e.detect('live', input));
          answered(e, r.ms);
          return r;
        } finally { if (lives.includes(e) && !free.includes(e)) free.push(e); }
      },
      warp: (rgba, w, h, pts, upright) => {
        const c = cap(), e = c || lives[0];
        return c ? c.warp(rgba, w, h, pts, upright) : using(e, () => e.warp(rgba, w, h, pts, upright));
      },
      stop() {
        stopped = true;
        endTrial('the model was stopped');
        for (const e of new Set([...lives, ...gpus, ...leaving])) e.stop();
      },
    };
  }

  private capOnly(e: LoadableEngine): ThreadEngine {
    return { detect: (_which, input) => e.detect('live', input), warp: e.warp, hasCap: () => false, stop: () => e.stop(), raw: e, label: 'the capture thread' };
  }

  /** Whether the accurate model's capture thread is up now (for the settings asked). */
  capReady(): boolean { return !!this.capThread && this.capFor === this.capKey().key; }
  /** The accurate model's load is running now (the live frame eases off beside it: session.ts). */
  get capLoads(): boolean { return !!this.capBusy; }
  /** The live way holds the accurate model itself (one thread for both models): no capture thread is needed for its
   *  shots, only for a pick, which asks for it. */
  capInLive(): boolean { return !!this.engine && this.engine.hasCap() && !this.engine.shared; }

  // The capture thread stopped answering: only it goes — the live threads are healthy (it is on the CPU, apart from
  // them) — and it starts again; the pool takes the new one by itself. One that stopped at work starts again each
  // time, as that takes a use; one whose load stopped once more this open is left to the next ask (a pick, an open).
  private capLost(e: LoadableEngine): void {
    const atWork = !!this.capThread && this.capThread.raw === e, again = atWork || !this.capRetried, g = this.gen, key = this.capFor;
    this.log.err('The capture thread stopped answering' + (again ? ' — it starts again' : ''));
    this.log.noteFail('Capture thread', 'stopped answering');
    if (atWork) this.capThread = null;
    e.stop();
    if (!again) return;
    if (!atWork) this.capRetried = true;
    // a load that stopped ends in a rejection a moment later: the new start comes after that, or it would join it
    const start = (): void => { if (g === this.gen && key === this.capFor && !this.capThread) this.ensureCap().catch(() => {}); };
    (this.capLoading || Promise.resolve()).then(start, start);
  }

  // The accurate model's thread, on the CPU — the light model first (owner, 2026-10-27; it replaced "the accurate
  // model first", 2026-10-22): it starts after the live frame's models (a start of them running is waited for
  // — never two models loading at once: on the owner's phone that made the capture thread stop answering) and after
  // capHold (the session's gate: a load beside the first frame was the suspect in the gap between ready and that
  // frame), so the camera and its frame come first; picked photos and PDFs need only this thread and wait for it; the live frame's
  // pool shares it for the shot — one copy of the accurate model. ensureCap() → the thread (a capture-only engine
  // for a picked picture), started again when it failed or the model was changed.
  ensureCap(): Promise<ThreadEngine> {
    const { log } = this, { name, key } = this.capKey(), g = this.gen, dir = this.settings.cpuDir;
    if (this.capThread && this.capFor === key) return Promise.resolve(this.capThread);
    if (this.capLoading && this.capFor === key) return this.capLoading;
    if (this.capThread) { this.capThread.stop(); this.capThread = null; }
    this.capFor = key;
    const run = async (): Promise<ThreadEngine> => {
      const tw = this.env.now();
      let lives = false, held = '';
      // the hold over, a start of the live frame's models begun meanwhile (a model changed) is waited for too
      do {
        while (this.ensuring || this.gpuLoads) { lives = true; await (this.ensuring || this.gpuLoads as Promise<unknown>).catch(() => {}); }
        if (this.capHold) held = await this.capHold();
      } while (this.ensuring);
      const gone = this.closed(g);
      if (gone) throw gone;
      if (this.capFor !== key) throw new Error('the model was changed');
      const waited = Math.round(this.env.now() - tw);
      if (waited >= 1) log.log('Time: the accurate model waited for ' + [lives ? 'the live frame\'s models' : '', held].filter(Boolean).join(' and ') + ' — ' + waited + ' ms');
      if (!this.engine) log.status({ key: 'preparing_accurate' }, 0);
      const t0 = this.env.now();
      const e: LoadableEngine = this.workerEngine(1, dir, () => this.capLost(e));
      const busy = this.track(e, e.load(name, null, 'wasm', true));
      this.capBusy = busy;
      try { await busy; } catch (err) { e.stop(); if (!this.closed(g)) log.noteFail('Capture thread', errText(err)); throw err; }
      finally { if (this.capBusy === busy) this.capBusy = null; }
      const gone2 = this.closed(g);
      if (gone2 || this.capFor !== key) { e.stop(); throw gone2 || new Error('the model was changed'); }  // closed or changed meanwhile
      const t = this.capOnly(e);
      this.capThread = t;
      log.log('The accurate model is ready (' + ((this.env.now() - t0) / 1000).toFixed(1) + ' s) — photos and PDFs can go in');
      log.log('Time: accurate model ready (capture thread) — ' + Math.round(this.env.now() - t0) + ' ms');
      if (!this.engine) log.status({ key: 'ready_files' }, 1);
      return t;
    };
    const p: Promise<ThreadEngine> = run().finally(() => { if (this.capLoading === p) this.capLoading = null; });
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
    // the frame first (2026-11-01): the CPU pool comes up in about a third of the GPU's time, the GPU stays its fall
    // back. Only with a light model apart: a pool of one model would hold three copies of the accurate one.
    if (want === 'auto' && this.settings.model.includes('+')) ways = [...ways.filter(w => w.pool), ...ways.filter(w => !w.pool)];
    if (ways.some(w => !this.stuckWays.has(w.id))) ways = ways.filter(w => !this.stuckWays.has(w.id));
    return ways;
  }

  /** A start of the model is running (on the settings it began with). */
  get starting(): boolean { return !!this.ensuring; }

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
    // the pool ways share the accurate model's capture thread, asked for once their live threads are loaded
    const capOf = cap ? () => this.ensureCap().then(t => t.raw as LoadableEngine) : null;
    for (const w of this.waysFor(want, inWorker)) {
      // the accurate model's thread loading now (a pick, or the way before this one): waited for — never two
      // models loading at once
      if (this.capBusy) await this.capBusy.catch(() => {});
      let gone = this.closed(g);
      if (gone) throw gone;  // closed while the capture thread loaded
      log.status({ key: 'trying_way', way: w.label }, 0);
      const cand = w.gpuLive ? this.poolEngine(GPU_THREADS, 'webgpu', capOf) : w.pool ? this.poolEngine(this.POOL, null, capOf) : w.worker ? this.workerEngine(w.threads, w.ep === 'webgpu' ? GPU_ORT : cpuDir) : this.pageEngine();
      try { await this.track(cand, cand.load(live, cap || null, w.ep)); } catch (err) {
        cand.stop();
        gone = this.closed(g); if (gone) throw gone;
        // a GPU way that failed: its models' remembered GPU checks go (the next open checks again)
        if (w.gpuLive || w.ep === 'webgpu') this.forgetGpuPasses([live, ...(cap ? [cap] : [])], 'its way failed: ' + errText(err));
        log.noteFail(w.label, errText(err)); log.log('Trying the next way'); continue;
      }
      gone = this.closed(g);
      if (gone) { cand.stop(); throw gone; }  // closed while it loaded: its threads and sessions go
      e = cand; used = w; break;
    }
    if (!e || !used) { this.setState({ phase: 'failed', label: 'failed' }); log.status({ key: 'failed' }); throw new Error('no way to run the model'); }
    log.log('Live ' + live + (cap ? ', capture ' + cap : '') + ' running as ' + used.label);
    log.log('Time: live frame\'s models ready on ' + used.label + ' — ' + Math.round(this.env.now() - t0) + ' ms');
    this.engine = e; this.engineWay = used.id;
    // a start that fell back to the page stays there until the scanner closes (the lab unticked its
    // "background threads"); the key then matches the next asks, so the model is not started again each use
    if (inWorker && !used.worker) this.pageOnly = true;
    this.engineKey = model + '|' + want + '|' + this.inWorkerNow() + '|' + cpuDir;
    log.status({ key: 'ready' }, 1);
    this.setState({ phase: 'ready', label: used.label, worker: used.worker, loadSeconds: (this.env.now() - t0) / 1000 });
  }

  /** Asked at each live answer: the GPU joins the CPU pool when it is due (the head of this file). A pick in work is
   *  the caller's to tell: it does not ask then. */
  gpuJoin(): void {
    const e = this.engine, hand = e && e.hand;
    if (!e || !hand || this.gpuTried || this.gpuStop || this.engineWay !== 'bg-pool' || hand.answers() < GPU_AFTER) return;
    const { backend, model } = this.settings;
    if (backend !== 'auto' || !model.includes('+') || !this.env.gpu || !this.inWorkerNow() || this.stuckWays.has('bg-gpulive') || !this.capReady()) return;
    this.gpuTried = true;
    void this.gpuCome(e, hand);
  }

  /** The GPU coming (not joined yet) goes, and may come again with the next open (the scanner put away, its session kept). */
  gpuCancel(why: string): void { if (this.gpuStop) this.gpuStop(why); }

  private async gpuCome(pool: LoadableEngine, hand: PoolHand): Promise<void> {
    const { log } = this, g = this.gen, t0 = this.env.now(), live = this.settings.model.split('+')[0], way = this.WAYS.find(w => w.gpuLive) as Way;
    let stage = 'coming' as 'coming' | 'on' | 'over', up = false;
    const over = (said: string): void => {
      if (stage !== 'coming') return;
      stage = 'over'; this.gpuStop = null; this.gpuLoads = null;
      hand.refuse();
      log.log('GPU joins: ' + said);
    };
    const refused = (why: string): void => over('refused — ' + why + '; the CPU pool carries on');
    const hung = (why = 'stopped answering'): void => {
      if (stage === 'on') { this.onStuck(why); return; }
      if (stage !== 'coming') return;
      this.stuckWays.add(way.id); log.noteFail(way.label, why + ' while joining the CPU pool');
      refused(why);
    };
    this.gpuStop = why => { over('stopped — ' + why); this.gpuTried = false; };
    log.log('GPU joins: started — ' + hand.answers() + ' answers given, the capture thread up; ' + live + ' on ' + GPU_THREADS + ' threads beside the CPU pool');
    const threads = Array.from({ length: GPU_THREADS }, () => this.workerEngine(1, GPU_ORT, why => hung(why)));
    hand.coming(threads);
    try {
      const loads = threads.map((e, i) => this.track(e, e.load(live, null, 'webgpu', i === 0)));
      const settled: Promise<unknown> = Promise.allSettled(loads).then(() => { if (this.gpuLoads === settled) this.gpuLoads = null; });
      this.gpuLoads = settled;
      await Promise.all(loads);
      if (stage !== 'coming') return;
      up = true;
      log.log('Time: GPU threads ready beside the CPU pool — ' + Math.round(this.env.now() - t0) + ' ms');
      for (const e of threads) if (e.strict) e.strict(GPU_SILENT_MS);
      log.log('GPU joins: a trial of ' + GPU_TRIAL + ' answers');
      const { gpu, cpu } = await hand.trial(GPU_TRIAL, GPU_SILENT_MS);
      if (stage !== 'coming') return;
      const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length, gpuMs = mean(gpu), cpuMs = mean(cpu);
      const perGpu = gpuMs / GPU_THREADS, perCpu = cpuMs / this.POOL;
      log.log('GPU joins: trial — GPU ' + Math.round(gpuMs) + ' ms (' + Math.round(Math.min(...gpu)) + '–' + Math.round(Math.max(...gpu)) + ') on ' + GPU_THREADS + ' threads, ' + Math.round(perGpu) + ' ms a frame; CPU ' + Math.round(cpuMs) + ' ms on ' + this.POOL + ', ' + Math.round(perCpu) + ' ms a frame');
      if (!(perGpu < perCpu)) { refused('the GPU is no faster'); return; }
      stage = 'on'; this.gpuStop = null;
      hand.accept();
      this.engineWay = way.id;
      this.setState({ label: way.label, worker: true });
      if (this.handed) this.handed();
      log.log('GPU joins: accepted — the CPU threads stop when their frames are done, running as ' + way.label + ' (' + Math.round(this.env.now() - t0) + ' ms from the start)');
    } catch (err) {
      if (stage !== 'coming') return;
      if (this.closed(g) || this.engine !== pool) { over('stopped — the scanner closed or the model changed'); return; }
      if (up) log.noteFail(way.label, errText(err) + ' on the trial');
      else { this.forgetGpuPasses([live], 'it could not join: ' + errText(err)); log.noteFail(way.label, errText(err)); }
      refused(errText(err));
    }
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
    if (this.gpuStop) return;  // the GPU coming: no second heavy load beside it, the pick goes on one thread
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
    this.ensuring = null; this.capLoading = null; this.capBusy = null;
    this.dropFileThreads();
    if (this.engine) { try { this.engine.stop(); } catch { /* gone */ } this.engine = null; this.engineKey = ''; }
    if (this.capThread) { this.capThread.stop(); this.capThread = null; }
    this.capFor = '';
    this.stuckWays.clear(); this.engineWay = null; this.pageOnly = false; this.capRetried = false;
    this.gpuTried = false; this.gpuStop = null; this.gpuLoads = null;
    this.info = null;
    this.setState({ phase: 'idle', label: '—', worker: true, loadSeconds: null });
  }
}
