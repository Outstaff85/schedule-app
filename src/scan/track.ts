// Keeps the frame on the document on every camera frame between the model's
// answers: a few textured points inside the document are followed from frame to
// frame (pyramidal Lucas–Kanade on a small gray copy, checked forward and back),
// and the affine motion they agree on moves the frame. A model answer that comes
// back late is carried forward by the motion seen since its frame was taken.
// The site's own copy of the scanner lab's track.js.
import type { Pt } from './core';

export type TrackStep = { pts: Pt[]; apply: (q: Pt[]) => Pt[]; moved: number; points: number };
export type Tracker = {
  reset(): void;
  step(video: HTMLVideoElement, quad: Pt[]): Promise<TrackStep | null>;
  since(t0: number, pts: Pt[]): Pt[];
};

type Level = { img: Float32Array; w: number; h: number };
type Affine = number[];

const TW = 320, LEVELS = 3, R = 4, KEEP_MS = 2000;

function pyramid(img: Float32Array, w: number, h: number): Level[] {
  const p: Level[] = [{ img, w, h }];
  for (let l = 1; l < LEVELS; l++) {
    const a = p[l - 1], nw = a.w >> 1, nh = a.h >> 1, o = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * a.w + 2 * x; o[y * nw + x] = (a.img[i] + a.img[i + 1] + a.img[i + a.w] + a.img[i + a.w + 1]) / 4;
    }
    p.push({ img: o, w: nw, h: nh });
  }
  return p;
}
function at(L: Level, x: number, y: number): number {
  x = Math.min(Math.max(x, 0), L.w - 1.001); y = Math.min(Math.max(y, 0), L.h - 1.001);
  const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, i = iy * L.w + ix;
  return (L.img[i] * (1 - fx) + L.img[i + 1] * fx) * (1 - fy) + (L.img[i + L.w] * (1 - fx) + L.img[i + L.w + 1] * fx) * fy;
}
// How textured the window at (x, y) is: the smaller eigenvalue of its gradient matrix.
function texture(L: Level, x: number, y: number): number {
  let a = 0, b = 0, c = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const ix = (at(L, x + dx + 1, y + dy) - at(L, x + dx - 1, y + dy)) / 2, iy = (at(L, x + dx, y + dy + 1) - at(L, x + dx, y + dy - 1)) / 2;
    a += ix * ix; b += ix * iy; c += iy * iy;
  }
  return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
}
// (x, y) at level 0 of P0 → where it is in P1, or null.
function follow(P0: Level[], P1: Level[], x: number, y: number): Pt | null {
  let dX = 0, dY = 0;
  for (let l = P0.length - 1; l >= 0; l--) {
    const A = P0[l], B = P1[l], s = 1 << l, px = x / s, py = y / s;
    let Gxx = 0, Gxy = 0, Gyy = 0; const Ix: number[] = [], Iy: number[] = [], I0: number[] = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const ix = (at(A, px + dx + 1, py + dy) - at(A, px + dx - 1, py + dy)) / 2, iy = (at(A, px + dx, py + dy + 1) - at(A, px + dx, py + dy - 1)) / 2;
      Ix.push(ix); Iy.push(iy); I0.push(at(A, px + dx, py + dy)); Gxx += ix * ix; Gxy += ix * iy; Gyy += iy * iy;
    }
    const det = Gxx * Gyy - Gxy * Gxy;
    if (det < 1e-2) return null;
    for (let it = 0; it < 6; it++) {
      let bx = 0, by = 0, k = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++, k++) {
        const e = I0[k] - at(B, px + dx + dX, py + dy + dY); bx += e * Ix[k]; by += e * Iy[k];
      }
      const ux = (Gyy * bx - Gxy * by) / det, uy = (Gxx * by - Gxy * bx) / det;
      dX += ux; dY += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
    if (l > 0) { dX *= 2; dY *= 2; }
  }
  return [x + dX, y + dY];
}
function solve3(M: number[][], v: number[]): number[] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]];
  return inv.map(r => (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / det);
}
// Least-squares affine map from points a to points b (pixels), one outlier pass.
function affine(a: Pt[], b: Pt[]): Affine | null {
  const fit = (idx: number[]) => {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], vx = [0, 0, 0], vy = [0, 0, 0];
    for (const i of idx) {
      const r = [a[i][0], a[i][1], 1];
      for (let j = 0; j < 3; j++) { for (let k = 0; k < 3; k++) M[j][k] += r[j] * r[k]; vx[j] += r[j] * b[i][0]; vy[j] += r[j] * b[i][1]; }
    }
    const sx = solve3(M, vx), sy = solve3(M, vy);
    return sx && sy ? [...sx, ...sy] : null;
  };
  let idx = a.map((_, i) => i);
  if (idx.length < 4) return null;
  let A = fit(idx); if (!A) return null;
  const res = idx.map(i => Math.hypot(A![0] * a[i][0] + A![1] * a[i][1] + A![2] - b[i][0], A![3] * a[i][0] + A![4] * a[i][1] + A![5] - b[i][1]));
  const med = res.slice().sort((p, q) => p - q)[res.length >> 1];
  idx = idx.filter((_, k) => res[k] <= Math.max(1.5, 2.5 * med));
  if (idx.length >= 4) A = fit(idx) || A;
  return A;
}
// Points (0..1) moved by an affine map in pixels of a w×h frame.
const apply = (A: Affine, pts: Pt[], w: number, h: number): Pt[] => pts.map(([x, y]) => [(A[0] * x * w + A[1] * y * h + A[2]) / w, (A[3] * x * w + A[4] * y * h + A[5]) / h]);

function createTracker(): Tracker {
  let canvas: HTMLCanvasElement | null = null, ctx: CanvasRenderingContext2D | null = null, prev: Level[] | null = null;
  let hist: { t: number; A: Affine; w: number; h: number }[] = [];
  let gpuScale = typeof createImageBitmap === 'function';
  async function grayFrame(video: HTMLVideoElement): Promise<Level[] | null> {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const w = TW, h = Math.round(TW * vh / vw);
    if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; prev = null; }
    // Scaled on the GPU first, so no full-size frame is copied into the page.
    let src: CanvasImageSource = video;
    if (gpuScale) {
      try { src = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }); }
      catch (e) { if ((e as Error)?.name !== 'InvalidStateError') gpuScale = false; return null; }
    }
    ctx!.drawImage(src, 0, 0, w, h); if (src !== video) (src as ImageBitmap).close();
    const d = ctx!.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    return pyramid(g, w, h);
  }
  return {
    reset() { prev = null; hist = []; },
    // One camera frame: the quad moved by the motion since the last frame (moved: how
    // far its corners went, 0..1), or null when it cannot tell.
    async step(video, quad) {
      const now = performance.now(), P = await grayFrame(video);
      if (!P) return null;
      const P0 = prev; prev = P;
      if (!P0 || !quad) return null;
      const w = P[0].w, h = P[0].h, cand: [number, number, number][] = [];
      // Candidates on a 6×6 grid inside the document, the 16 most textured kept.
      for (let v = 1; v <= 6; v++) for (let u = 1; u <= 6; u++) {
        const s = u / 7, t = v / 7, top = [quad[0][0] + (quad[1][0] - quad[0][0]) * s, quad[0][1] + (quad[1][1] - quad[0][1]) * s];
        const bot = [quad[3][0] + (quad[2][0] - quad[3][0]) * s, quad[3][1] + (quad[2][1] - quad[3][1]) * s];
        const x = (top[0] + (bot[0] - top[0]) * t) * w, y = (top[1] + (bot[1] - top[1]) * t) * h;
        if (x > R + 2 && y > R + 2 && x < w - R - 3 && y < h - R - 3) cand.push([x, y, texture(P0[0], x, y)]);
      }
      cand.sort((p, q) => q[2] - p[2]);
      const a: Pt[] = [], b: Pt[] = [];
      for (const [x, y, sc] of cand.slice(0, 16)) {
        if (sc < 20) break;
        const f = follow(P0, P, x, y); if (!f) continue;
        const back = follow(P, P0, f[0], f[1]); // forward and back must meet
        if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) continue;
        a.push([x, y]); b.push(f);
      }
      const A = affine(a, b);
      if (!A) return null;
      hist.push({ t: now, A, w, h }); while (hist.length && now - hist[0].t > KEEP_MS) hist.shift();
      const pts = apply(A, quad, w, h);
      return { pts, apply: q => apply(A, q, w, h), moved: Math.max(...pts.map((p, i) => Math.hypot(p[0] - quad[i][0], p[1] - quad[i][1]))), points: a.length };
    },
    // A model answer for the frame taken at time t0, carried to now.
    since(t0, pts) { for (const s of hist) if (s.t > t0) pts = apply(s.A, pts, s.w, s.h); return pts; },
  };
}

let tracker: Tracker | null = null;
/** The page's one tracker (kept the same shape as before: a promise). */
export function loadTracker(): Promise<Tracker> {
  if (!tracker) tracker = createTracker();
  return Promise.resolve(tracker);
}
