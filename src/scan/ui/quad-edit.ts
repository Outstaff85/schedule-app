// The corner editor's geometry (docs/scan.md → The corner editor), pure and drawn nowhere: which handle a press
// picks up — a corner, a side's middle bar, or a side's line —, a corner or a whole side moved and kept on the
// photo, and the 3×3 grid drawn inside the quad. The points are shares of the photo (0…1); iw×ih is the photo's
// size on the screen in px, so the pick radii are screen px whatever the photo's shape. Side i runs from corner
// i to corner (i + 1) % 4. Checked by tests/scan/quad-edit.test.mjs.
import type { Pt, Quad } from '../engine/types';

/** The pick radius (px on the screen) of a corner and of a side's middle bar. */
export const PICK_RADIUS = 48;
/** How near (px on the screen) a press must be to a side's line to take the side. */
export const LINE_RADIUS = 24;

/** What a press holds: a corner, a side (its middle bar or its line), or nothing. */
export type Grab = { kind: 'corner' | 'side'; i: number } | null;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The corners as Apply gives them: rounded to 5 decimals. */
export const roundCorners = (pts: Quad): Quad => pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)] as Pt);

/** The middle of side i. */
export const sideMid = (pts: Quad, i: number): Pt => {
  const a = pts[i], b = pts[(i + 1) % 4];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

/** The corner within PICK_RADIUS px of (x, y) — the nearest —, -1 when none. */
export function pickCorner(pts: Quad, x: number, y: number, iw: number, ih: number): number {
  let best = 1e9, at = -1;
  pts.forEach(([px, py], i) => { const d = Math.hypot((px - x) * iw, (py - y) * ih); if (d < best && d < PICK_RADIUS) { best = d; at = i; } });
  return at;
}

/** The distance in px from (x, y) to side i's segment. */
export function sideDistance(pts: Quad, i: number, x: number, y: number, iw: number, ih: number): number {
  const a = pts[i], b = pts[(i + 1) % 4];
  const ax = a[0] * iw, ay = a[1] * ih, bx = b[0] * iw, by = b[1] * ih, px = x * iw, py = y * ih;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** What a press at (x, y) picks up: the nearest corner or side's middle bar within PICK_RADIUS px (a corner wins
 *  a tie), else the nearest side whose line is within LINE_RADIUS px, else nothing. */
export function pickHandle(pts: Quad, x: number, y: number, iw: number, ih: number): Grab {
  let best = PICK_RADIUS, grab: Grab = null;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot((pts[i][0] - x) * iw, (pts[i][1] - y) * ih);
    if (d < best) { best = d; grab = { kind: 'corner', i }; }
  }
  for (let i = 0; i < 4; i++) {
    const m = sideMid(pts, i), d = Math.hypot((m[0] - x) * iw, (m[1] - y) * ih);
    if (d < best) { best = d; grab = { kind: 'side', i }; }
  }
  if (grab) return grab;
  best = LINE_RADIUS;
  for (let i = 0; i < 4; i++) {
    const d = sideDistance(pts, i, x, y, iw, ih);
    if (d < best) { best = d; grab = { kind: 'side', i }; }
  }
  return grab;
}

/** A corner set to (x, y), kept on the photo. */
export function moveCorner(pts: Quad, i: number, x: number, y: number): Quad {
  const out = pts.map(p => p.slice() as Pt) as Quad;
  out[i] = [clamp01(x), clamp01(y)];
  return out;
}

/** Side i of the quad `from` moved by the pointer's move (dx, dy, in shares) along the side's normal (on the
 *  screen, so a slant photo shape does not bend it): both its corners go the same way the same distance, the
 *  move cut short where either corner would leave the photo (so the side keeps its direction). */
export function moveSide(from: Quad, i: number, dx: number, dy: number, iw: number, ih: number): Quad {
  const j = (i + 1) % 4, a = from[i], b = from[j];
  const sx = (b[0] - a[0]) * iw, sy = (b[1] - a[1]) * ih, len = Math.hypot(sx, sy);
  const out = from.map(p => p.slice() as Pt) as Quad;
  if (!len) return out;
  const nx = -sy / len, ny = sx / len;                  // the side's normal, px
  let t = dx * iw * nx + dy * ih * ny;                  // the pointer's move along it, px
  const mx = nx / iw, my = ny / ih;                     // a px of t in shares
  for (const p of [a, b]) for (const [v, m] of [[p[0], mx], [p[1], my]] as const) {
    if (m > 0) t = Math.min(Math.max(t, -v / m), (1 - v) / m);
    else if (m < 0) t = Math.min(Math.max(t, (1 - v) / m), -v / m);
  }
  out[i] = [clamp01(a[0] + mx * t), clamp01(a[1] + my * t)];
  out[j] = [clamp01(b[0] + mx * t), clamp01(b[1] + my * t)];
  return out;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** The 3×3 grid's four inner lines inside the quad (corners 0 top-left, 1 top-right, 2 bottom-right, 3
 *  bottom-left): the lines at a third and two thirds across, then down, each a pair of points on opposite sides. */
export function gridLines(pts: Quad): [Pt, Pt][] {
  const [p0, p1, p2, p3] = pts, out: [Pt, Pt][] = [];
  for (const t of [1 / 3, 2 / 3]) out.push([lerp(p0, p1, t), lerp(p3, p2, t)]);
  for (const t of [1 / 3, 2 / 3]) out.push([lerp(p0, p3, t), lerp(p1, p2, t)]);
  return out;
}
