// The full-screen scanner (docs/scan-plan.md → S9): a fake scan session for the /next gallery and its browser
// check — the scanner screen looked at with no camera and no models. It plays what a real ScanSession says: a
// drawn "camera" (a document on a desk, through a canvas stream), the live frame red while it searches then
// green, the status going finding → a corner outside → hold → found; a shot gives a page that is read a moment
// later, then the live frame goes on by itself and says the document taken is still in front of the camera
// (taken: Auto waits); a pick shows its picture, then its page, and the camera comes back; Fix corners gets a drawn photo, and Apply cuts the page again.
// Every call is written to `calls` (the gallery shows them, so the check can see what the screen asked for).
// The pictures are drawn in the design system's colours (og.css tokens), read from the page.
import type { VideoLike } from '../engine/camera';
import type { Doctype } from '../engine/doctypes';
import type { PickFile } from '../engine/files';
import type { SessionEvents } from '../engine/session';
import type { Readouts, ShotPage } from '../engine/shot';
import type { SessionStatus } from '../engine/status';
import type { Pt, Quad } from '../engine/types';
import { token } from './LiveOverlay';
import type { Fixable, ScanSessionLike } from './useScanSession';

/** The fixture pages: their type and how sure the "model" is (null: still being read). */
export const FAKE_PAGES: { kind: Doctype; conf: number | null }[] = [
  { kind: 'id_front', conf: 0.97 },
  { kind: 'id_back', conf: 0.88 },
  { kind: 'passport', conf: null },
];
/** The document's corners on the drawn photo (shares). */
const DOC: Quad = [[0.22, 0.2], [0.79, 0.24], [0.76, 0.8], [0.19, 0.75]];
const PHOTO_W = 1200, PHOTO_H = 900;
const STRIPE: Record<Doctype, string> = { id_front: '--accent', id_back: '--green', sefach: '--amber', passport: '--red', contract: '--uline-1', other: '--ink-2' };

type Listeners = { [K in keyof SessionEvents]: Set<SessionEvents[K]> };

/** A document page drawn: its stripe in the type's colour, a photo box, text lines. */
function drawPage(kind: Doctype, fixed: boolean): OffscreenCanvas {
  const w = kind === 'passport' || kind === 'contract' ? 300 : 428, h = kind === 'passport' ? 420 : kind === 'contract' ? 424 : 270;
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d')!;
  g.fillStyle = token('--ink'); g.fillRect(0, 0, w, h);
  g.fillStyle = token(STRIPE[kind]); g.fillRect(0, 0, w, Math.round(h * 0.16));
  g.globalAlpha = 0.55; g.fillStyle = token('--ink-3'); g.fillRect(w * 0.06, h * 0.26, w * 0.26, h * 0.5);
  for (let i = 0; i < 5; i++) g.fillRect(w * 0.38, h * (0.3 + i * 0.1), w * (0.5 - i * 0.05), h * 0.035);
  g.globalAlpha = 1;
  if (fixed) { g.strokeStyle = token('--uline-2'); g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8); }
  return c;
}

/** The photo the page was cut from: the document on a desk. */
function drawPhoto(kind: Doctype): OffscreenCanvas {
  const c = new OffscreenCanvas(PHOTO_W, PHOTO_H), g = c.getContext('2d')!;
  g.fillStyle = token('--plate-bottom'); g.fillRect(0, 0, PHOTO_W, PHOTO_H);
  g.fillStyle = token('--ink');
  g.beginPath(); DOC.forEach(([x, y], i) => (i ? g.lineTo(x * PHOTO_W, y * PHOTO_H) : g.moveTo(x * PHOTO_W, y * PHOTO_H))); g.closePath(); g.fill();
  g.fillStyle = token(STRIPE[kind]);
  g.beginPath(); g.moveTo(DOC[0][0] * PHOTO_W, DOC[0][1] * PHOTO_H); g.lineTo(DOC[1][0] * PHOTO_W, DOC[1][1] * PHOTO_H);
  g.lineTo(DOC[1][0] * PHOTO_W - 3, (DOC[1][1] + 0.09) * PHOTO_H); g.lineTo(DOC[0][0] * PHOTO_W - 3, (DOC[0][1] + 0.09) * PHOTO_H); g.closePath(); g.fill();
  return c;
}

const readouts = (kind: Doctype, conf: number): Readouts => ({
  doctype: { doctype: kind, conf, turn: 0, turnConf: 0.99, ms: 14, square: new OffscreenCanvas(8, 8) }, mrz: null, he: null, errors: [],
});

export class FakeScanSession implements ScanSessionLike {
  auto = true;
  /** What the screen asked for, in order ("snap", "keep p1", "remove p2", "fix p1 [[…]]", "done" …). */
  readonly calls: string[] = [];
  private listeners: Listeners = { frame: new Set(), status: new Set(), figures: new Set(), page: new Set(), preview: new Set(), auto: new Set() };
  private pages = new Map<string, ShotPage>();
  private kinds = new Map<string, Doctype>();
  private photos = new Map<string, OffscreenCanvas>();
  /** The camera's timers (sleep stops them) and the rest (reads, status lines). */
  private camTimers: number[] = [];
  private timers: number[] = [];
  private status: SessionStatus | null = null;
  private seq = 0;
  private scene: HTMLCanvasElement | null = null;
  /** Called after each call is written (the gallery redraws its list). */
  onCall: (() => void) | null = null;

  /** seed: how many fixture pages it starts with (FAKE_PAGES, in order); startMs: how long the "models" take after
   *  the camera shows (nothing said until then, as a real session). */
  constructor(seed = 0, private readonly startMs = 0) {
    for (let i = 0; i < seed; i++) this.addPage(FAKE_PAGES[i % FAKE_PAGES.length].kind, FAKE_PAGES[i % FAKE_PAGES.length].conf, false);
  }

  on<K extends keyof SessionEvents>(ev: K, fn: SessionEvents[K]): () => void {
    this.listeners[ev].add(fn);
    // a new listener hears what is there already (the pages, the status line)
    if (ev === 'page') for (const p of this.pages.values()) (fn as SessionEvents['page'])(p);
    if (ev === 'status' && this.status) (fn as SessionEvents['status'])(this.status);
    return () => { this.listeners[ev].delete(fn); };
  }
  private emit<K extends keyof SessionEvents>(ev: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const fn of this.listeners[ev]) (fn as (...a: Parameters<SessionEvents[K]>) => void)(...args);
  }
  private say(s: SessionStatus): void { this.status = s; this.emit('status', s); }
  private later(ms: number, fn: () => void): void { this.timers.push(window.setTimeout(fn, ms)); }
  private log(c: string): void { this.calls.push(c); this.onCall?.(); }

  /** A page made (its readouts now, or a moment later when conf is null — read as 0.81). */
  private addPage(kind: Doctype, conf: number | null, emit = true): ShotPage {
    const n = ++this.seq, id = 'p' + n, canvas = drawPage(kind, false);
    const p: ShotPage = {
      id, pg: 0, quad: DOC.map(q => q.slice() as Pt), canvas, turn: 0, refined: false,
      record: { shot: n, batch: n, attempt: 'a' + n, input: 'camera', w: PHOTO_W, h: PHOTO_H, edgesModel: DOC, edgesMore: [], pages: 1, way: 'fake', model: 'fake' },
      page: { width: canvas.width, height: canvas.height, turn: 0 },
      readouts: conf == null ? null : readouts(kind, conf),
    };
    this.pages.set(id, p); this.kinds.set(id, kind);
    if (emit) this.emit('page', p);
    if (conf == null) this.later(emit ? 900 : 1500, () => this.put({ ...this.pages.get(id)!, readouts: readouts(kind, 0.81) }));
    return p;
  }
  private put(p: ShotPage): void {
    if (!this.pages.has(p.id)) return;
    this.pages.set(p.id, p);
    this.emit('page', p);
  }

  /** The drawn camera: a document on a desk, swaying a little, through a canvas stream. */
  async startCamera(video: VideoLike): Promise<void> {
    this.sleep();
    const c = this.scene || (this.scene = document.createElement('canvas'));
    c.width = 720; c.height = 1280;
    const g = c.getContext('2d')!;
    let t = 0;
    const draw = () => {
      t++;
      const dx = Math.sin(t / 9) * 6;
      g.fillStyle = token('--plate-bottom'); g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = token('--ink');
      g.beginPath(); this.liveQuad().forEach(([x, y], i) => (i ? g.lineTo(x * c.width + dx, y * c.height) : g.moveTo(x * c.width + dx, y * c.height))); g.closePath(); g.fill();
    };
    draw();
    this.camTimers.push(window.setInterval(draw, 100));
    const stream = (c as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream?.(10);
    if (stream) { video.srcObject = stream; void video.play().catch(() => {}); }
    const cam = (ms: number, fn: () => void) => this.camTimers.push(window.setTimeout(fn, ms));
    const models = () => {
      this.say({ key: 'finding' });
      // the live frame: red while searching, green once it sticks; the status line with it
      let ok = false, shown = false;
      this.camTimers.push(window.setInterval(() => { if (shown) this.emit('frame', this.liveQuad(), ok); }, 100));
      cam(700, () => { shown = true; this.say({ key: 'corners_out', n: 1 }); });
      cam(1500, () => { ok = true; this.say({ key: 'hold', seconds: 0.6 }); });
      cam(2100, () => this.say({ key: 'found', count: 1 }));
    };
    if (this.startMs) cam(this.startMs, models); else models();
  }
  private liveQuad(): Quad { return [[0.16, 0.3], [0.84, 0.32], [0.82, 0.66], [0.14, 0.64]]; }

  async snap(): Promise<number> {
    this.log('snap');
    this.say({ key: 'captured', ms: 180 });
    const f = FAKE_PAGES[this.seq % 2];
    this.addPage(f.kind, null);
    this.later(400, () => this.say({ key: 'found', count: 1 }));
    this.later(1000, () => this.say({ key: 'taken' }));
    return 1;
  }
  setAuto(on: boolean): void { this.auto = on; this.log('auto ' + (on ? 'on' : 'off')); }
  /** Auto turning itself off, as a real session does after AUTO_MAX shots in a row (the gallery's button). */
  autoStop(): void { this.auto = false; this.emit('auto', false); }
  wake(): void { this.log('wake'); this.say({ key: 'finding' }); this.later(800, () => this.say({ key: 'found', count: 1 })); }
  /** A page opened large over the camera: the drawn camera has nothing to pause (not written to calls). */
  hold(): void { /* nothing to pause */ }
  resume(): void { /* nothing to start again */ }
  sleep(): void { for (const t of this.camTimers) { window.clearTimeout(t); window.clearInterval(t); } this.camTimers = []; }
  private stopAll(): void { this.sleep(); for (const t of this.timers) window.clearTimeout(t); this.timers = []; }

  async pick(files: PickFile[]): Promise<number> {
    this.log('pick ' + files.length);
    const batch = ++this.seq;
    for (let i = 0; i < files.length; i++) {
      const f = files[i], url = typeof Blob !== 'undefined' && f instanceof Blob ? URL.createObjectURL(f) : '';
      const where = { file: i + 1, files: files.length, page: 1, pages: 1 };
      this.emit('preview', { batch, n: i + 1, url, ...where, stage: 'finding', quad: null });
      this.say({ key: 'picture_finding', ...where });
      await new Promise(r => setTimeout(r, 300));
      this.emit('preview', { batch, n: i + 1, url, ...where, stage: 'cutting', quad: DOC });
      this.say({ key: 'picture_cutting', ...where });
      await new Promise(r => setTimeout(r, 300));
      this.addPage('passport', 0.93);
      this.emit('preview', { batch, n: i + 1, url, ...where, stage: 'done', quad: DOC });
    }
    this.say({ key: 'picked', pages: files.length, files: files.length });
    this.later(1500, () => this.say({ key: 'finding' }));
    return files.length;
  }

  keep(id: string): void { this.log('keep ' + id); }
  remove(id: string): void { this.log('remove ' + id); this.pages.delete(id); }
  fixable(id: string): Fixable | null {
    const p = this.pages.get(id), kind = this.kinds.get(id);
    if (!p || !kind) return null;
    const frame = this.photos.get(id) || drawPhoto(kind);
    this.photos.set(id, frame);
    return { frame, w: PHOTO_W, h: PHOTO_H, pts: p.quad.map(q => q.slice() as Pt) };
  }
  async fix(id: string, pts: Quad): Promise<boolean> {
    this.log('fix ' + id + ' ' + JSON.stringify(pts));
    const p = this.pages.get(id), kind = this.kinds.get(id);
    if (!p || !kind) return false;
    this.put({ ...p, quad: pts, canvas: drawPage(kind, true), readouts: null });
    this.later(500, () => { const q = this.pages.get(id); if (q) this.put({ ...q, readouts: readouts(kind, 0.95) }); });
    return true;
  }
  done(): void { this.log('done'); this.stopAll(); }
  discard(): void { this.log('discard'); this.stopAll(); }
}
