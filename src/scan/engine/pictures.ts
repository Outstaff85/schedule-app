// The scanner's engine (docs/scan-plan.md → S9): what a picked picture is — a white page with photos in it
// (a form's page, a PDF, a screenshot), or a page made on a computer that is a document already (white to
// its edges). The pixel work is pure (photosOnPagePixels, whiteEdgesPixels, on ImageData-like pixels); the
// canvas scaling is the thin wrappers. Ported unchanged from the lab's former plain page (tests/scan/engine.test.mjs).
import type { PixelsLike } from './types';

/** The photos on a white page are looked for on a copy whose longer side is this. */
export const PHOTOS_SIDE = 300;
/** The edges of a picture are looked at on a copy this wide. */
export const EDGES_W = 200;

/** The size of the copy photosOnPage looks at, for a W×H picture. */
export function photosSize(W: number, H: number): { w: number; h: number; sc: number } {
  const sc = PHOTOS_SIDE / Math.max(W, H);
  return { w: Math.max(1, Math.round(W * sc)), h: Math.max(1, Math.round(H * sc)), sc };
}

// The photos on a white page: every band of rows where most of the page is not white, at least 12 % high;
// inside each, every run of columns mostly not white and a quarter of the page wide gives a photo's sides
// (two documents side by side are two photos). Then the solid blocks the bands miss — an ID card scanned at
// its real size on an A4 page is about 41 % of the page's width, under the bands' 45 % (owner, 2026-11-02):
// what is darker than the page's own paper (SOLID_BELOW under the median of its outer ring, never above
// 225's whiteness), its holes filled (a card's edge closes it), each piece whose box it mostly fills
// (SOLID_FILL) and which is mostly not paper inside (SOLID_INK — a form's framed table is white inside),
// at least 15 % × 10 % of the page and SOLID_MIN of it (a card at its real size on A4 is 41 % × 18 %, 7 % of it; a logo about 1 %; a form's dark heading bar is lower). In reading order; none when the picture is (nearly) one
// photo already. A card as pale as the paper (the new Israeli ID's back) is not found this way: the edges
// model finds it.
export const SOLID_BELOW = 12, SOLID_FILL = 0.85, SOLID_INK = 0.6, SOLID_MIN = 0.02;
type Box = [number, number, number, number];

/** The solid blocks on the small picture (see above): boxes in its pixels. */
export function solidBlocks(d: ArrayLike<number>, w: number, h: number): Box[] {
  const r = Math.max(2, Math.round(0.03 * w)), ring: number[] = [], m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < r || x >= w - r || y < r || y >= h - r) ring.push(m[y * w + x]);
  ring.sort((a, b) => a - b);
  const thr = Math.max(225, ring[ring.length >> 1] - SOLID_BELOW), dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = m[i] < thr ? 1 : 0;
  // the paper reached from the picture's edge (4-neighbours); what it does not reach is a block or its hole
  const paper = new Uint8Array(w * h), stack: number[] = [];
  const seed = (i: number) => { if (!dark[i] && !paper[i]) { paper[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop() as number, x = i % w;
    if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (i >= w) seed(i - w); if (i < w * (h - 1)) seed(i + w);
  }
  const seen = new Uint8Array(w * h), out: Box[] = [];
  for (let s = 0; s < w * h; s++) {
    if (paper[s] || seen[s]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0; seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop() as number, x = i % w, y = (i / w) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) if (j >= 0 && !paper[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 0.15 * w || bh < 0.1 * h || bw * bh < SOLID_MIN * w * h || area / (bw * bh) < SOLID_FILL) continue;
    let ink = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink += dark[y * w + x];
    if (ink / (bw * bh) >= SOLID_INK) out.push([x0, y0, x1 + 1, y1 + 1]);
  }
  return out;
}

/** Side by side (sharing most of their height) left to right, else top to bottom. */
function readingOrder(a: Box, b: Box): number {
  const share = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return share > 0.5 * Math.min(a[3] - a[1], b[3] - b[1]) ? a[0] - b[0] : a[1] - b[1];
}

/** px: the W×H picture scaled to photosSize(W, H) → the photos' boxes [x0, y0, x1, y1] in the picture's pixels. */
export function photosOnPagePixels(px: PixelsLike, W: number, H: number): [number, number, number, number][] {
  const sc = PHOTOS_SIDE / Math.max(W, H), w = px.width, h = px.height, d = px.data;
  const busy = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) busy[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 225 ? 1 : 0;
  const rowShare = (y: number) => { let n = 0; for (let x = 0; x < w; x++) n += busy[y * w + x]; return n / w; };
  const small: Box[] = [];
  for (let y = 0; y < h; y++) {
    if (rowShare(y) <= 0.45) continue;
    const y0 = y; while (y < h && rowShare(y) > 0.45) y++;
    const y1 = y;
    if (y1 - y0 < 0.12 * h) continue;
    const colShare = (x: number) => { let n = 0; for (let yy = y0; yy < y1; yy++) n += busy[yy * w + x]; return n / (y1 - y0); };
    for (let x = 0; x < w; x++) {
      if (colShare(x) <= 0.6) continue;
      const x0 = x; while (x < w && colShare(x) > 0.6) x++;
      if (x - x0 >= 0.25 * w) small.push([x0, y0, x, y1]);
    }
  }
  const meets = (a: Box, b: Box) => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
  for (const b of solidBlocks(d, w, h)) if (!small.some(o => meets(o, b))) small.push(b);
  small.sort(readingOrder);
  const out = small.map(b => ({ area: (b[2] - b[0]) * (b[3] - b[1]) / (w * h), box: [Math.floor(b[0] / sc), Math.floor(b[1] / sc), Math.min(W, Math.ceil(b[2] / sc)), Math.min(H, Math.ceil(b[3] / sc))] as Box }));
  if (!out.length || (out.length === 1 && out[0].area > 0.9)) return [];
  // A white page: what lies outside the photos is mostly white. A photo of documents on a table is
  // not one — its bands would be strips of the table, and the second document would be cut away.
  let rest = 0, restBusy = 0;
  const inBox = (x: number, y: number) => out.some(({ box: [x0, y0, x1, y1] }) => x >= x0 * sc && x < x1 * sc && y >= y0 * sc && y < y1 * sc);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inBox(x, y)) continue;
    const k = (y * w + x) * 4; rest++;
    if (busy[y * w + x] && Math.max(d[k], d[k + 1], d[k + 2]) >= 60) restBusy++;
  }
  return rest && restBusy / rest > 0.12 ? [] : out.map(o => o.box);
}

// A PDF page made on a computer (a form, an invoice, a certificate: no photos in it, white to its edges) is
// a document already: taken whole, as it is.
/** px: the picture scaled to EDGES_W wide → its outer 3 % is (nearly) all white. */
export function whiteEdgesPixels(px: PixelsLike): boolean {
  const W = px.width, H = px.height, d = px.data, m = Math.max(2, Math.round(0.03 * W));
  let n = 0, white = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= m && x < W - m && y >= m && y < H - m) continue;
    const k = (y * W + x) * 4; n++;
    if (Math.min(d[k], d[k + 1], d[k + 2]) >= 235) white++;
  }
  return !!n && white / n >= 0.97;
}

function scaled(img: HTMLImageElement, w: number, h: number): ImageData {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

/** The photos on a loaded picture (boxes in its pixels); [] when it is no white page with photos. */
export function photosOnPage(img: HTMLImageElement): [number, number, number, number][] {
  const W = img.naturalWidth, H = img.naturalHeight, { w, h } = photosSize(W, H);
  return photosOnPagePixels(scaled(img, w, h), W, H);
}

/** A loaded picture is white to its edges. */
export function whiteEdges(img: HTMLImageElement): boolean {
  return whiteEdgesPixels(scaled(img, EDGES_W, Math.max(1, Math.round(EDGES_W * img.naturalHeight / img.naturalWidth))));
}
