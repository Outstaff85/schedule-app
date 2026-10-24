// The scanner's engine (docs/scan-plan.md → S9): the models fetched and kept, and their sessions started —
// ported unchanged from the lab's scan-core.js (fetchModel, openSession, detectRGBA, synthCard, selfTest)
// and its models.json read, with every URL from the surface (surface.ts). Runs in the page and in the
// background thread (worker.ts), so it uses no DOM.
import { corners, S } from './geometry';
import { tensor, type ExecutionProvider, type GpuLayout, type Ort, type OrtSession } from './ort';
import type { EngineStatus, StatusOn } from './status';
import { modelUrl, modelsJsonUrl, type SurfaceRef } from './surface';
import { mkCanvas } from './upright';
import type { Corners, Pt } from './types';

export type Want = 'auto' | 'webgpu' | 'wasm';
export type Ep = 'webgpu' | 'wasm';
export type OnStatus = (s: EngineStatus, frac?: number) => void;
export type OnLog = (text: string) => void;

const hasGpu = (): boolean => !!((globalThis as { navigator?: { gpu?: unknown } }).navigator || {}).gpu;

// A model kept in the browser's cache is used only while it is still the file on
// the server (same ETag; one small HEAD request) — a changed model is downloaded
// again. Offline, the kept copy is used as it is. The cache key is the surface's own model URL (root-relative,
// so the same entry wherever the code runs: the page, every pool worker, the capture and file threads), as the
// old plain page and its worker shared one entry per model.
export async function fetchModel(s: SurfaceRef, name: string, onProgress: (got: number, total: number) => void): Promise<Uint8Array> {
  const url = modelUrl(s, name);
  try {
    const cache = await caches.open(s.cache);
    const hit = await cache.match(url);
    let etag: string | null = null;
    try { const h = await fetch(url, { method: 'HEAD', cache: 'no-cache' }); if (h.ok) etag = h.headers.get('etag'); } catch { /* offline: the kept copy */ }
    if (hit && (!etag || hit.headers.get('x-etag') === etag)) { onProgress(1, 1); return new Uint8Array(await hit.arrayBuffer()); }
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('model download failed: HTTP ' + res.status);
    const total = +(res.headers.get('content-length') || 0) || 0;
    const reader = res.body!.getReader(); const parts: Uint8Array[] = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got, total); }
    const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    try { await cache.put(url, new Response(buf, { headers: { 'x-etag': res.headers.get('etag') || etag || '' } })); } catch { /* cache full or blocked */ }
    return buf;
  } catch {
    const res = await fetch(url); return new Uint8Array(await res.arrayBuffer());
  }
}

/** A plain CPU session of a small model (the face finder, the readers). */
export async function cpuSession(ort: Ort, s: SurfaceRef, name: string): Promise<OrtSession> {
  return ort.InferenceSession.create(await fetchModel(s, name, () => {}), { executionProviders: ['wasm'] });
}

export interface Opened { sess: OrtSession; ep: Ep; layout: GpuLayout | null }

// GPU first when asked, else CPU; the warm-up run compiles the GPU shaders now
// rather than at the first camera frame or the capture.
// gpuLayout: the GPU memory layout that worked on this device last time (the page remembers it), tried
// first — a phone whose GPU gets one layout wrong then skips starting, warming and checking it on every open.
export async function openSession(ort: Ort, s: SurfaceRef, model: string, want: Want, onStatus: OnStatus, onLog: OnLog, gpuLayout?: string | null): Promise<Opened> {
  const bytes = await fetchModel(s, model, (got, total) => onStatus({ key: 'downloading', model, got, total }, total ? got / total : 0));
  // On the GPU both memory layouts are tried: some phone GPUs return zeros with one of them.
  const layouts: GpuLayout[] = gpuLayout === 'NCHW' ? ['NCHW', 'NHWC'] : ['NHWC', 'NCHW'];
  const order = (want === 'auto' ? ['webgpu', 'wasm'] as Ep[] : [want]).flatMap((ep): [Ep, GpuLayout?][] => ep === 'webgpu' ? layouts.map(l => ['webgpu', l]) : [[ep]]);
  let gpuWrong = false;
  for (const [ep, layout] of order) {
    if (ep === 'webgpu' && !hasGpu()) { onLog('WebGPU is not available here'); continue; }
    const name = ep === 'webgpu' ? 'the GPU (' + layout + ')' : 'the CPU';
    const on: StatusOn = ep === 'webgpu' ? { on: 'gpu', layout: layout as GpuLayout } : { on: 'cpu' };
    try {
      onStatus({ key: 'starting', model, ...on }, 1);
      // A step that hangs (seen on a phone) is given up after 20 s.
      const limit = <T>(p: Promise<T>, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(what + ' took over 20 s')), 20000))]);
      const provider: ExecutionProvider = ep === 'webgpu' ? { name: 'webgpu', preferredLayout: layout as GpuLayout } : ep;
      const sess = await limit(ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: 'all' }), 'starting');
      onStatus({ key: 'warming', model, ...on }, 1);
      await limit(sess.run({ [sess.inputNames[0]]: tensor(ort, new Float32Array(3 * S * S), [1, 3, S, S]) }), 'warm-up');
      // Each model is checked on its own: a GPU may run one right and the other wrong.
      if (ep === 'webgpu') {
        onStatus({ key: 'checking', model, ...on }, 1);
        const t = await limit(selfTest(ort, sess), 'self-test');
        onLog('GPU check, ' + model + ', layout ' + layout + ': ' + (t.ok ? 'right — used' : 'wrong on this GPU — not used') + ' (error ' + (t.err * 100).toFixed(1) + '%, confidence ' + t.conf.toFixed(2) + ')');
        if (!t.ok) { try { sess.release().catch(() => {}); } catch { /* gone already */ } gpuWrong = true; continue; }
      }
      return { sess, ep, layout: ep === 'webgpu' ? layout as GpuLayout : null };
    } catch (e) {
      onLog('Could not start ' + model + ' on ' + name + ': ' + errText(e));
      if (want !== 'auto' && !(ep === 'webgpu' && layout === 'NHWC')) throw e;
    }
  }
  if (gpuWrong && want === 'webgpu') throw new Error('this GPU gives wrong results');
  throw new Error('no backend for ' + model);
}

export const errText = (e: unknown): string => String((e && (e as { message?: string }).message) || e);

// rgba: the frame already scaled to S×S.
export async function detectRGBA(ort: Ort, sess: OrtSession, rgba: ArrayLike<number>): Promise<Corners> {
  const n = S * S, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = rgba[i * 4] / 255; f[n + i] = rgba[i * 4 + 1] / 255; f[2 * n + i] = rgba[i * 4 + 2] / 255; }
  const out = await sess.run({ [sess.inputNames[0]]: tensor(ort, f, [1, 3, S, S]) });
  const hm = out[sess.outputNames[0]].data;
  return corners(hm instanceof Float32Array ? hm : Float32Array.from(hm));
}

// A drawn card with known corners: a GPU that gets it wrong is not trusted.
// Shapes only (no text), so it draws the same on every device.
export function synthCard(): { rgba: Uint8ClampedArray; truth: Pt[] } {
  const c = mkCanvas(S, S);
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const truth: Pt[] = [[0.18, 0.24], [0.84, 0.2], [0.8, 0.74], [0.14, 0.78]];
  g.fillStyle = '#3a3330'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) { g.fillStyle = i % 2 ? '#463d39' : '#2f2926'; g.fillRect((i * 37) % S, (i * 53) % S, 18, 9); }
  g.fillStyle = '#e9eef2'; g.beginPath(); truth.forEach(([x, y], i) => i ? g.lineTo(x * S, y * S) : g.moveTo(x * S, y * S)); g.closePath(); g.fill();
  g.save(); g.clip();
  g.fillStyle = '#9fb7cf'; g.fillRect(0.2 * S, 0.3 * S, 0.6 * S, 0.06 * S);
  g.fillStyle = '#c7a24a'; g.fillRect(0.24 * S, 0.42 * S, 0.1 * S, 0.08 * S);
  g.fillStyle = '#555c66'; g.fillRect(0.6 * S, 0.4 * S, 0.14 * S, 0.22 * S);
  g.fillStyle = '#7d8590'; for (let k = 0; k < 5; k++) g.fillRect(0.38 * S, (0.42 + k * 0.05) * S, 0.18 * S, 0.015 * S);
  g.restore();
  return { rgba: g.getImageData(0, 0, S, S).data, truth };
}

/** The GPU's answer on synthCard: right when every corner is within 4 % of the truth. */
export async function selfTest(ort: Ort, sess: OrtSession): Promise<{ ok: boolean; err: number; conf: number }> {
  const { rgba, truth } = synthCard();
  const r = await detectRGBA(ort, sess, rgba);
  const err = r.pts.some(p => !p) ? 1 : Math.max(...r.pts.map((p, i) => Math.hypot((p as Pt)[0] - truth[i][0], (p as Pt)[1] - truth[i][1])));
  return { ok: err < 0.04, err, conf: r.conf };
}

/** models.json (written by the surface's fetch script): the model version, whether it has a document type
 *  model, a passport zone reader and a Hebrew field reader, and (the site's) each model file's fingerprint. */
export interface ModelsInfo { version: string; doctype: boolean; mrz: boolean; he: boolean; files?: Record<string, string> }

export async function readModels(s: SurfaceRef): Promise<ModelsInfo> {
  const r = await fetch(modelsJsonUrl(s), { cache: 'no-cache' });
  const mj = (r.ok ? await r.json() : {}) as Partial<ModelsInfo>;
  return { version: String(mj.version || ''), doctype: !!mj.doctype, mrz: !!mj.mrz, he: !!mj.he, ...(mj.files ? { files: mj.files } : {}) };
}
