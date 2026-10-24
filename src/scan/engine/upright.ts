// The scanner's engine (docs/scan-plan.md → S9): a cut page set upright by the face on it — ported unchanged
// from the lab's former plain page (turned, faceScore, faceTurn, uprightRGBA, uprightTurn). YuNet (MIT), run at
// 320×320 BGR 0..255 (scripts/scan-lab/yunet_dyn.py and scripts/scan/yunet_dyn.py free its input size): the
// face found with the eyes above the mouth tells how to turn the shot. On OffscreenCanvas, so it runs in the
// background thread (worker.ts) and in the page alike.
import { tensor, type Ort, type OrtSession } from './ort';
import type { Rgba } from './types';

export const FN = 320;  // a quarter of 640's work, the same turns

/** A picture that can be drawn and has a size (a canvas, an OffscreenCanvas, an ImageBitmap…). */
export type Drawable = CanvasImageSource & { width: number; height: number };

/** A w×h canvas: an OffscreenCanvas, or (a browser without one) a page canvas. */
export function mkCanvas(w: number, h: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const doc = (globalThis as unknown as { document: { createElement(t: 'canvas'): { width: number; height: number } } }).document;
  return Object.assign(doc.createElement('canvas'), { width: w, height: h }) as unknown as OffscreenCanvas;
}
const ctx2d = (c: OffscreenCanvas, read = false): OffscreenCanvasRenderingContext2D =>
  c.getContext('2d', read ? { willReadFrequently: true } : undefined) as OffscreenCanvasRenderingContext2D;

// src turned by k clockwise quarter-turns.
export function turned(src: Drawable, k: number): Drawable {
  if (!k) return src;
  const w = src.width, h = src.height, W = k % 2 ? h : w, H = k % 2 ? w : h, c = mkCanvas(W, H), g = ctx2d(c);
  g.translate(W / 2, H / 2); g.rotate(k * Math.PI / 2); g.drawImage(src, -w / 2, -h / 2); return c;
}

/** How surely the picture shows a face upright: the best face's score × how straight the mouth is below the
 *  eyes (1 when straight below); 0 under a score of 0.5. */
export async function faceScore(ort: Ort, sess: OrtSession, src: Drawable): Promise<number> {
  const s = FN / Math.max(src.width, src.height), c = mkCanvas(FN, FN), g = ctx2d(c, true);
  g.fillStyle = '#000'; g.fillRect(0, 0, FN, FN); g.drawImage(src, 0, 0, Math.round(src.width * s), Math.round(src.height * s));
  const d = g.getImageData(0, 0, FN, FN).data, n = FN * FN, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[i * 4 + 2]; f[n + i] = d[i * 4 + 1]; f[2 * n + i] = d[i * 4]; }
  const out = await sess.run({ input: tensor(ort, f, [1, 3, FN, FN]) });
  let best: { sc: number; p: [number, number][] } | null = null;
  for (const st of [8, 16, 32]) {
    const cols = FN / st, cls = out['cls_' + st].data, obj = out['obj_' + st].data, kps = out['kps_' + st].data;
    for (let i = 0; i < cls.length; i++) {
      const sc = Math.sqrt(Math.min(Math.max(cls[i], 0), 1) * Math.min(Math.max(obj[i], 0), 1));
      if (best && sc <= best.sc) continue;
      const r = Math.floor(i / cols), cc = i % cols;
      best = { sc, p: [0, 1, 2, 3, 4].map(m => [(kps[i * 10 + 2 * m] + cc) * st, (kps[i * 10 + 2 * m + 1] + r) * st] as [number, number]) };
    }
  }
  if (!best || best.sc < 0.5) return 0;
  const [er, el, , mr, ml] = best.p;
  const a = Math.atan2((mr[1] + ml[1]) / 2 - (er[1] + el[1]) / 2, (mr[0] + ml[0]) / 2 - (er[0] + el[0]) / 2);
  return best.sc * Math.max(0, Math.sin(a));  // 1 when the mouth is straight below the eyes
}

// Clockwise quarter-turns that put the document upright; -1 when no face is found.
export async function faceTurn(ort: Ort, sess: OrtSession, src: Drawable): Promise<number> {
  let bk = -1, bs = 0;
  for (let k = 0; k < 4; k++) { const sc = await faceScore(ort, sess, turned(src, k)); if (sc > bs) { bs = sc; bk = k; } }
  return bk;
}

/** A cut page with the turn it was given: the clockwise quarter-turns, -1 with no face (or no face finder),
 *  -2 when the face finder failed (turnError says why). */
export type Upright = Rgba & { turn: number; turnError?: string };

// The straightened shot (RGBA) turned upright when a face shows the way.
// A failing face finder never spoils the shot: it stays as it was cut.
export async function uprightRGBA(ort: Ort | null, faceSess: OrtSession | null, out: Rgba): Promise<Upright> {
  try { return await uprightTurn(ort, faceSess, out); } catch (e) { return Object.assign(out, { turn: -2, turnError: String((e && (e as { message?: string }).message) || e) }); }
}
export async function uprightTurn(ort: Ort | null, faceSess: OrtSession | null, out: Rgba): Promise<Upright> {
  if (!faceSess || !ort) return Object.assign(out, { turn: -1 });
  const c = mkCanvas(out.width, out.height);
  ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(out.data.buffer as ArrayBuffer), out.width, out.height), 0, 0);
  const k = await faceTurn(ort, faceSess, c);
  if (k <= 0) return Object.assign(out, { turn: k });
  const t = turned(c, k) as OffscreenCanvas, d = ctx2d(t).getImageData(0, 0, t.width, t.height);
  return { data: d.data, width: t.width, height: t.height, turn: k };
}
