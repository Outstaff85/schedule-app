// The scanner's engine (docs/scan-plan.md → S9): ONNX Runtime Web, loaded at run time from the surface's own
// copy (<base>ort/ — 1.22, the CPU — or <base>ort130/ — 1.30, the GPU), never bundled: the fetch scripts put
// both builds there at deploy (scripts/scan/fetch-models.sh, scripts/scan-lab/fetch-models.sh). Typed with
// the little of it the engine uses.
import { ortDirUrl, ortModuleUrl, type OrtDir, type SurfaceRef } from './surface';

export type GpuLayout = 'NHWC' | 'NCHW';
export type ExecutionProvider = 'wasm' | { name: 'webgpu'; preferredLayout: GpuLayout };

export interface OrtTensor { readonly data: ArrayLike<number>; readonly dims: readonly number[] }
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
export interface Ort {
  env: { wasm: { wasmPaths?: string; numThreads?: number }; versions?: { web?: string } };
  InferenceSession: { create(model: Uint8Array, options?: { executionProviders?: ExecutionProvider[]; graphOptimizationLevel?: 'all' }): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
}

/** How a module is imported (tests put their own). */
export type OrtImport = (url: string) => Promise<unknown>;
let importer: OrtImport = url => import(/* @vite-ignore */ url);
export function setOrtImport(f: OrtImport): void { importer = f; loaded.clear(); }

interface Navish { hardwareConcurrency?: number; deviceMemory?: number; gpu?: unknown }
const nav = (): Navish => ((globalThis as { navigator?: Navish }).navigator) || {};
const origin = (): string => ((globalThis as { location?: { origin?: string } }).location || {}).origin || '';

/** Several CPU threads need a cross-origin isolated page (COOP/COEP headers); the scanner's pages are not
 *  isolated, so 1. */
export const ortThreads = (): number =>
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, nav().hardwareConcurrency || 1) : 1;

const loaded = new Map<string, Promise<Ort>>();

/** The ONNX Runtime build `dir` of the surface, loaded once in this page or thread; its .wasm files are
 *  fetched from the same folder, and it runs on `threads` CPU threads. */
export function loadOrt(s: SurfaceRef, dir: OrtDir, threads: number = ortThreads()): Promise<Ort> {
  const url = ortModuleUrl(s, dir);
  let p = loaded.get(url);
  if (!p) {
    p = importer(url).then(m => {
      const ort = m as Ort;
      if (!ort || !ort.InferenceSession) throw new Error('ONNX Runtime did not load (' + url + ')');
      ort.env.wasm.wasmPaths = origin() + ortDirUrl(s, dir);
      return ort;
    });
    p.catch(() => loaded.delete(url));  // a failed load is tried again next time
    loaded.set(url, p);
  }
  return p.then(ort => { ort.env.wasm.numThreads = threads; return ort; });
}

/** float32 [1, …dims] input from a Float32Array. */
export const tensor = (ort: Ort, data: Float32Array, dims: readonly number[]): OrtTensor => new ort.Tensor('float32', data, dims);
