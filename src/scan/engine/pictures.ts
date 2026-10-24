// The scanner's engine (docs/scan-plan.md → S9): what a picked picture is — a white page with photos in it
// (a form's page, a PDF, a screenshot), or a page made on a computer that is a document already (white to
// its edges). The pixel work is pure (photosOnPagePixels, whiteEdgesPixels, on ImageData-like pixels); the
// canvas scaling is the thin wrappers. Ported unchanged from the lab's index.html (tests/scan/engine.test.mjs).
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
// inside each, the longest run of columns mostly not white gives its sides. Top to bottom; none when the
// picture is (nearly) one photo already.
/** px: the W×H picture scaled to photosSize(W, H) → the photos' boxes [x0, y0, x1, y1] in the picture's pixels. */
export function photosOnPagePixels(px: PixelsLike, W: number, H: number): [number, number, number, number][] {
  const sc = PHOTOS_SIDE / Math.max(W, H), w = px.width, h = px.height, d = px.data;
  const busy = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) busy[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 225 ? 1 : 0;
  const rowShare = (y: number) => { let n = 0; for (let x = 0; x < w; x++) n += busy[y * w + x]; return n / w; };
  const out: { area: number; box: [number, number, number, number] }[] = [];
  for (let y = 0; y < h; y++) {
    if (rowShare(y) <= 0.45) continue;
    const y0 = y; while (y < h && rowShare(y) > 0.45) y++;
    const y1 = y;
    if (y1 - y0 < 0.12 * h) continue;
    const colShare = (x: number) => { let n = 0; for (let yy = y0; yy < y1; yy++) n += busy[yy * w + x]; return n / (y1 - y0); };
    let run: [number, number] | null = null;
    for (let x = 0; x < w; x++) {
      if (colShare(x) <= 0.6) continue;
      const x0 = x; while (x < w && colShare(x) > 0.6) x++;
      if (!run || x - x0 > run[1] - run[0]) run = [x0, x];
    }
    if (!run || run[1] - run[0] < 0.25 * w) continue;
    out.push({ area: (run[1] - run[0]) * (y1 - y0) / (w * h), box: [Math.floor(run[0] / sc), Math.floor(y0 / sc), Math.min(W, Math.ceil(run[1] / sc)), Math.min(H, Math.ceil(y1 / sc))] });
  }
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
