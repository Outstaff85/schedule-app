// The documents on a photo, found on the phone (docs/scan.md → The scan window) — the scanner
// lab's way: the accurate model (the Exact thread, engine.ts) finds the first document's
// corners, then the next ones with the found ones painted over — the accurate model, then the
// light one, as the lab does — then with a margin of the background's colour around the photo,
// then in the widest strips beside the first; each is cut flat and turned upright by the face
// on the phone. A picked page (a form's page, a PDF, a screenshot) is first cut into its photos
// (photosOnPage, the server's functions/docfind.py photos_on_page in TypeScript). It answers in
// the server's shape (FindResult), so the scan window treats both alike; the server finds the
// documents only when the phone cannot (no accurate model on this device).
import { S, type Detection, type Exact, type Pt } from './engine';
import type { FindResult, ServerPage } from './server';

const MAX_DOCS = 4;
const OUT_MAX = 1800; // a page's long side, as the server's
type Live = (rgba: Uint8ClampedArray) => Promise<Detection>;

// ── quads (0..1) ──
function area(q: Pt[]) { let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; }
function convex(q: Pt[]) {
  let sg = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [q[i], q[(i + 1) % 4], q[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z) { if (sg && Math.sign(z) !== sg) return false; sg = Math.sign(z); }
  }
  return true;
}
function inQuad(q: Pt[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; }
  return inside;
}
export function quadIoU(a: Pt[], b: Pt[]) {
  let both = 0, any = 0;
  for (let y = 0.5; y < 64; y++) for (let x = 0.5; x < 64; x++) { const p = inQuad(a, x / 64, y / 64), q = inQuad(b, x / 64, y / 64); both += +(p && q); any += +(p || q); }
  return any ? both / any : 0;
}
/** Sure, convex corners covering over 3 % of the picture: a document. */
export function good(r: Detection | null): Pt[] | null {
  if (!r || r.pts.some(p => !p) || r.conf < 0.5) return null;
  const q = r.pts as Pt[];
  return convex(q) && area(q) > 0.03 ? q : null;
}

// ── pictures ──
function canvas(w: number, h: number) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
/** A region of a picture scaled to S×S RGBA (the models' input). */
function small(src: CanvasImageSource, x = 0, y = 0, w?: number, h?: number): Uint8ClampedArray {
  const c = canvas(S, S), g = c.getContext('2d', { willReadFrequently: true })!;
  const el = src as HTMLCanvasElement;
  g.drawImage(src, x, y, w ?? el.width, h ?? el.height, 0, 0, S, S);
  return g.getImageData(0, 0, S, S).data;
}
/** The median colour of the picture's border (what a found document is painted over with). */
function borderColour(c: HTMLCanvasElement): string {
  const t = canvas(32, 32), g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data, rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < 32; i++) for (const [x, y] of [[i, 0], [i, 31], [0, i], [31, i]]) { const k = (y * 32 + x) * 4; rs.push(d[k]); gs.push(d[k + 1]); bs.push(d[k + 2]); }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return `rgb(${med(rs)},${med(gs)},${med(bs)})`;
}
/** The model on the picture inside a 10 % margin of the background's colour (a document cut by
 * the photo's edge, or already cut to its edges, then lies whole inside); corners back on the picture. */
async function padded(run: (rgba: Uint8ClampedArray) => Promise<Detection | null>, c: HTMLCanvasElement, col: string): Promise<Pt[] | null> {
  const P = Math.round(0.1 * Math.max(c.width, c.height)), pc = canvas(c.width + 2 * P, c.height + 2 * P), g = pc.getContext('2d')!;
  g.fillStyle = col; g.fillRect(0, 0, pc.width, pc.height); g.drawImage(c, P, P);
  const q = good(await run(small(pc)));
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return q && q.map(([x, y]) => [clamp((x * pc.width - P) / c.width), clamp((y * pc.height - P) / c.height)] as Pt);
}

/** The next document's corners, or null: the found ones painted over in the background's colour
 * (the accurate model, then the light one), then the same inside the margin, then the two widest
 * strips left beside the first (the accurate model). A frame overlapping a found one by over
 * 30 % is that one again. */
async function findNext(ex: Exact, live: Live | null, c: HTMLCanvasElement, found: Pt[][]): Promise<Pt[] | null> {
  const w = c.width, h = c.height, fresh = (q: Pt[] | null) => (q && found.every(f => quadIoU(q, f) <= 0.3) ? q : null);
  const col = borderColour(c), painted = canvas(w, h), g = painted.getContext('2d')!;
  g.drawImage(c, 0, 0); g.fillStyle = col;
  for (const q of found) {
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    g.beginPath(); q.forEach(([x, y], i) => { const X = (x + (x - cx) * 0.04) * w, Y = (y + (y - cy) * 0.04) * h; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.closePath(); g.fill();
  }
  const models = [ex.detect, ...(live ? [live] : [])];
  for (const m of models) { const q = fresh(good(await m(small(painted)))); if (q) return q; }
  for (const m of models) { const q = fresh(await padded(m, painted, col)); if (q) return q; }
  const xs = found[0].map(p => p[0]), ys = found[0].map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const strips = ([[0, 0, 1, y0], [0, y1, 1, 1], [0, 0, x0, 1], [x1, 0, 1, 1]] as const)
    .filter(([a, b, c2, d2]) => c2 - a >= 0.25 && d2 - b >= 0.2)
    .sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]));
  for (const [a, b, c2, d2] of strips.slice(0, 2)) {
    const sw = Math.round((c2 - a) * w), sh = Math.round((d2 - b) * h);
    if (sw < 16 || sh < 16) continue;
    const r = good(await ex.detect(small(painted, Math.round(a * w), Math.round(b * h), sw, sh)));
    const q = fresh(r && r.map(([x, y]) => [a + x * (c2 - a), b + y * (d2 - b)] as Pt));
    if (q) return q;
  }
  return null;
}

/** A white page (a form's page, a PDF, a screenshot) cut into its photos, as boxes in pixels;
 * [] for a plain photo. Bands of rows mostly not white, at least 12 % high; in each band every
 * run of columns a quarter of the page wide (two photos side by side are two); a mostly dark
 * run (a screenshot's bar) is not a photo; a picture whose rest is not mostly white is not a
 * white page (a sheet photographed on a table). The server's photos_on_page. */
export function photosOnPage(c: HTMLCanvasElement): number[][] {
  const W = c.width, H = c.height, sc = 300 / Math.max(W, H), w = Math.max(1, Math.round(W * sc)), h = Math.max(1, Math.round(H * sc));
  const t = canvas(w, h), g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, busy = new Uint8Array(w * h), dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    busy[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 225 ? 1 : 0;
    dark[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 60 ? 1 : 0;
  }
  const out: { area: number; box: number[]; at: number[] }[] = [];
  for (let y = 0; y < h;) {
    const row = (yy: number) => { let n = 0; for (let x = 0; x < w; x++) n += busy[yy * w + x]; return n / w > 0.45; };
    if (!row(y)) { y++; continue; }
    const y0 = y; while (y < h && row(y)) y++;
    const y1 = y;
    if (y1 - y0 < 0.12 * h) continue;
    const col = (x: number) => { let n = 0; for (let yy = y0; yy < y1; yy++) n += busy[yy * w + x]; return n / (y1 - y0) > 0.6; };
    for (let x = 0; x < w;) {
      if (!col(x)) { x++; continue; }
      const x0 = x; while (x < w && col(x)) x++;
      if (x - x0 < 0.25 * w) continue;
      let dk = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x; xx++) dk += dark[yy * w + xx];
      if (dk / ((y1 - y0) * (x - x0)) > 0.5) continue;
      out.push({ area: (x - x0) * (y1 - y0) / (w * h), at: [x0, y0, x, y1],
        box: [Math.floor(x0 / sc), Math.floor(y0 / sc), Math.min(W, Math.ceil(x / sc)), Math.min(H, Math.ceil(y1 / sc))] });
    }
  }
  if (!out.length || (out.length === 1 && out[0].area > 0.9)) return [];
  // a white page: what lies outside the photos is mostly white (a sheet on a dark table is not one)
  let rest = 0, restBusy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (out.some(({ at: [x0, y0, x1, y1] }) => x >= x0 && x < x1 && y >= y0 && y < y1)) continue;
    rest++; restBusy += busy[y * w + x] && !dark[y * w + x] ? 1 : 0;
  }
  if (rest && restBusy / rest > 0.12) return [];
  return out.map(o => o.box);
}

/** Whether most (70 %) of the quad (0..1) lies inside the box (pixels of a w×h picture). */
function inside(q: Pt[], [x0, y0, x1, y1]: number[], w: number, h: number) {
  let n = 0, k = 0;
  for (let y = 0.5; y < 64; y++) for (let x = 0.5; x < 64; x++) {
    if (!inQuad(q, x / 64, y / 64)) continue;
    n++; if (x / 64 * w >= x0 && x / 64 * w <= x1 && y / 64 * h >= y0 && y / 64 * h <= y1) k++;
  }
  return n > 0 && k / n >= 0.7;
}

/** A cut page as the server sends it: a JPEG at most OUT_MAX on its long side. */
function jpegOf(data: ArrayBuffer | Uint8ClampedArray, width: number, height: number): string {
  const c = canvas(width, height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data as ArrayBuffer), width, height), 0, 0);
  const s = Math.min(1, OUT_MAX / Math.max(width, height));
  const o = s < 1 ? canvas(Math.round(width * s), Math.round(height * s)) : c;
  if (o !== c) o.getContext('2d')!.drawImage(c, 0, 0, o.width, o.height);
  return o.toDataURL('image/jpeg', 0.9).split(',')[1];
}

/** One page cut by these corners (0..1 of the picture) and turned upright, on the phone. */
export async function cutHere(ex: Exact, c: HTMLCanvasElement, q: Pt[], source: string, box: number[] | null, quad = q): Promise<ServerPage> {
  const out = await ex.warp(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, c.width, c.height, q);
  return {
    quad, box, source, turn: out.turn, blurry: false, imageBase64: jpegOf(out.data, out.width, out.height), mediaType: 'image/jpeg',
    ...(out.doctype ? { doctype: out.doctype, doctypeSure: !!out.doctypeSure } : {}),
  };
}

/** The documents on a picture, found and cut on the phone. hint: the live frame's corners of a
 * camera shot (kept when the accurate model does not confirm its own, as in the lab); none for
 * a picked page, which may be a white page of photos. */
export async function findHere(ex: Exact, live: Live | null, pic: HTMLCanvasElement, hint?: Pt[] | null): Promise<FindResult> {
  let boxes = hint ? [] : photosOnPage(pic);
  if (boxes.length) {
    // a document the model sees on the whole picture outside the photos found: a plain photo after
    // all (a white sheet on a table, a white ספח beside a photo), not a page of photos
    const q = good(await ex.detect(small(pic)));
    if (q && !boxes.some(b => inside(q, b, pic.width, pic.height))) boxes = [];
  }
  const parts = boxes.length
    ? boxes.map(([x0, y0, x1, y1]) => { const c = canvas(x1 - x0, y1 - y0); c.getContext('2d')!.drawImage(pic, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); return { c, box: [x0, y0, x1, y1] as number[] | null }; })
    : [{ c: pic, box: null as number[] | null }];
  const pages: ServerPage[] = [];
  for (const { c, box } of parts) {
    let first = good(await ex.detect(small(c))), source = 'model';
    if (!first && !hint && live) first = good(await live(small(c)));
    if (!first && !hint) first = (await padded(ex.detect, c, borderColour(c))) || (live && await padded(live, c, borderColour(c)));
    if (!first && hint) { first = hint; source = 'phone'; }
    if (!first) { first = [[0, 0], [1, 0], [1, 1], [0, 1]]; source = box ? 'photo' : 'whole'; }
    const found = [first], sources = [source];
    while (found.length < MAX_DOCS) {
      const q = await findNext(ex, live, c, found);
      if (!q) break;
      found.push(q); sources.push('more');
    }
    for (let i = 0; i < found.length; i++) pages.push(await cutHere(ex, c, found[i], sources[i], box));
  }
  return { pages, size: [pic.width, pic.height] };
}
