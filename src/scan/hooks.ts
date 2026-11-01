// The browser tests' hooks into the site's scanner (window.ManagerScan.hooks(), loaded with the scanner's chunk;
// docs/tests.md): the engine's pure functions (the other documents' shape, a picture worked on any engine, a
// document lying on another, picked files in order, a way failure's kind), the kept session, its training
// attempts, and pages given to the session as its camera would (CI has no camera and no models). Nothing in
// the app calls them. The scanner lab's page (/scan-lab/, src/scan/lab/) loads them too, for its own session
// (injectInto). stubWorkers / stubReaders put stand-ins with fixed answers in place of the models — the corners
// model behind the real thread protocol (the engine's ways, pool, capture thread and watchdog run as on a
// phone) —, so the real camera path (tests/e2e/scanner.test.js: a canvas stream for the camera) runs whole:
// the live frame, the green frame, Auto, the shot and its other documents, picked pictures, the readouts.
import { keptSession } from './keep';
import { S, WHOLE_PAGE, docShape, warpRGBA } from './engine/geometry';
import { analyzePicture, defaultFilesEnv, pickedPictures } from './engine/files';
import { findInside, type Readouts, type ShotPage, type ShotRecord } from './engine/shot';
import { failKind } from './engine/fails';
import { mkCanvas } from './engine/upright';
import { heIdOk, type DoctypeAnswer, type HeRead } from './engine/readers';
import type { WorkerLike } from './engine/engines';
import type { WorkerIn, WorkerOut } from './engine/worker';
import type { Doctype } from './engine/doctypes';
import type { Pt, Quad } from './engine/types';
import type { ScanSession } from './engine/session';

export const engine = { docShape, analyzePicture, findInside, failKind, pickedPictures, filesEnv: defaultFilesEnv };

/** The site's session kept now (open, or within 3 minutes of the window closing), or null. */
export const session = (): ScanSession | null => keptSession();
/** Its training attempts. */
export const attempts = () => { const s = keptSession(); if (!s) throw new Error('no scan session'); return s.attempts; };

/** One page to give: its JPEG, and what the readers read on it (the document type model's answer — turn in
 *  quarter turns —, the passport zone's lines, the Hebrew fields); turn / faceTurn (the same): the turn the face finder gave it
 *  (≥ 0: set upright by its face; -1, the default: no face). */
export interface InjectPage { b64: string; doctype?: { doctype: Doctype; conf: number; turn: number; turnConf: number } | null; mrz?: string[] | null; he?: HeRead | null; turn?: number; faceTurn?: number }

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
    const pic = o.pics[i], canvas = await decode('data:image/jpeg;base64,' + pic.b64), turn = pic.faceTurn ?? pic.turn ?? -1;
    const page: ShotPage = { id: record.attempt + ':' + i, record, pg: i, quad: (i === 0 && o.edges) || WHOLE_PAGE, page: { width: canvas.width, height: canvas.height, turn },
      canvas, turn, readouts: null, refined: !!before };
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

/** What the threads' stand-ins did, for the checks: threads started and ended, the messages each kind got (and
 *  per model loaded on the thread), the frames that came as bitmaps, the bitmaps and buffers the page sent
 *  without handing them over (copied, not transferred: 0 when every one was), the calls a stopped thread kept
 *  unanswered, the most frames worked on at once, and the loads in time ('load <model>' when sent, 'up <model>'
 *  when answered — which models were loading at once). */
export interface ThreadStats {
  spawned: number; terminated: number; load: number; detect: number; warp: number; bitmaps: number; copied: number;
  swallowed: number; inFlight: number; maxInFlight: number; byModel: Record<string, { detect: number; warp: number }>; loads: string[];
}
/** The threads' stand-ins as the checks drive them: their figures, hang(model) — the threads holding that model
 *  (by default the live model) stop answering, as a phone's hung GPU did; returns how many —, and skew(ms) —
 *  the engine's clock moved on by ms, so a call left unanswered meets the 25 s watchdog without a 25 s wait. */
export interface StubThreads { stats: ThreadStats; hang(model?: string): number; skew(ms: number): void }

/** The corners model's stand-in behind the real thread protocol (CI has no models): the engine's background
 *  threads (Engines.env.spawn) become stand-ins that speak worker.ts's messages — 'load' answered with the CPU
 *  backend after loadMs, 'detect' with the largest bright document of the bitmap or RGBA handed over
 *  (brightDocs; sure, 0.9; or no corners) after ms, 'warp' with the page warped as it is (no face to turn it:
 *  turn -1) — each message cloned with its transfer list as postMessage does, so a bitmap or buffer the page
 *  forgot to hand over shows (stats.copied). The session then starts its ways as on a phone: the capture thread,
 *  the pool of live threads sharing it, the watchdog, the next way when one stops answering. */
export function stubWorkers(s: ScanSession, o: { ms?: number; loadMs?: number } = {}): StubThreads {
  const E = s.engines, ms = o.ms ?? 30, loadMs = o.loadMs ?? 250, all: Fake[] = [];
  const stats: ThreadStats = { spawned: 0, terminated: 0, load: 0, detect: 0, warp: 0, bitmaps: 0, copied: 0, swallowed: 0, inFlight: 0, maxInFlight: 0, byModel: {}, loads: [] };
  const sleep = (t: number) => new Promise(r => setTimeout(r, t));
  class Fake implements WorkerLike {
    onmessage: WorkerLike['onmessage'] = null;
    onerror: WorkerLike['onerror'] = null;
    model = '';
    hung = false;
    dead = false;
    postMessage(m: WorkerIn, transfer: Transferable[] = []): void {
      if (this.dead) return;
      const sent = m.type === 'detect' ? m.bitmap || m.rgba : m.type === 'warp' ? m.rgba : undefined;
      const got = structuredClone(m, { transfer }) as WorkerIn;
      // handed over: the page's own bitmap is closed (0×0), its buffer emptied
      if (sent && (sent instanceof ImageBitmap ? sent.width > 0 : (sent as ArrayBuffer).byteLength > 0)) stats.copied++;
      if (got.type === 'detect' && got.bitmap) stats.bitmaps++;
      if (this.hung) { stats.swallowed++; return; }
      void this.answer(got);
    }
    terminate(): void { if (!this.dead) { this.dead = true; stats.terminated++; } }
    private say(m: WorkerOut, transfer: Transferable[] = []): void {
      if (this.dead) return;
      const data = structuredClone(m, { transfer }) as WorkerOut;
      setTimeout(() => { if (!this.dead && this.onmessage) this.onmessage({ data }); }, 0);
    }
    private count(kind: 'detect' | 'warp'): void {
      stats[kind]++;
      const b = stats.byModel[this.model] || (stats.byModel[this.model] = { detect: 0, warp: 0 });
      b[kind]++;
    }
    private async answer(m: WorkerIn): Promise<void> {
      if (m.type === 'load') {
        stats.load++; this.model = m.live; stats.loads.push('load ' + m.live);
        this.say({ type: 'log', text: 'The test stand-in thread loads ' + m.live + (m.cap ? ' + ' + m.cap : '') });
        await sleep(loadMs);
        if (this.dead) return;
        stats.loads.push('up ' + m.live);
        // on the GPU: its check passed now (a stand-in pass the page keeps under its surface's key)
        const gpu = m.want === 'webgpu';
        this.say({ type: 'reply', id: m.id, ep: gpu ? 'webgpu' : 'wasm', layout: gpu ? 'NHWC' : null, gpu: gpu ? [m.live] : [],
          passes: gpu ? { [m.live]: { stamp: 'stand-in', ort: 'stand-in', ua: navigator.userAgent, layout: 'NHWC' } } : {} });
      } else if (m.type === 'detect') {
        this.count('detect');
        stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        try {
          let px: Uint8ClampedArray;
          if (m.bitmap) {
            const c = mkCanvas(S, S), g = c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
            g.drawImage(m.bitmap, 0, 0, S, S); m.bitmap.close(); px = g.getImageData(0, 0, S, S).data;
          } else px = new Uint8ClampedArray(m.rgba as ArrayBuffer);
          const q = brightDocs(px, S, S)[0];
          await sleep(ms);
          this.say({ type: 'reply', id: m.id, res: q ? { pts: q, conf: 0.9 } : { pts: [null, null, null, null], conf: 0 }, ms });
        } finally { stats.inFlight--; }
      } else if (m.type === 'warp') {
        this.count('warp');
        const out = { ...warpRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, m.pts), turn: -1 };
        this.say({ type: 'reply', id: m.id, out }, [out.data.buffer as ArrayBuffer]);
      }
    }
  }
  E.env.spawn = () => { const f = new Fake(); all.push(f); stats.spawned++; return f; };
  const realNow = E.env.now;
  let ahead = 0;
  return {
    stats,
    hang(model = E.settings.model.split('+')[0]) {
      const hit = all.filter(f => !f.dead && f.model === model);
      for (const f of hit) f.hung = true;
      return hit.length;
    },
    skew(t) { ahead += t; E.env.now = () => realNow() + ahead; },
  };
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
  // a session stands there, as with a version that has the model: Auto asks it before a shot
  if (r.wide || r.tall) R.doctype = { release: async () => {} } as unknown as typeof R.doctype;
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
