// The scanner's on-device part (docs/scan-plan.md → S2b): the scanner lab's
// background threads (/scan-lab/scan-worker.js, which loads /scan-lab/scan-core.js
// and ONNX Runtime from /scan-lab/) run the light corner model on the camera
// frames and cut + turn the shot upright by the face. The same files as the lab —
// one copy, proven on the owner's phone. The accurate model runs on the server.

export const S = 256; // the model's input side

export type Pt = [number, number];
export type Detection = { pts: (Pt | null)[]; conf: number };
export type Warped = { data: ArrayBuffer; width: number; height: number; turn: number; turnError?: string };
export type FrameInput = { bitmap: ImageBitmap } | { rgba: Uint8ClampedArray };

type Reply = { id: number; error?: string; ep?: string; res?: Detection; ms?: number; out?: Warped };
type Status = (text: string, frac?: number) => void;

const LIVE = 'lite.onnx';
const CPU_ORT = 'ort', GPU_ORT = 'ort130'; // 1.22 is smoother on the CPU; 1.30 runs the GPU right where 1.22 gave zeros

/** One background thread of the lab (scan-worker.js). */
function workerThread(dir: string, onStatus: Status) {
  const w = new Worker('/scan-lab/scan-worker.js?ort=' + dir);
  const waiting = new Map<number, { resolve: (m: Reply) => void; reject: (e: Error) => void }>();
  let n = 0, heard = performance.now();
  const failAll = (why: string) => { for (const p of waiting.values()) p.reject(new Error(why)); waiting.clear(); };
  // A thread that says nothing for 25 s while it has work is taken as stuck.
  const watch = setInterval(() => { if (waiting.size && performance.now() - heard > 25000) failAll('no answer for 25 s'); }, 1000);
  w.onmessage = ({ data: m }) => {
    heard = performance.now();
    if (m.type === 'status') onStatus(m.text, m.frac);
    else if (m.type === 'reply') { const p = waiting.get(m.id); waiting.delete(m.id); if (p) { if (m.error) p.reject(new Error(m.error)); else p.resolve(m); } }
  };
  w.onerror = e => failAll('the background thread failed: ' + (e.message || 'could not start'));
  const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Reply>((resolve, reject) => {
    const id = ++n; waiting.set(id, { resolve, reject }); w.postMessage({ ...msg, id }, transfer);
  });
  return {
    async load(want: string, face: boolean) { return (await call({ type: 'load', live: LIVE, cap: null, want, threads: 1, face })).ep || want; },
    async detect(input: FrameInput) {
      const m = 'bitmap' in input ? await call({ type: 'detect', which: 'live', bitmap: input.bitmap }, [input.bitmap])
        : await call({ type: 'detect', which: 'live', rgba: input.rgba.buffer }, [input.rgba.buffer as ArrayBuffer]);
      return { res: m.res!, ms: m.ms || 0 };
    },
    async warp(rgba: Uint8ClampedArray, w: number, h: number, pts: Pt[]) {
      return (await call({ type: 'warp', rgba: rgba.buffer, w, h, pts, upright: true }, [rgba.buffer as ArrayBuffer])).out!;
    },
    stop() { clearInterval(watch); w.terminate(); },
  };
}

export type Engine = {
  size: number;
  label: string;
  detect(input: FrameInput): Promise<{ res: Detection; ms: number }>;
  warp(rgba: Uint8ClampedArray, w: number, h: number, pts: Pt[]): Promise<Warped>;
  stop(): void;
};

/** Several single-thread background threads: frames go to them in turn; the first also
 * holds the face finder and does the warps. */
async function pool(n: number, ep: 'webgpu' | 'wasm', onStatus: Status, label: string): Promise<Engine> {
  const threads = Array.from({ length: n }, () => workerThread(ep === 'webgpu' ? GPU_ORT : CPU_ORT, onStatus));
  try { await Promise.all(threads.map((t, i) => t.load(ep, i === 0))); }
  catch (e) { threads.forEach(t => t.stop()); throw e; }
  const free = threads.slice();
  return {
    size: n, label,
    async detect(input) {
      const t = free.shift() || threads[0];
      try { return await t.detect(input); } finally { if (!free.includes(t)) free.push(t); }
    },
    warp: (rgba, w, h, pts) => threads[0].warp(rgba, w, h, pts),
    stop: () => threads.forEach(t => t.stop()),
  };
}

const WAY_KEY = 'scanWay1';
const remembered = {
  get: () => { try { return localStorage.getItem(WAY_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(WAY_KEY, v); } catch { /* private mode */ } },
};

let engine: Promise<Engine> | null = null;

/** The engine, started once per page: the ways are tried best first (each dropped if it
 * fails or stays silent), the one that worked remembered on the device. */
export function startEngine(onStatus: Status): Promise<Engine> {
  if (engine) return engine;
  const cores = navigator.hardwareConcurrency || 2;
  const cpuN = Math.max(1, Math.min(3, Math.floor(cores / 2)));
  let ways = [
    { id: 'gpu', run: () => pool(2, 'webgpu', onStatus, 'GPU') },
    { id: 'cpu', run: () => pool(cpuN, 'wasm', onStatus, 'CPU ×' + cpuN) },
    { id: 'cpu1', run: () => pool(1, 'wasm', onStatus, 'CPU') },
  ];
  if (!('gpu' in navigator)) ways = ways.filter(w => w.id !== 'gpu');
  const at = ways.findIndex(w => w.id === remembered.get());
  if (at > 0) ways = ways.slice(at);
  engine = (async () => {
    let last: unknown = null;
    for (const w of ways) {
      try { const e = await w.run(); remembered.set(w.id); return e; }
      catch (e) { last = e; }
    }
    engine = null;
    throw last instanceof Error ? last : new Error('the scanner could not start');
  })();
  return engine;
}

/** A frame scaled to S×S (on the GPU when it can) for the model. */
let bitmapOk = typeof createImageBitmap === 'function';
const small = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export async function frameInput(src: CanvasImageSource, w: number, h: number): Promise<FrameInput | null> {
  if (bitmapOk) {
    try { return { bitmap: await createImageBitmap(src as ImageBitmapSource, { resizeWidth: S, resizeHeight: S, resizeQuality: 'low' }) }; }
    catch (e) { if ((e as Error)?.name === 'InvalidStateError') return null; bitmapOk = false; }
  }
  small!.width = S; small!.height = S;
  const g = small!.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, w, h, 0, 0, S, S);
  return { rgba: g.getImageData(0, 0, S, S).data };
}
