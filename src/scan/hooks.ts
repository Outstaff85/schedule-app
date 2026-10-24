// The browser tests' hooks into the site's scanner (window.ManagerScan.hooks(), loaded with the scanner's chunk;
// docs/tests.md): the engine's pure functions (the other documents' shape, a picture worked on any engine, a
// document lying on another, picked files in order, a way failure's kind), the kept session, its training
// attempts, and pages given to the session as its camera would (CI has no camera and no models). Nothing in
// the app calls them. The scanner lab's page (/scan-next/, src/scan/lab/) loads them too, for its own session
// (injectInto).
import { keptSession } from './keep';
import { WHOLE_PAGE, docShape } from './engine/geometry';
import { analyzePicture, defaultFilesEnv, pickedPictures } from './engine/files';
import { findInside, type Readouts, type ShotPage, type ShotRecord } from './engine/shot';
import { failKind } from './engine/fails';
import { mkCanvas } from './engine/upright';
import type { HeRead } from './engine/readers';
import type { Doctype } from './engine/doctypes';
import type { Quad } from './engine/types';
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
