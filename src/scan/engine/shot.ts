// The scanner's engine (docs/scan-plan.md → S9): the shot and the other documents on it — ported unchanged from
// the lab's index.html (takeShot, findNext, findInside, toCanvas):
//  - the frame is frozen and cut at once by the live frame's corners (the page is out in a few ms), set upright
//    by the face; the document type, the passport zone and the Hebrew fields are read on it;
//  - once the live frames still in work are done, the accurate model refines the corners; when they moved over
//    0.002 the page is cut again and replaces the first under the same page id, and is read again on that cut;
//  - more documents on the same photo, up to 4 in all (findNext): every one found painted over in the colour of
//    the photo's border, looked for by the accurate model then the light one, then the same with a 10 % margin
//    of that colour around the photo (a document cut off by the photo's edge lies whole inside), then in the two
//    widest strips left beside the first; a frame overlapping a found one by over 30 % is that one again;
//  - then a document lying on one found (an ID card on its ספח, findInside), up to MAX_DOCS in all, one level.
// Every page is given the moment it is cut (and again when refined), so the screen can show, delete or fix it
// at once. A newer shot (or the scanner put away) drops the work of an older one (the shot id).
import { MAX_DOCS, docShape, goodQuad, insideDoc, quadIoU } from './geometry';
import type { LoadableEngine } from './engines';
import { smallRGBA, type Live } from './live';
import { mrzZone, type DoctypeAnswer, type HeRead, type Readers } from './readers';
import type { SessionStatus } from './status';
import { mkCanvas, type Upright } from './upright';
import type { VideoLike } from './camera';
import type { Pt, Quad, Rgba } from './types';

type Ctx2D = OffscreenCanvasRenderingContext2D;
const ctx = (c: OffscreenCanvas, read = false): Ctx2D => c.getContext('2d', read ? { willReadFrequently: true } : undefined) as Ctx2D;
const copy = (q: Quad): Quad => q.map(p => p.slice() as Pt);
const errText = (e: unknown): string => String((e as Error)?.message || e);

/** A warped picture on a canvas (the lab's toCanvas). Its pixels are taken as they are, not copied: the model's
 *  thread handed the buffer over, nothing else holds it. */
export function toCanvas(out: Rgba): OffscreenCanvas {
  const c = mkCanvas(out.width, out.height);
  const d = out.data.buffer instanceof ArrayBuffer ? out.data as Uint8ClampedArray<ArrayBuffer> : new Uint8ClampedArray(out.data);
  ctx(c).putImageData(new ImageData(d, out.width, out.height), 0, 0);
  return c;
}

/** A cut page's size and turn — its pixels live once, on its canvas (as the lab kept only the canvas). */
export type PageInfo = Omit<Upright, 'data'>;
const info = (out: Upright): PageInfo => ({ width: out.width, height: out.height, turn: out.turn, ...(out.turnError ? { turnError: out.turnError } : {}) });

/** The readers' answers on a page: the document type (null with no model), the passport zone (null with no
 *  reader; found false when the page has none), the Hebrew fields of a card (null with no reader or when the
 *  page is no card), and what failed. */
export interface Readouts {
  doctype: DoctypeAnswer | null;
  mrz: { found: false } | { found: true; line2: string; ok: number; ms: number } | null;
  he: { read: HeRead; ms: number } | null;
  errors: { reader: 'doctype' | 'mrz' | 'he'; text: string }[];
}

/** One shot: its photo (the attempt's picture, kept for the corner editor), the corners each page was cut by
 *  — the model's, for training: the first document's and the others' — and the way the model ran on. */
export interface ShotRecord {
  /** The shot's number in this session, and its training attempt's id. */
  shot: number;
  attempt: string;
  input: 'camera' | 'photo' | 'pdf';
  frame: OffscreenCanvas;
  w: number;
  h: number;
  edgesModel: Quad | null;
  edgesMore: Quad[];
  pages: number;
  way: string;
  model: string;
}

/** A cut page: its id (the same when it is cut again — refined), its shot and page number on it (0 the first
 *  document, then the others in the order found), the corners on the photo, the page upright — its size and
 *  turn (the turn the face gave: -1 no face, -2 the face finder failed), its pixels on canvas —, its readouts
 *  once read (always read on this very cut: a refined page comes without them, then again once they are
 *  read on it), and whether it is the refined cut. */
export interface ShotPage {
  id: string;
  record: ShotRecord;
  pg: number;
  quad: Quad;
  page: PageInfo;
  canvas: OffscreenCanvas;
  turn: number;
  readouts: Readouts | null;
  refined: boolean;
}

/** What a shot needs of the session. */
export interface ShotCtx {
  engine(): LoadableEngine | null;
  live: Live;
  readers: Readers | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
  way(): string;
  modelVersion(): string;
  /** A new shot begins: its id (work for an older one is dropped from now on). */
  begin(): number;
  /** The shot id now: work for an older one is dropped. */
  current(): number;
  status(s: SessionStatus): void;
  page(p: ShotPage): void;
  captured(ms: number): void;
  log: { log(t: string): void; err(t: string): void };
}

/** The readers on a page, each apart (one failing leaves the others). */
export async function readPage(readers: Readers | null, canvas: OffscreenCanvas, now: () => number): Promise<Readouts> {
  const r: Readouts = { doctype: null, mrz: null, he: null, errors: [] };
  if (!readers) return r;
  try { r.doctype = await readers.doctypeAnswer(canvas); } catch (e) { r.errors.push({ reader: 'doctype', text: errText(e) }); }
  try {
    const t0 = now(), lines = await readers.mrzRead(canvas);
    if (lines !== null) { const z = mrzZone(lines); r.mrz = z ? { found: true, line2: z.line2, ok: z.ok, ms: now() - t0 } : { found: false }; }
  } catch (e) { r.errors.push({ reader: 'mrz', text: errText(e) }); }
  try {
    const t0 = now(), f = await readers.heRead(canvas);
    if (f && f.layout) r.he = { read: f as HeRead, ms: now() - t0 };
  } catch (e) { r.errors.push({ reader: 'he', text: errText(e) }); }
  return r;
}

/** The camera's frame frozen: a w×h canvas and its RGBA. */
export function freeze(video: VideoLike): { frame: OffscreenCanvas; pix: Uint8ClampedArray; w: number; h: number } {
  const w = video.videoWidth, h = video.videoHeight, frame = mkCanvas(w, h), g = ctx(frame, true);
  g.drawImage(video as unknown as CanvasImageSource, 0, 0, w, h);
  return { frame, pix: g.getImageData(0, 0, w, h).data, w, h };
}

/** Freeze the frame, cut it by the live frame at once, refine the corners with the accurate model, look for
 *  the other documents on it. Returns how many documents the shot held (0 when there was nothing to take or a
 *  newer shot took over). */
export async function takeShot(c: ShotCtx): Promise<number> {
  const { live } = c, v = live.video, engine = c.engine(), lastRes = live.lastRes;
  if (!v || !engine || !lastRes || lastRes.pts.some(p => !p)) { c.status({ key: 'no_frame' }); return 0; }
  live.running = false;
  const id = c.begin(), t0 = c.now(), { frame, pix, w, h } = freeze(v);
  const record: ShotRecord = { shot: id, attempt: c.newId(), input: 'camera', frame, w, h, edgesModel: null, edgesMore: [], pages: 1, way: c.way(), model: c.modelVersion() };
  let first: ShotPage | null = null;
  const put = async (pts: Quad, refined: boolean): Promise<boolean> => {
    const out = await engine.warp(pix.slice(), w, h, pts, true);
    if (out.turnError) c.log.err('Face finder: ' + out.turnError);
    if (id !== c.current()) return false;
    record.edgesModel = copy(pts);
    first = { id: record.attempt + ':0', record, pg: 0, quad: copy(pts), page: info(out), canvas: toCanvas(out), turn: out.turn, readouts: null, refined };
    c.page(first);
    return true;
  };
  const livePts = lastRes.pts as Quad;
  if (!(await put(livePts, false))) return 0;
  const ms = Math.round(c.now() - t0); c.captured(ms); c.status({ key: 'captured', ms });
  const p0 = first as ShotPage | null;
  if (!p0) return 0;
  const readouts = await readPage(c.readers, p0.canvas, c.now);
  if (id !== c.current()) return 0;
  first = { ...p0, readouts }; c.page(first);
  if (!engine.hasCap()) { c.status({ key: 'found', count: 1 }); return 1; }
  c.status({ key: 'refining' });
  while (live.inFlight) await c.sleep(10);  // the live frames still in work finish first
  const { res: exact } = await engine.detect('cap', { rgba: smallRGBA(frame, w, h) });
  if (id !== c.current()) return 0;
  const confirmed = !exact.pts.some(p => !p) && exact.conf >= 0.5;
  let firstQ = livePts, moved = 0;
  if (confirmed) {
    const ex = exact.pts as Quad;
    moved = Math.max(...ex.map((p, k) => Math.hypot(p[0] - livePts[k][0], p[1] - livePts[k][1])));
    if (moved > 0.002) {
      if (!(await put(ex, true))) return 0;
      // the readouts read again on the refined cut (its edges, where the zone and the fields lie, moved)
      const p1 = first as ShotPage | null;
      if (!p1) return 0;
      const r1 = await readPage(c.readers, p1.canvas, c.now);
      if (id !== c.current()) return 0;
      first = { ...p1, readouts: r1 }; c.page(first);
    }
    firstQ = ex; live.target = { pts: ex, ok: true }; live.shown = copy(ex);
  }
  c.log.log('Shown in ' + ms + ' ms; ' + (!confirmed ? 'the accurate model did not confirm the corners' : moved > 0.002 ? 'corners refined by the accurate model (moved ' + (moved * 100).toFixed(1) + '%)' : 'the accurate model agreed') + ' in ' + Math.round(c.now() - t0) + ' ms');
  c.status({ key: 'looking_more', count: 1 });
  // More documents on the same photo (a passport, its ספח, a card…): up to 4 in all.
  const found: Quad[] = [firstQ], more: ShotPage[] = [];
  const addMore = async (q: Quad): Promise<boolean> => {
    found.push(q);
    const out = await engine.warp(pix.slice(), w, h, q, true);
    if (id !== c.current()) return false;
    record.edgesMore.push(copy(q)); record.pages = found.length;
    const pg = found.length - 1, p: ShotPage = { id: record.attempt + ':' + pg, record, pg, quad: copy(q), page: info(out), canvas: toCanvas(out), turn: out.turn, readouts: null, refined: false };
    more.push(p); c.page(p);
    c.status({ key: 'looking_more', count: found.length });
    return true;
  };
  for (let n = 1; n < 4; n++) {
    const q = await findNext(frame, w, h, found, engine);
    if (id !== c.current()) return 0;
    if (!q || !(await addMore(q))) break;
  }
  if (id !== c.current()) return 0;
  // a document lying on one found (an ID card on its ספח)
  for (const q of found.slice()) {
    if (found.length >= MAX_DOCS) break;
    const inner = await findInside(pix, w, h, q, engine, found);
    if (id !== c.current()) return 0;
    if (inner && !(await addMore(inner))) return 0;
  }
  c.log.log((found.length > 1 ? found.length + ' documents' : 'One document') + ' on this photo (' + Math.round(c.now() - t0) + ' ms in all)');
  c.status({ key: 'found', count: found.length });
  // the other pages' readouts, once the search is over (it is not slowed by them)
  for (const p of more) {
    const r = await readPage(c.readers, p.canvas, c.now);
    if (id !== c.current()) break;
    c.page({ ...p, readouts: r });
  }
  return found.length;
}

/** A document lying on another (findInside): the found one q cut flat (not turned) and looked at on its own;
 *  its corners taken back onto the photo, or null. */
export async function findInside(pix: Uint8ClampedArray, w: number, h: number, q: Quad, eng: LoadableEngine, found: Quad[]): Promise<Quad | null> {
  const flat = toCanvas(await eng.warp(pix.slice(), w, h, q, false)), W = flat.width, H = flat.height;
  const { res } = await eng.detect(eng.hasCap() ? 'cap' : 'live', { rgba: smallRGBA(flat, W, H) });
  return insideDoc(res, W, H, q, found);
}

/** The colour of the photo's border: the median of each channel along the edge of a 32×32 copy. */
export function borderColour(frame: OffscreenCanvas): string {
  const t = mkCanvas(32, 32), tg = ctx(t, true); tg.drawImage(frame, 0, 0, 32, 32);
  const d = tg.getImageData(0, 0, 32, 32).data, rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < 32; i++) for (const [x, y] of [[i, 0], [i, 31], [0, i], [31, i]]) { const k = (y * 32 + x) * 4; rs.push(d[k]); gs.push(d[k + 1]); bs.push(d[k + 2]); }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return `rgb(${med(rs)},${med(gs)},${med(bs)})`;
}

/** The next document on the photo, or null (see the head of this file). */
export async function findNext(frame: OffscreenCanvas, w: number, h: number, found: Quad[], eng: LoadableEngine): Promise<Quad | null> {
  const fresh = (q: Quad) => docShape(q, w, h) && found.every(f => quadIoU(q, f) <= 0.3);
  const tryIt = async (which: 'cap' | 'live', src: OffscreenCanvas, sw: number, sh: number, map: (p: Pt) => Pt): Promise<Quad | null> => {
    const { res } = await eng.detect(which, { rgba: smallRGBA(src, sw, sh) });
    if (!goodQuad(res)) return null;
    const q = res.pts.map(map);
    return fresh(q) ? q : null;
  };
  const models: ('cap' | 'live')[] = eng.hasCap() ? ['cap', 'live'] : ['live'];
  // the found ones painted over in the colour of the photo's border
  const c = mkCanvas(w, h), g = ctx(c); g.drawImage(frame, 0, 0);
  g.fillStyle = borderColour(frame);
  for (const q of found) {
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    g.beginPath(); q.forEach(([x, y], i) => { const X = (x + (x - cx) * 0.04) * w, Y = (y + (y - cy) * 0.04) * h; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.closePath(); g.fill();
  }
  for (const m of models) { const q = await tryIt(m, c, w, h, p => p); if (q) return q; }
  const P = Math.round(0.1 * Math.max(w, h)), pc = mkCanvas(w + 2 * P, h + 2 * P);
  const pg = ctx(pc); pg.fillStyle = g.fillStyle; pg.fillRect(0, 0, pc.width, pc.height); pg.drawImage(c, P, P);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const m of models) { const q = await tryIt(m, pc, pc.width, pc.height, ([x, y]) => [clamp((x * pc.width - P) / w), clamp((y * pc.height - P) / h)]); if (q) return q; }
  // the widest strip left beside the first (none found yet: nothing beside)
  if (!found.length) return null;
  const q1 = found[0], xs = q1.map(p => p[0]), ys = q1.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const strips = [[0, 0, 1, y0], [0, y1, 1, 1], [0, 0, x0, 1], [x1, 0, 1, 1]].filter(([a, b, c2, d2]) => c2 - a >= 0.25 && d2 - b >= 0.2)
    .sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]));
  for (const [a, b, c2, d2] of strips.slice(0, 2)) {
    const sw = Math.round((c2 - a) * w), sh = Math.round((d2 - b) * h), sc = mkCanvas(sw, sh);
    ctx(sc).drawImage(c, Math.round(a * w), Math.round(b * h), sw, sh, 0, 0, sw, sh);
    const q = await tryIt(models[0], sc, sw, sh, ([x, y]) => [a + x * (c2 - a), b + y * (d2 - b)]);
    if (q) return q;
  }
  return null;
}
