// The scanner's engine (docs/scan-plan.md → S9): the pure part of the on-device readers — the passport zone
// reader (docs/hf-plan.md → H8b) and the Hebrew field reader (H8c): the characters, the line input's size,
// the greedy CTC decoding, the zone's line finding, its check digits, the Hebrew writing order, the Israeli
// ID check digit and the card layout's pick. Ported unchanged from the lab's former plain page
// (tests/scan/engine.test.mjs). Mirrored in scripts/scan-train/mrzmodel.py (find_lines / line_input /
// decode) and hemodel.py (CHARS / line_input / logical_simple), and heIdOk in synth.py valid_israeli_id:
// a change in one is made in the others.
//
// The runtime part (Readers, at the end): the readers' sessions as the surface's models.json says, and the
// lab's doctypeAnswer, mrzRead and heRead on canvases (its former plain page), ported unchanged.
import { mrzCheck } from '@/scan-process/mrz';
import { DOCTYPES, type Doctype } from './doctypes';
import { cpuSession, errText, fetchModel, modelStamp, readModels, type ModelsInfo } from './models';
import { loadOrt, tensor, type Ort, type OrtSession } from './ort';
import { CPU_ORT, layoutsUrl, type OrtDir, type SurfaceRef } from './surface';
import { mkCanvas, type Drawable } from './upright';
import type { PixelsLike } from './types';

export const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', MRZ_H = 32, MRZ_W = 512;
export const HE_CHARS = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת0123456789 .,/-\'"()';

/** A line reader's output (logits, dims [1, T, C], class 0 the blank) → its text, greedy. */
export function ctcDecode(data: ArrayLike<number>, dims: readonly number[], chars: string): string {
  const T = dims[1], C = dims[2];
  let s = '', prev = 0;
  for (let t = 0; t < T; t++) {
    let best = 0; for (let c2 = 1; c2 < C; c2++) if (data[t * C + c2] > data[t * C + best]) best = c2;
    if (best !== prev && best !== 0) s += chars[best - 1];
    prev = best;
  }
  return s;
}

/** A line's MRZ_W×MRZ_H RGBA picture → the reader's input (gray, 0..1). */
export function lineInput(px: ArrayLike<number>): Float32Array {
  const f = new Float32Array(MRZ_W * MRZ_H);
  for (let i = 0; i < f.length; i++) f[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  return f;
}

/** RGBA pixels → gray, as the zone's line finding takes them. */
export function grayPixels(px: PixelsLike): Float32Array {
  const d = px.data, gray = new Float32Array(px.width * px.height);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return gray;
}

/** A box in a picture's pixels. */
export interface PxBox { x: number; y: number; w: number; h: number }

/** The first row of a page's lower 45 %, where mrzFind looks for the zone. */
export const mrzTop = (h: number): number => Math.floor(h * 0.55);

/** The passport zone's two lines on a w×h page: the two lowest lines in its lower 45 % that run across
 *  most of its width, [] when there is no zone. grayLow is that band only, gray (the rows from mrzTop(h)
 *  to h: getImageData(0, mrzTop(h), w, h - mrzTop(h)) through grayPixels), as the lab reads it. */
export function mrzFind(grayLow: Float32Array, w: number, h: number): PxBox[] {
  const top = mrzTop(h), ph = h - top;
  if (w < 50 || ph < 20) return [];
  // dark marks: under the mean of their 31×31 neighbourhood by 15 (OpenCV's adaptive mean threshold)
  const W1 = w + 1, sum = new Float64Array(W1 * (ph + 1));
  for (let y = 0; y < ph; y++) { let row = 0; for (let x = 0; x < w; x++) { row += grayLow[y * w + x]; sum[(y + 1) * W1 + x + 1] = sum[y * W1 + x + 1] + row; } }
  const bw = new Uint8Array(w * ph), r = 15;
  for (let y = 0; y < ph; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(ph, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const m = (sum[y1 * W1 + x1] - sum[y0 * W1 + x1] - sum[y1 * W1 + x0] + sum[y0 * W1 + x0]) / ((y1 - y0) * (x1 - x0));
      bw[y * w + x] = grayLow[y * w + x] <= m - 15 ? 1 : 0;
    }
  }
  // closed along each row (a dilation, then an erosion, k wide): the letters of a line join up
  const k = Math.max(3, Math.floor(w / 60)), a = Math.floor(k / 2), tmp = new Uint8Array(w);
  const filled = new Uint8Array(ph);
  for (let y = 0; y < ph; y++) {
    const row = bw.subarray(y * w, y * w + w);
    for (let x = 0; x < w; x++) { let v = 0; for (let j = Math.max(0, x - a); j <= Math.min(w - 1, x - a + k - 1) && !v; j++) v = row[j]; tmp[x] = v; }
    for (let x = 0; x < w; x++) { let v = 1; for (let j = Math.max(0, x - a); j <= Math.min(w - 1, x - a + k - 1) && v; j++) v = tmp[j]; row[x] = v; }
    let n = 0;
    for (let x = 0; x < w; x++) n += row[x];
    filled[y] = n >= 0.35 * w ? 1 : 0;  // a zone line's letters, joined, fill most of the row; specks do not
  }
  const bands: [number, number][] = [], minH = Math.max(4, Math.floor(h / 150));
  for (let y = 0; y < ph; y++) {
    if (!filled[y]) continue;
    const s = y; while (y < ph && filled[y]) y++;
    if (y - s >= minH) bands.push([s, y]);
  }
  // a thin band below the zone (the page's dark edge) is not its line 2: both lines are the same height
  while (bands.length > 2 && 2 * (bands[bands.length - 1][1] - bands[bands.length - 1][0]) < bands[bands.length - 2][1] - bands[bands.length - 2][0]) bands.pop();
  if (bands.length < 2) return [];
  return bands.slice(-2).map(([s, e]) => {
    const m = Math.max(2, Math.floor((e - s) / 4)), ys = Math.max(0, s - m), ye = Math.min(ph, e + m);
    let x0 = w, x1 = -1;
    for (let y = ys; y < ye; y++) for (let x = 0; x < w; x++) if (bw[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (x1 < 0) { x0 = 0; x1 = w - m; }
    return { x: Math.max(0, x0 - m), y: top + ys, w: Math.min(w, x1 + m) - Math.max(0, x0 - m), h: ye - ys };
  });
}

/** A zone line's box → its width once scaled to MRZ_H high (at most MRZ_W). */
export const mrzLineWidth = (b: PxBox): number => Math.max(1, Math.min(MRZ_W, Math.round(b.w * MRZ_H / Math.max(1, b.h))));

/** The zone's two lines read → how many of line 2's check digits (number, birth, expiry) are right, or
 *  null when it is no zone: under two lines, or two lines at the foot of a page that is no passport (a
 *  ספח, a form) read as letters — no check digit right and line 1 not starting with P. */
export function mrzZone(lines: string[]): { line2: string; ok: number } | null {
  if (lines.length < 2) return null;
  const l2 = (lines[1] + '<'.repeat(44)).slice(0, 44);
  const ok = [[0, 9], [13, 19], [21, 27]].filter(([a, b]) => String(mrzCheck(l2.slice(a, b))) === l2[b]).length;
  if (!ok && !/^P/.test(lines[0])) return null;
  return { line2: lines[1], ok };
}

/** A Hebrew line as the reader writes it (as shown, right to left) → in writing order; numbers stay as read. */
export function heLogical(shown: string): string {
  if (!/[א-ת]/.test(shown)) return shown;
  let out = '', run = '';
  for (const c of [...shown].reverse()) {
    if (/[0-9]/.test(c) || (run && './-'.includes(c))) { run += c; continue; }
    if (run) { out += [...run].reverse().join(''); run = ''; }
    out += c;
  }
  return out + [...run].reverse().join('');
}

/** An Israeli ID number's check digit agrees (9 digits). */
export function heIdOk(s: string | null | undefined): boolean {
  const d = (s || '').replace(/\D/g, '');
  if (d.length !== 9) return false;
  let t = 0;
  for (let i = 0; i < 9; i++) { const v = +d[i] * (1 + i % 2); t += Math.floor(v / 10) + v % 10; }
  return t % 10 === 0;
}

/** A field box in shares of the card: [x, y, w, h]. */
export type HeBox = [number, number, number, number];
/** The card layouts (he-layouts.json): each layout's fields, a role and its box. */
export type HeLayouts = Record<string, { role: string; box: HeBox }[]>;
/** A card read by one layout. */
export interface HeRead { layout: string; idOk: boolean; surname?: string; given?: string; idNo?: string; dob?: string; expiry?: string; [role: string]: string | boolean | undefined }

/** A field's layout box grown by a share of its width on each side and of its height above and below: a corner a
 *  little off on the phone's cut, or a field running past its box, stays in (scripts/scan-train/hemodel.py MARGIN_X /
 *  MARGIN_Y, mirrored there and in gen/phone.py he_rect; synth_fields.py cuts the training fields the same way). */
export const HE_MX = 0.22, HE_MY = 0.7;
/** The part of a W×H card a field's box is read from (the HE_MX / HE_MY margin round it) and its width once scaled
 *  to MRZ_H high; null when it is too small. */
export function heLineBox(W: number, H: number, box: HeBox): { x0: number; y0: number; w: number; h: number; nw: number } | null {
  const [bx, by, bw, bh] = box;
  const x0 = Math.max(0, (bx - HE_MX * bw) * W), y0 = Math.max(0, (by - HE_MY * bh) * H);
  const x1 = Math.min(W, (bx + bw * (1 + HE_MX)) * W), y1 = Math.min(H, (by + bh * (1 + HE_MY)) * H);
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  return { x0, y0, w, h, nw: Math.max(1, Math.min(MRZ_W, Math.round(w * MRZ_H / h))) };
}

/** A page of w×h is shaped like an ID card (85.6 × 54 mm). */
export const heCardShape = (w: number, h: number): boolean => { const r = w / Math.max(1, h); return !(r < 1.35 || r > 1.85); };

/** How well a layout's read fits: the ID's check digit, the two dates, a Hebrew surname. */
export function heScore(got: HeRead): number {
  const isDate = (s: string | undefined) => /^\d{1,2}[./]\d{1,2}[./](19|20)\d\d$/.test(s || '');
  return (got.idOk ? 4 : 0) + (isDate(got.dob) ? 1 : 0) + (isDate(got.expiry) ? 1 : 0) + (/[א-ת]/.test(got.surname || '') ? 0.5 : 0);
}

/** The card's fields read by every layout (line: a field box → its text, in writing order), the best fitting
 *  layout kept (the first on a tie); {} when the page is no card or there is no layout. */
export async function heReadLayouts(w: number, h: number, layouts: HeLayouts, line: (box: HeBox) => Promise<string>): Promise<HeRead | Record<string, never>> {
  if (!heCardShape(w, h)) return {};
  let best: HeRead | null = null, bestScore = -1;
  for (const [layout, fields] of Object.entries(layouts)) {
    const got: HeRead = { layout, idOk: false };
    for (const fl of fields) got[fl.role] = await line(fl.box);
    got.idOk = heIdOk(got.idNo);
    const score = heScore(got);
    if (score > bestScore) { best = got; bestScore = score; }
  }
  return best || {};
}

// ── the runtime ──

/** The document type model's answer on a page: the kind, how sure, the clockwise quarter-turns it needs and
 *  how sure, the time, and the 256×256 copy it was given (the kind's training copy). */
export interface DoctypeAnswer { doctype: Doctype; conf: number; turn: number; turnConf: number; ms: number; square: OffscreenCanvas }

const ctx = (c: OffscreenCanvas): OffscreenCanvasRenderingContext2D =>
  c.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
const now = (): number => performance.now();

/** The on-device readers of a surface: the document type model (docs/scan-plan.md → S7), the passport zone
 *  reader (docs/hf-plan.md → H8b) and the Hebrew field reader with its card layouts (H8c) — each only when
 *  the surface's models.json says its version has it. */
export class Readers {
  info: ModelsInfo | null = null;
  doctype: OrtSession | null = null;
  mrz: OrtSession | null = null;
  he: OrtSession | null = null;
  layouts: HeLayouts | null = null;
  private ort: Ort | null = null;
  /** The document type model's runs, one after another (Auto's look and a shot's readouts can meet on its session). */
  private typeRuns: Promise<unknown> = Promise.resolve();
  private loading: Promise<ModelsInfo | null> | null = null;
  /** Bumped by release(): a load begun before it releases what it opens instead of keeping it. */
  private gen = 0;

  /** modelsInfo: where models.json comes from — the session's engines' one read per open (Engines.modelsInfo), so
   *  it is read once; unset: read here. */
  constructor(readonly surface: SurfaceRef, private log: (text: string) => void = () => {}, private cpuDir: OrtDir = CPU_ORT,
    private modelsInfo: () => Promise<ModelsInfo> = () => readModels(surface)) {}

  /** models.json read and the readers it names loaded (once); null when that failed (said in the log). */
  load(): Promise<ModelsInfo | null> {
    return this.loading || (this.loading = this.loadNow());
  }
  private async loadNow(): Promise<ModelsInfo | null> {
    const s = this.surface, g = this.gen;
    // a session opened after release(): released at once, the load ends
    const keep = (sess: OrtSession): OrtSession => {
      if (g === this.gen) return sess;
      sess.release().catch(() => {});
      throw new Error('the readers were released');
    };
    try {
      const t0 = now();
      const mj = await this.modelsInfo();
      if (g !== this.gen) return null;
      this.info = mj;
      // the readers' files (small) and the page's ONNX Runtime at once; their sessions one after the other
      const files = (name: string): Promise<Uint8Array> => {
        const p = fetchModel(s, name, () => {}, { stamp: modelStamp(mj, name), said: this.log });
        p.catch(() => {});  // its failure is the session's, below
        return p;
      };
      const bytes = { doctype: mj.doctype ? files('doctype.onnx') : null, mrz: mj.mrz ? files('mrz.onnx') : null, he: mj.he ? files('he.onnx') : null };
      const layoutsP = mj.he ? fetch(layoutsUrl(s), { cache: 'no-cache' }) : null;
      if (layoutsP) layoutsP.catch(() => {});
      const time = (what: string, t: number): void => this.log('Time: ' + what + ' — ' + Math.round(now() - t) + ' ms');
      let t1 = now();
      if (mj.doctype || mj.mrz || mj.he) { this.ort = await loadOrt(s, this.cpuDir); time('ONNX Runtime (' + this.cpuDir + ') loaded for readers', t1); }
      const ort = this.ort as Ort;
      t1 = now();
      if (bytes.doctype) { this.doctype = keep(await cpuSession(ort, s, 'doctype.onnx', bytes.doctype)); this.log('Document type model loaded'); time('document type model ready', t1); }
      t1 = now();
      if (bytes.mrz) { this.mrz = keep(await cpuSession(ort, s, 'mrz.onnx', bytes.mrz)); this.log('Passport zone reader loaded'); time('passport zone reader ready', t1); }
      t1 = now();
      if (bytes.he && layoutsP) {
        const lr = await layoutsP;
        if (lr.ok) { const layouts = await lr.json() as HeLayouts; this.he = keep(await cpuSession(ort, s, 'he.onnx', bytes.he)); this.layouts = layouts; this.log('Hebrew field reader loaded'); time('Hebrew field reader ready', t1); }
      }
      time('readers ready', t0);
      return mj;
    } catch (e) {
      if (g !== this.gen) return null;
      this.log('Document type model / passport zone reader / Hebrew field reader: ' + errText(e)); return this.info;
    }
  }

  /** Sessions given by hand (the lab's resampling probe, src/scan/lab/probe.ts: stand-ins that only keep the tensor
   *  each is given — no model runs, the scan's own readers are never touched). */
  use(ort: Ort, sessions: { doctype?: OrtSession | null; mrz?: OrtSession | null; he?: OrtSession | null }): this {
    this.ort = ort;
    this.doctype = sessions.doctype || null; this.mrz = sessions.mrz || null; this.he = sessions.he || null;
    return this;
  }

  /** Every reader's session released (the scanner closed: they live in the page's own ONNX Runtime heap, which
   *  never shrinks); a load still running releases what it opens; the next load() starts again. */
  release(): void {
    this.gen++;
    for (const sess of [this.doctype, this.mrz, this.he]) if (sess) { try { sess.release().catch(() => {}); } catch { /* gone already */ } }
    this.doctype = this.mrz = this.he = null; this.layouts = null; this.info = null; this.loading = null;
  }

  /** The document type model's answer on a page (a canvas or a loaded image), null with no model in this
   *  version. */
  async doctypeAnswer(src: Drawable | null): Promise<DoctypeAnswer | null> {
    if (!this.doctype || !this.ort || !src) return null;
    const sess = this.doctype, sq = mkCanvas(256, 256), g = ctx(sq); g.drawImage(src, 0, 0, 256, 256);
    const d = g.getImageData(0, 0, 256, 256).data, n = 256 * 256, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { f[i] = d[i * 4] / 255; f[n + i] = d[i * 4 + 1] / 255; f[2 * n + i] = d[i * 4 + 2] / 255; }
    const ort = this.ort, t0 = now(), run = this.typeRuns.then(() => sess.run({ [sess.inputNames[0]]: tensor(ort, f, [1, 3, 256, 256]) }));
    this.typeRuns = run.catch(() => {});
    const r = await run;
    const kp = Array.from(r.doctype.data), tp = Array.from(r.turn.data), k = kp.indexOf(Math.max(...kp)), t = tp.indexOf(Math.max(...tp));
    return { doctype: DOCTYPES[k], conf: kp[k], turn: t, turnConf: tp[t], ms: now() - t0, square: sq };
  }

  /** One line's box on the page read by a line reader (the zone's or the Hebrew one), as the lab draws it. */
  private async readLine(sess: OrtSession, page: Drawable, x: number, y: number, w: number, h: number, nw: number, chars: string): Promise<string> {
    const c = mkCanvas(MRZ_W, MRZ_H), g = ctx(c);
    g.fillStyle = '#fff'; g.fillRect(0, 0, MRZ_W, MRZ_H); g.imageSmoothingQuality = 'high';
    g.drawImage(page, x, y, w, h, 0, 0, nw, MRZ_H);
    const out = await sess.run({ [sess.inputNames[0]]: tensor(this.ort as Ort, lineInput(g.getImageData(0, 0, MRZ_W, MRZ_H).data), [1, 1, MRZ_H, MRZ_W]) });
    const lg = out[sess.outputNames[0]];
    return ctcDecode(lg.data, lg.dims, chars);
  }

  /** The passport zone's two lines read on a page: their text, [] when no zone was found, null with no reader. */
  async mrzRead(canvas: OffscreenCanvas | null): Promise<string[] | null> {
    if (!this.mrz || !canvas) return null;
    const w = canvas.width, h = canvas.height, top = mrzTop(h), lines: string[] = [];
    const boxes = w < 50 || h - top < 20 ? [] : mrzFind(grayPixels(ctx(canvas).getImageData(0, top, w, h - top)), w, h);
    for (const b of boxes) lines.push(await this.readLine(this.mrz, canvas, b.x, b.y, b.w, b.h, mrzLineWidth(b), MRZ_CHARS));
    return lines;
  }

  /** The Hebrew fields of a page shaped like an ID card, by the layout whose ID number's check digit agrees:
   *  {layout, surname, given, idNo, dob, expiry, idOk}, {} when the page is no card, null with no reader. */
  async heRead(canvas: OffscreenCanvas | null): Promise<HeRead | Record<string, never> | null> {
    const sess = this.he;
    if (!sess || !this.layouts || !canvas) return null;
    const W = canvas.width, H = canvas.height;
    return heReadLayouts(W, H, this.layouts, box => this.heLine(canvas, box));
  }

  /** One Hebrew field's line read on a card by its layout box (heLineBox's part of it), in writing order; '' when the
   *  box is too small or there is no reader. */
  async heLine(canvas: Drawable, box: HeBox): Promise<string> {
    const sess = this.he;
    if (!sess) return '';
    const b = heLineBox(canvas.width, canvas.height, box);
    return b ? heLogical((await this.readLine(sess, canvas, b.x0, b.y0, b.w, b.h, b.nw, HE_CHARS)).trim()) : '';
  }
}
