// The scanner lab's resampling probe (Lab tools → Settings; docs/scan-training.md → "The phone mirror"): each fixed
// frame of `python -m gen profile --frames DIR` through this browser's own paths — the camera frame scaled on the GPU
// (createImageBitmap 'low', as Live.frameInput and the engine's rgbaOf do), smallRGBA (live.ts), the document type
// square (Readers.doctypeAnswer), the face finder's letterbox (faceScore, upright.ts), the Hebrew field lines
// (Readers.heLine) and the zone's lines (mrzFind / Readers.mrzRead) — with stand-in model sessions that only keep the
// tensor each is given (no model runs; the scan's own readers are never touched), and the first frames' cut of a
// fixed quad (warpRGBA, geometry.ts). probe.json (the user agent recorded) is what `python -m gen profile --from
// probe.json` measures gen/phone.py's kernels against. The browser check (tests/e2e/phone-parity.test.js) runs these
// very functions.
import { S, warpRGBA } from '../engine/geometry';
import { smallRGBA } from '../engine/live';
import type { Ort, OrtSession, OrtTensor } from '../engine/ort';
import { grayPixels, mrzFind, mrzTop, Readers, type HeBox, type PxBox } from '../engine/readers';
import type { SurfaceRef } from '../engine/surface';
import { faceScore, mkCanvas } from '../engine/upright';
import type { Quad } from '../engine/types';

/** A frame of the probe: a canvas with its pixels (a page canvas or an OffscreenCanvas). */
export type ProbeFrame = HTMLCanvasElement | OffscreenCanvas;
/** One path's output as probe.json keeps it. */
export interface ProbePath { shape: number[]; dtype: 'uint8' | 'float32'; b64: string; box?: PxBox | Quad }
export interface Probe { browser: string; userAgent: string; at: string; frames: { name: string; paths: Record<string, ProbePath> }[] }

const ortStub: Ort = {
  env: { wasm: {} },
  InferenceSession: { create: () => Promise.reject(new Error('the probe runs no model')) },
  Tensor: class { constructor(readonly type: 'float32', readonly data: Float32Array, readonly dims: readonly number[]) {} },
};
const ctx2d = (c: ProbeFrame) => c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Bytes as base64. */
export function probeB64(a: ArrayBufferView): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** The camera frame for the live model as the scan gives it (Live.frameInput + the engine's rgbaOf): S×S scaled on
 *  the GPU with createImageBitmap 'low', read back through an S×S canvas; null where createImageBitmap is not. */
async function liveInput(frame: ProbeFrame): Promise<Uint8ClampedArray | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const bm = await createImageBitmap(frame, { resizeWidth: S, resizeHeight: S, resizeQuality: 'low' });
  const c = mkCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  g.drawImage(bm, 0, 0); bm.close();
  return g.getImageData(0, 0, S, S).data;
}

/** One frame through every path (heBoxes: the Hebrew field boxes to read; quad: the cut to make, or null). */
export async function probeFrame(frame: ProbeFrame, heBoxes: HeBox[], quad: Quad | null): Promise<Record<string, ProbePath>> {
  const w = frame.width, h = frame.height, out: Record<string, ProbePath> = {};
  let kept: OrtTensor['data'][] = [];
  const stub = (outs: Record<string, unknown>): OrtSession => ({
    inputNames: ['img'], outputNames: ['out'], release: async () => {},
    run: async feeds => { kept.push(Object.values(feeds)[0].data); return outs as Record<string, OrtTensor>; },
  });
  const doctype = stub({ doctype: { data: [1, 0, 0, 0, 0, 0] }, turn: { data: [1, 0, 0, 0] } });
  const he = stub({ out: { dims: [1, 1, 48], data: new Float32Array(48) } }), mrz = stub({ out: { dims: [1, 1, 38], data: new Float32Array(38) } });
  const face = stub(Object.fromEntries([8, 16, 32].flatMap(s => [['cls_' + s, { data: [] }], ['obj_' + s, { data: [] }], ['kps_' + s, { data: [] }]])));
  const readers = new Readers({ base: '/scan-lab/', cache: 'scan-lab-models' } as SurfaceRef).use(ortStub, { doctype, mrz, he });
  const put = (p: string, a: ArrayLike<number> | undefined, shape: number[], dtype: ProbePath['dtype'], box?: ProbePath['box']) => {
    if (!a) return;
    out[p] = { shape, dtype, b64: probeB64(a as unknown as ArrayBufferView), ...(box ? { box } : {}) };
  };
  put('live', (await liveInput(frame)) || undefined, [S, S, 4], 'uint8');
  put('capture', smallRGBA(frame, w, h), [S, S, 4], 'uint8');
  kept = []; await readers.doctypeAnswer(frame); put('doctype', kept[0], [3, 256, 256], 'float32');
  kept = []; await faceScore(ortStub, face, frame); put('face', kept[0], [3, 320, 320], 'float32');
  for (let i = 0; i < heBoxes.length; i++) { kept = []; await readers.heLine(frame, heBoxes[i]); if (kept.length) put('he:' + i, kept[0], [1, 32, 512], 'float32'); }
  const top = mrzTop(h);
  const boxes = w < 50 || h - top < 20 ? [] : mrzFind(grayPixels(ctx2d(frame).getImageData(0, top, w, h - top)), w, h);
  kept = []; await readers.mrzRead(frame as OffscreenCanvas);
  boxes.forEach((b, i) => put('mrz:' + i, kept[i], [1, 32, 512], 'float32', b));
  if (quad) {   // the scanner's cut of the frame's quad (warpRGBA on the frame's pixels)
    const c = warpRGBA(ctx2d(frame).getImageData(0, 0, w, h).data, w, h, quad);
    put('cut', c.data, [c.height, c.width, 4], 'uint8', quad);
  }
  return out;
}

/** files: frames.json and its PNG frames (picked in Lab tools) → probe.json, saved; also returned (null when a file
 *  is missing — said through status). */
export async function runProbe(files: File[], status: (text: string) => void): Promise<Probe | null> {
  const byName = new Map(files.map(f => [f.name, f]));
  const meta = byName.get('frames.json');
  if (!meta) { status('Probe: pick frames.json with the frames (python -m gen profile --frames DIR)'); return null; }
  const { frames, heBoxes, cutQuads } = JSON.parse(await meta.text()) as { frames: string[]; heBoxes?: HeBox[]; cutQuads?: (Quad | null)[] };
  const missing = frames.filter(n => !byName.has(n));
  if (missing.length) { status('Probe: ' + missing.length + ' frame(s) of frames.json not picked (' + missing.slice(0, 3).join(', ') + ')'); return null; }
  const probe: Probe = { browser: navigator.userAgent, userAgent: navigator.userAgent, at: new Date().toISOString(), frames: [] };
  for (const [n, name] of frames.entries()) {
    const url = URL.createObjectURL(byName.get(name) as File), img = new Image();
    img.src = url; await img.decode(); URL.revokeObjectURL(url);
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    (c.getContext('2d') as CanvasRenderingContext2D).drawImage(img, 0, 0);
    probe.frames.push({ name, paths: await probeFrame(c, heBoxes || [], (cutQuads || [])[n] || null) });
    status('Probe: frame ' + (n + 1) + ' of ' + frames.length);
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(probe)], { type: 'application/json' })); a.download = 'probe.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  status('Probe: probe.json saved (' + frames.length + ' frames) — python -m gen profile --from probe.json --frames DIR');
  return probe;
}
