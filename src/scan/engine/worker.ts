// The scanner's engine (docs/scan-plan.md → S9): the background thread — runs the models and the warp, so the
// camera picture and the frame on the page never wait. A module worker built by Vite (engines.ts starts it
// with new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })); ported from the lab's
// former worker with the same messages: 'load' (now also the surface's base and cache and the ONNX Runtime
// build to load), 'detect' (an S×S bitmap or its RGBA) and 'warp' (with the upright turn); it answers with
// 'status', 'log' and 'reply' (the call's id, or its error). Uses no DOM: it type-checks under the WebWorker
// lib too.
import { S, warpRGBA } from './geometry';
import { cpuSession, detectRGBA, downloadProgress, fetchModel, openSession, errText, type Want } from './models';
import { loadOrt, type GpuLayout, type Ort, type OrtSession } from './ort';
import type { EngineStatus } from './status';
import type { OrtDir, SurfaceRef } from './surface';
import { uprightRGBA } from './upright';
import type { Quad } from './types';

/** The messages the page sends. */
export type WorkerIn =
  | { type: 'load'; id: number; surface: SurfaceRef; ort: OrtDir; live: string; cap: string | null; want: Want; threads: number; face: boolean; layout: string | null;
      /** each model file's stamp from models.json (models.ts modelStamp): its kept copy is used with no request while it matches */
      stamps?: Record<string, string> | null }
  | { type: 'detect'; id: number; which: 'live' | 'cap'; bitmap?: ImageBitmap; rgba?: ArrayBuffer }
  | { type: 'warp'; id: number; rgba: ArrayBuffer; w: number; h: number; pts: Quad; upright: boolean };

/** The messages the thread sends back. */
export type WorkerOut =
  | { type: 'status'; status: EngineStatus; frac?: number }
  | { type: 'log'; text: string }
  | { type: 'reply'; id: number; error?: string; [k: string]: unknown };

interface Scope {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
}
const scope = self as unknown as Scope;

let ort: Ort | null = null, live: OrtSession | null = null, cap: OrtSession | null = null, face: OrtSession | null = null;
const say = (m: WorkerOut, transfer?: Transferable[]) => scope.postMessage(m, transfer || []);

scope.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      const onStatus = (status: EngineStatus, frac?: number) => say({ type: 'status', status, frac }), onLog = (text: string) => say({ type: 'log', text });
      const stamp = (name: string): string | null => (m.stamps && m.stamps[name]) || null;
      // ONNX Runtime's load, the first model's file and the face finder's (0.2 MB) at once — files only, no
      // session: the sessions still start one after the other, the second model's file is fetched after the
      // first model's session (one heavy model in memory at a time)
      const firstBytes = fetchModel(m.surface, m.live, downloadProgress(m.live, onStatus), { stamp: stamp(m.live), said: onLog });
      const faceBytes = m.face ? fetchModel(m.surface, 'yunet.onnx', () => {}, { stamp: stamp('yunet.onnx'), said: onLog }) : null;
      firstBytes.catch(() => {}); if (faceBytes) faceBytes.catch(() => {});  // their failure is the session's, below
      let t0 = performance.now();
      ort = await loadOrt(m.surface, m.ort, m.threads);
      onLog('Time: ONNX Runtime (' + m.ort + ') loaded for ' + m.live + ' — ' + Math.round(performance.now() - t0) + ' ms');
      const a = await openSession(ort, m.surface, m.live, m.want, onStatus, onLog, m.layout, { bytes: firstBytes, time: onLog });
      live = a.sess;
      const b = m.cap ? await openSession(ort, m.surface, m.cap, m.want, onStatus, onLog, m.layout, { stamp: stamp(m.cap), time: onLog }) : a; cap = b.sess;
      if (m.face && faceBytes) {
        onStatus({ key: 'face' }, 1); t0 = performance.now();
        face = await cpuSession(ort, m.surface, 'yunet.onnx', faceBytes);
        onLog('Time: face finder ready — ' + Math.round(performance.now() - t0) + ' ms');
      }
      const layout: GpuLayout | null = a.layout || b.layout;
      say({ type: 'reply', id: m.id, ep: a.ep + (b.ep !== a.ep ? '/' + b.ep : ''), layout });
    } else if (m.type === 'detect') {
      if (!ort || !live || !cap) throw new Error('the model is not loaded');
      const t = performance.now();
      let rgba: Uint8ClampedArray;
      if (m.bitmap) {  // already S×S: drawn once on a small canvas here
        const c = new OffscreenCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
        g.drawImage(m.bitmap, 0, 0); m.bitmap.close(); rgba = g.getImageData(0, 0, S, S).data;
      } else rgba = new Uint8ClampedArray(m.rgba as ArrayBuffer);
      const res = await detectRGBA(ort, m.which === 'cap' ? cap : live, rgba);
      say({ type: 'reply', id: m.id, res, ms: performance.now() - t });
    } else if (m.type === 'warp') {
      const out = await uprightRGBA(ort, m.upright ? face : null, warpRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, m.pts));
      say({ type: 'reply', id: m.id, out }, [out.data.buffer as ArrayBuffer]);
    }
  } catch (e) { say({ type: 'reply', id: m.id, error: errText(e) }); }
};
