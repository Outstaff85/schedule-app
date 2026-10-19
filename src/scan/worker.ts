// The scanner's background thread (engine.ts starts it): runs the document edges model on the
// camera frames, and the warp + upright turn of a shot, so the camera picture and the
// frame on the page never wait. The site's own copy of the scanner lab's
// scan-worker.js; ONNX Runtime comes from /scan/<dir>/ (1.22 for the CPU, 1.30 for the GPU).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BASE, S, detectRGBA, fetchModel, doctypeModelOn, openSession, upright, warpRGBA, withDoctype, type Pt } from './core';

declare const ort: any;
declare function importScripts(...urls: string[]): void;

let live: any = null, face: any = null, doctype: any = null, loaded = '';
const say = (type: string, extra: Record<string, unknown>, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ type, ...extra }, transfer);

self.onmessage = async ({ data: m }: MessageEvent) => {
  try {
    if (m.type === 'load') {
      if (!loaded) { importScripts(BASE + m.ort + '/ort.all.min.js'); ort.env.wasm.wasmPaths = self.location.origin + BASE + m.ort + '/'; loaded = m.ort; }
      ort.env.wasm.numThreads = m.threads;
      const onStatus = (text: string, frac?: number) => say('status', { text, frac }), onLog = (text: string) => say('log', { text });
      const a = await openSession(m.live, m.want, onStatus, onLog);
      live = a.sess;
      if (m.face) face = await ort.InferenceSession.create(await fetchModel('yunet.onnx', () => {}), { executionProviders: ['wasm'] });
      // the document type model (S7) next to the face finder, only when the site's version has one
      if (m.face && await doctypeModelOn()) { try { doctype = await ort.InferenceSession.create(await fetchModel('doctype.onnx', () => {}), { executionProviders: ['wasm'] }); } catch { doctype = null; } }
      say('reply', { id: m.id, ep: a.ep });
    } else if (m.type === 'detect') {
      const t = performance.now();
      let rgba: Uint8ClampedArray;
      if (m.bitmap) { // already S×S: drawn once on a small canvas here
        const c = new OffscreenCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(m.bitmap, 0, 0); m.bitmap.close(); rgba = g.getImageData(0, 0, S, S).data;
      } else rgba = new Uint8ClampedArray(m.rgba);
      const res = await detectRGBA(live, rgba);
      say('reply', { id: m.id, res, ms: performance.now() - t });
    } else if (m.type === 'warp') {
      const out = await withDoctype(m.upright ? doctype : null, await upright(m.upright ? face : null, warpRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, m.pts as Pt[])));
      say('reply', { id: m.id, out: { ...out, data: out.data.buffer } }, [out.data.buffer as ArrayBuffer]);
    }
  } catch (e) { say('reply', { id: m.id, error: String((e as Error)?.message || e) }); }
};
