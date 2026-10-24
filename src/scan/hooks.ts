// The browser tests' hooks into the site's scanner (window.ManagerScan.hooks(), loaded with the scanner's chunk;
// docs/tests.md): the engine's pure functions (the other documents' shape, a picture worked on any engine, a
// document lying on another, picked files in order, a way failure's kind), the kept session, its training
// attempts, and pages given to the session as its camera would (CI has no camera and no models). Nothing in
// the app calls them. The scanner lab's page (/scan-next/, src/scan/lab/) loads them too, for its own session
// (injectInto). stubEngine / stubReaders put stand-ins with fixed answers in place of the models, so the real
// camera path (tests/e2e/scanner.test.js: a canvas stream for the camera) runs whole in the page: the live
// frame, the green frame, Auto, the shot and its other documents, picked pictures, the readouts.
import { keptSession } from './keep';
import { S, WHOLE_PAGE, docShape, warpRGBA } from './engine/geometry';
import { analyzePicture, defaultFilesEnv, pickedPictures } from './engine/files';
import { findInside, type Readouts, type ShotPage, type ShotRecord } from './engine/shot';
import { failKind } from './engine/fails';
import { mkCanvas } from './engine/upright';
import { heIdOk, type DoctypeAnswer, type HeRead } from './engine/readers';
import type { DetectInput, LoadableEngine } from './engine/engines';
import type { Doctype } from './engine/doctypes';
import type { Pt, Quad } from './engine/types';
import type { ScanSession } from './engine/session';

export const engine = { docShape, analyzePicture, findInside, failKind, pickedPictures, filesEnv: defaultFilesEnv };

/** The site's session kept now (open, or within 3 minutes of the window closing), or null. */
export const session = (): ScanSession | null => keptSession();
/** Its training attempts. */
export const attempts = () => { const s = keptSession(); if (!s) throw new Error('no scan session'); return s.attempts; };

/** One page to give: its JPEG, and what the readers read on it (the document type model's answer — turn in
 *  quarter turns —, the passport zone's lines, the Hebrew fields). */
export interface InjectPage { b64: string; doctype?: { doctype: Doctype; conf: number; turn: number; turnConf: number } | null; mrz?: string[] | null; he?: HeRead | null }

let seq = 0;

/** Pages given to the session as a shot (camera) or a pick's picture would give them — each first as cut, then
 *  with its readouts. A new photo starts a training attempt (its frame w×h, the model's corners `edges`);
 *  `attempt` gives a shot's pages again (refined: the same ids). Returns the attempt and the pages' ids. */
export type InjectOpts = { pics: InjectPage[]; attempt?: string; camera?: boolean; w?: number; h?: number; edges?: Quad };
export async function inject(o: InjectOpts): Promise<{ attempt: string; ids: string[] }> {
  const s = keptSession();
  if (!s) throw new Error('no scan session');
  return injectInto(s, o);
}

/** The same into a given session (the scanner lab's page, src/scan/lab/LabApp.tsx: window.ScanLab.inject). */
export async function injectInto(s: ScanSession, o: InjectOpts): Promise<{ attempt: string; ids: string[] }> {
  const before = o.attempt ? [...s.pages.values()].find(p => p.record.attempt === o.attempt) : undefined;
  let record: ShotRecord;
  if (before) record = before.record;
  else {
    const n = ++seq, w = o.w || 800, h = o.h || 600, camera = o.camera !== false;
    record = { shot: camera ? 1000 + n : 0, batch: 1000 + n, attempt: o.attempt || 'test' + Date.now().toString(36) + n, input: camera ? 'camera' : 'photo', w, h,
      edgesModel: o.edges || null, edgesMore: [], pages: o.pics.length, way: 'test', model: '' };
    const frame = mkCanvas(w, h), g = frame.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.fillStyle = '#888'; g.fillRect(0, 0, w, h);
    s.attempts.newAttempt(frame, w, h, record.input, { id: record.attempt, way: record.way, model: record.model, src: record });
  }
  record.pages = o.pics.length;
  const decode = defaultFilesEnv().decode, ids: string[] = [];
  for (let i = 0; i < o.pics.length; i++) {
    const pic = o.pics[i], canvas = await decode('data:image/jpeg;base64,' + pic.b64);
    const page: ShotPage = { id: record.attempt + ':' + i, record, pg: i, quad: (i === 0 && o.edges) || WHOLE_PAGE, page: { width: canvas.width, height: canvas.height, turn: -1 },
      canvas, turn: -1, readouts: null, refined: !!before };
    s.inject(page, true);
    const readouts: Readouts = {
      doctype: pic.doctype ? { ...pic.doctype, ms: 1, square: canvas } : null,
      mrz: pic.mrz ? { found: false, lines: pic.mrz } : null,
      he: pic.he ? { read: pic.he, ms: 1 } : null,
      errors: [],
    };
    await new Promise(r => setTimeout(r, 0));
    s.inject({ ...page, readouts });
    ids.push(page.id);
  }
  return { attempt: record.attempt, ids };
}

/** The bright documents on a dark ground of a w×h RGBA picture, each as its bounding box in shares of the
 *  picture, the largest first (a part under 0.5 % of the picture is no document). */
export function brightDocs(px: ArrayLike<number>, w: number, h: number): Quad[] {
  const n = w * h, seen = new Uint8Array(n), found: { q: Quad; size: number }[] = [];
  const bright = (i: number): boolean => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2] > 160;
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !bright(i)) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, size = 0;
    seen[i] = 1; stack.push(i);
    while (stack.length) {
      const j = stack.pop() as number, x = j % w, y = (j - x) / w;
      size++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (k >= 0 && !seen[k] && bright(k)) { seen[k] = 1; stack.push(k); }
      }
    }
    if (size < n * 0.005) continue;
    const l = x0 / w, t = y0 / h, r = (x1 + 1) / w, b = (y1 + 1) / h;
    found.push({ q: [[l, t], [r, t], [r, b], [l, b]] as Pt[], size });
  }
  return found.sort((a, b) => b.size - a.size).map(f => f.q);
}

/** The corners model's stand-in (CI has no models): on every frame it is given — the live frame's, the shot's,
 *  a painted-over photo's, a picked picture's — it answers the largest bright document (brightDocs) sure (0.9),
 *  or no corners; the cut is the page warped as it is (no face to turn it: turn -1). Put in place of the
 *  session's ways (Engines.useEngine), it lasts until the settings change. */
export function stubEngine(s: ScanSession, ms = 15): void {
  const pixels = (input: DetectInput): Uint8ClampedArray => {
    if (input.rgba) return input.rgba;
    const c = mkCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    g.drawImage(input.bitmap as ImageBitmap, 0, 0, S, S);
    (input.bitmap as ImageBitmap).close();
    return g.getImageData(0, 0, S, S).data;
  };
  const e: LoadableEngine = {
    load: async () => 'stand-in',
    hasCap: () => true,
    detect: async (_which, input) => {
      const q = brightDocs(pixels(input), S, S)[0];
      await new Promise(r => setTimeout(r, ms));
      return { res: q ? { pts: q, conf: 0.9 } : { pts: [null, null, null, null], conf: 0 }, ms };
    },
    warp: async (rgba, w, h, pts) => ({ ...warpRGBA(rgba, w, h, pts), turn: -1 }),
    stop: () => {},
  };
  s.engines.useEngine(e, 'test stand-in');
}

/** What the readers' stand-ins answer: the document type by the page's shape (a page wider than high, one
 *  higher than wide), the passport zone's lines and the Hebrew fields (their ID tick worked out as the reader
 *  does, heIdOk) on a page wider than high; null: nothing. */
export interface StubReads {
  wide: { doctype: Doctype; conf: number; turnConf: number } | null;
  tall: { doctype: Doctype; conf: number; turnConf: number } | null;
  mrz: string[] | null;
  he: Omit<HeRead, 'idOk'> | null;
}

/** The readers' stand-ins in place of the document type, passport zone and Hebrew models (CI has none): the
 *  session's own readPage then works their answers out as it does the models' — the zone's check digits
 *  (mrzZone), the readouts on each cut. */
export function stubReaders(s: ScanSession, r: StubReads): void {
  const R = s.readers;
  if (!R) throw new Error('the session has no readers');
  const wide = (c: { width: number; height: number }): boolean => c.width > c.height;
  R.doctypeAnswer = async (src): Promise<DoctypeAnswer | null> => {
    if (!src) return null;
    const a = wide(src) ? r.wide : r.tall;
    if (!a) return null;
    const square = mkCanvas(256, 256);
    (square.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(src, 0, 0, 256, 256);
    return { doctype: a.doctype, conf: a.conf, turn: 0, turnConf: a.turnConf, ms: 3, square };
  };
  R.mrzRead = async canvas => (canvas && r.mrz ? (wide(canvas) ? r.mrz.slice() : []) : null);
  R.heRead = async canvas => {
    if (!canvas || !r.he) return null;
    if (!wide(canvas)) return {};
    const id = r.he.idNo;
    return { ...r.he, idOk: heIdOk(typeof id === 'string' ? id : undefined) } as HeRead;
  };
}
