// The scanner's engine (docs/scan-plan.md → S9): the frames' geometry — the corners picked from the
// corners model's heatmaps, the homography and the perspective warp, the quad checks, a document's shape
// and the back-map of a document found on a document. Ported unchanged from the lab's scan-core.js and
// index.html (tests/scan/engine.test.mjs runs both on the same inputs). corners() is mirrored in
// scripts/scan-train/docfind.py corners (a change in one is made in the other).
import type { Corners, FoundCorners, Pt, Quad, Rgba, Spot } from './types';

/** The models' input side, and their heatmaps' side. */
export const S = 256, H = 128;

// Each of the 4 heatmaps: up to 3 spots (>= 0.3 and at least half its highest), each the centre of the blob
// around it. The four corners are then picked together: with two documents on a picture every heatmap has a
// spot on each, and its highest spots alone can put one corner on one document and three on the other (an
// ID card below its ספח, 2026-10-22). The convex frame with the highest spots wins, a frame whose opposite
// sides differ more than 1.6× counted down (a document seen in perspective rarely has such sides), and one with both
// pairs of sides more than 5° from parallel (mixed of two documents) by cos^4 of the rest. One spot
// on each heatmap: that frame, as before.
export const PEAKS = 3, PEAK_R = 6, BLOB_R = 10, SIDES = 1.6, PAR = 4, FREE = 5 * Math.PI / 180;

/** The spots of the heatmap that starts at off (H×H values), and its highest value. */
export function spotsOf(hm: ArrayLike<number>, off: number): { spots: Spot[]; top: number } {
  const out: Spot[] = [], gone = new Uint8Array(H * H);
  let top = -1;
  for (let i = 0; i < H * H; i++) if (hm[off + i] > top) top = hm[off + i];
  for (let n = 0; n < PEAKS; n++) {
    let mi = -1, mv = -1;
    for (let i = 0; i < H * H; i++) if (!gone[i] && hm[off + i] > mv) { mv = hm[off + i]; mi = i; }
    if (mi < 0 || mv < 0.3 || mv < top * 0.5) break;
    const px = mi % H, py = (mi / H) | 0;
    const seen = new Uint8Array(H * H), q = [mi]; seen[mi] = 1; let sx = 0, sy = 0, sw = 0;
    while (q.length) {
      const i = q.pop()!, x = i % H, y = (i / H) | 0, v = hm[off + i]; sx += x * v; sy += y * v; sw += v;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= H || ny >= H || Math.abs(nx - px) > BLOB_R || Math.abs(ny - py) > BLOB_R) continue;
        const j = ny * H + nx; if (!seen[j] && hm[off + j] >= 0.3) { seen[j] = 1; q.push(j); }
      }
    }
    out.push({ p: [(sx / sw + 0.5) / H, (sy / sw + 0.5) / H], v: mv });
    for (let y = Math.max(0, py - PEAK_R); y <= Math.min(H - 1, py + PEAK_R); y++) for (let x = Math.max(0, px - PEAK_R); x <= Math.min(H - 1, px + PEAK_R); x++) gone[y * H + x] = 1;
  }
  return { spots: out, top };
}

/** A frame of four spots: -1 when it is not convex, else its spots' sum counted down for uneven or unparallel sides. */
export function frameScore(c: Spot[]): number {
  const q = c.map(s => s.p); let sg = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, d] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]], z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (!z || (sg && Math.sign(z) !== sg)) return -1;
    sg = Math.sign(z);
  }
  const len = (i: number) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
  const even = (a: number, b: number) => { const r = Math.max(a, b) / Math.max(1e-6, Math.min(a, b)); return r > SIDES ? (SIDES / r) ** 2 : 1; };
  const ang = (i: number) => Math.atan2(q[(i + 1) % 4][1] - q[i][1], q[(i + 1) % 4][0] - q[i][0]);
  // how far opposite sides are from parallel (they run opposite ways): a page in perspective keeps one pair
  // near parallel; a frame with both pairs off is counted down by cos^4 of the smaller one beyond FREE
  const off = (a: number, b: number) => { const d = Math.abs(ang(a) - ang(b) - Math.PI) % (2 * Math.PI); return Math.min(d, 2 * Math.PI - d); };
  const par = Math.max(0, Math.cos(Math.max(0, Math.min(off(0, 2), off(1, 3)) - FREE))) ** PAR;
  return c.reduce((s, x) => s + x.v, 0) * even(len(0), len(2)) * even(len(1), len(3)) * par;
}

/** The corners model's four heatmaps (4×H×H) → the document's corners (shares) and how sure. */
export function corners(hm: ArrayLike<number>): Corners {
  const all = [0, 1, 2, 3].map(k => spotsOf(hm, k * H * H)), conf0 = Math.min(...all.map(a => a.top));
  if (all.some(a => !a.spots.length)) return { pts: all.map(a => a.spots.length ? a.spots[0].p : null), conf: conf0 };
  let best = all.map(a => a.spots[0]), bestScore = frameScore(best);
  for (const s0 of all[0].spots) for (const s1 of all[1].spots) for (const s2 of all[2].spots) for (const s3 of all[3].spots) {
    const c = [s0, s1, s2, s3], sc = frameScore(c);
    if (sc > bestScore) { best = c; bestScore = sc; }
  }
  return { pts: best.map(s => s.p), conf: Math.min(...best.map(s => s.v)) };
}

/** The homography that takes the four points from onto to: [h0..h7] (h8 = 1). */
export function homography(from: Pt[], to: Pt[]): number[] {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]]; [b[c], b[m]] = [b[m], b[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** Perspective warp of the quad (0..1 coords) of a w×h RGBA frame to a flat rectangle. */
export function warpRGBA(sd: ArrayLike<number>, w: number, h: number, pts: Quad): Rgba {
  const P: Pt[] = pts.map(([x, y]) => [x * w, y * h]);
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const W = Math.round(Math.max(d(P[0], P[1]), d(P[3], P[2]))), Hh = Math.round(Math.max(d(P[0], P[3]), d(P[1], P[2])));
  const Hm = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], P);
  const od = new Uint8ClampedArray(W * Hh * 4);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const z = Hm[6] * x + Hm[7] * y + 1, sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / z, sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / z;
    const ix = sx | 0, iy = sy | 0; if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
    const fx = sx - ix, fy = sy - iy, o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) {
      const i0 = (iy * w + ix) * 4 + c;
      od[o + c] = (sd[i0] * (1 - fx) + sd[i0 + 4] * fx) * (1 - fy) + (sd[i0 + w * 4] * (1 - fx) + sd[i0 + w * 4 + 4] * fx) * fy;
    }
    od[o + 3] = 255;
  }
  return { data: od, width: W, height: Hh };
}

/** The whole picture as a frame (a page taken as it is). */
export const WHOLE_PAGE: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function quadArea(q: Quad): number { let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; }
export function quadConvex(q: Quad): boolean { let sg = 0; for (let i = 0; i < 4; i++) { const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]]; const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); if (z) { if (sg && Math.sign(z) !== sg) return false; sg = Math.sign(z); } } return true; }
export function inQuad(q: Quad, x: number, y: number): boolean { let inside = false; for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
/** How much two frames overlap (on a 64×64 grid): shared over joint. */
export function quadIoU(a: Quad, b: Quad): number { let both = 0, any = 0; for (let y = 0.5; y < 64; y++) for (let x = 0.5; x < 64; x++) { const p = inQuad(a, x / 64, y / 64), q = inQuad(b, x / 64, y / 64); both += +(p && q); any += +(p || q); } return any ? both / any : 0; }
/** Every corner found, sure enough, convex and over 3 % of the picture. */
export const goodQuad = (r: Corners): r is FoundCorners => !r.pts.some(p => !p) && r.conf >= 0.5 && quadConvex(r.pts as Quad) && quadArea(r.pts as Quad) > 0.03;

// A document's shape (in the photo's pixels): every side at least 15 % of the longest and every corner
// between 35° and 145° — a frame with two corners on one point (a triangle) or squeezed to a sliver
// is no document (it would be stretched into a smeared page).
export function docShape(q: Quad, w: number, h: number): boolean {
  const P: Pt[] = q.map(([x, y]) => [x * w, y * h]), side = (i: number) => Math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]);
  const sides = [0, 1, 2, 3].map(side);
  if (Math.min(...sides) < 0.15 * Math.max(...sides)) return false;
  return [0, 1, 2, 3].every(i => {
    const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4], u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const deg = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v))))) * 180 / Math.PI;
    return deg >= 35 && deg <= 145;
  });
}

// A document lying on another (an ID card on its ספח; owner, 2026-10-22): each document found is also cut
// flat (not turned) and looked at on its own — a clearly smaller document of a document's shape on it (3–60 %
// of it) is another page, its corners taken back onto the photo through the cut's homography. One level only.
export const MAX_DOCS = 5, INSIDE_MIN = 0.03, INSIDE_MAX = 0.6;

/** Points in shares of the flat cut of q → shares of the photo (through the cut's homography). */
export function backMap(q: Quad, pts: Quad): Quad {
  const Hm = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
  return pts.map(([u, v]) => { const z = Hm[6] * u + Hm[7] * v + 1; return [(Hm[0] * u + Hm[1] * v + Hm[2]) / z, (Hm[3] * u + Hm[4] * v + Hm[5]) / z] as Pt; });
}

/** The model's answer res on the flat W×H cut of q → the document lying on it (photo shares), or null:
 *  not a document's shape, not 3–60 % of the cut, or a document found already (q itself left out). */
export function insideDoc(res: Corners, W: number, H: number, q: Quad, found: Quad[]): Quad | null {
  if (!goodQuad(res) || !docShape(res.pts, W, H)) return null;
  const a = quadArea(res.pts);
  if (a < INSIDE_MIN || a > INSIDE_MAX) return null;
  const c = backMap(q, res.pts);
  return found.every(f => f === q || quadIoU(c, f) <= 0.3) ? c : null;
}
