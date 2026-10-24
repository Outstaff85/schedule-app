// The scanner's engine (docs/scan-plan.md → S9): picked files — ported from the lab's former plain page
// (pickedPictures, analyzePicture, pictureTimer, the file input's lanes):
//  - several photos and PDFs at once; a PDF is rendered page by page (pdf.js 3.11.174 from cdnjs through
//    src/lib/pdfjs.ts, scale 2 on a white ground); a file that is neither a photo nor a PDF is left out (logged);
//  - one picture (analyzePicture), no screen, on any engine: a white page with photos in it (a form's page, a
//    PDF, a screenshot) is cut into its photos first, each goes through on its own; a PDF page made on a
//    computer (white to its edges) is taken whole; else the first frame is checked like the others (a sure,
//    convex frame of a document's shape), then looked for as the next ones are (findNext), and only then the
//    whole picture; then the other documents on it (findNext, up to 4) and a document lying on one (findInside,
//    up to MAX_DOCS); each step's time and model runs (pictureTimer) go to the log;
//  - the pictures are worked on several threads at once (workPictures): lane 0 is the main engine (or its
//    capture thread), lane 1 the file thread, started when a pick has a second picture (Engines.growFiles); one
//    picture at most waits for a free lane, and no more pictures are worked ahead of the list than there are
//    lanes (the next ones are not even opened: memory); a picture whose thread
//    failed is worked again on the main engine; the pictures are shown strictly in the files' order, each as
//    soon as it and the ones before it are done.
import { loadPdfJs } from '@/lib/pdfjs';
import { MAX_DOCS, WHOLE_PAGE, docShape, goodQuad } from './geometry';
import type { Engine } from './engines';
import { smallRGBA } from './live';
import { photosOnPagePixels, photosSize, whiteEdgesPixels, EDGES_W } from './pictures';
import { findInside, findNext } from './shot';
import { mkCanvas, type Upright } from './upright';
import type { Pt, Quad } from './types';

type Ctx2D = OffscreenCanvasRenderingContext2D;
const ctx = (c: OffscreenCanvas, read = false): Ctx2D => c.getContext('2d', read ? { willReadFrequently: true } : undefined) as Ctx2D;
const errText = (e: unknown): string => String((e as Error)?.message || e);

/** A picked file (a File; the tests give stand-ins). */
export interface PickFile { name?: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }

/** One picture of a pick: its url (an object URL for a photo, a JPEG data URL for a PDF page), which file and
 *  page it is (1-based; a photo is page 1 of 1), whether it is a PDF page, and the lab's words for it. */
export interface PickedPicture { url: string; file: number; files: number; page: number; pages: number; pdfPage: boolean; tag: string }

/** What picking takes of the browser (the tests give stand-ins). */
export interface FilesEnv {
  objectUrl(f: PickFile): string;
  /** A PDF's pages, rendered: each a JPEG data URL. */
  pdfPages(data: ArrayBuffer): AsyncIterable<{ url: string; page: number; pages: number }>;
  /** A picture's url → its pixels on a canvas. */
  decode(url: string): Promise<OffscreenCanvas>;
}

interface PdfJs {
  getDocument(src: { data: ArrayBuffer }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> } }> }> };
}

async function* renderPdf(data: ArrayBuffer): AsyncIterable<{ url: string; page: number; pages: number }> {
  await loadPdfJs();
  const lib = (window as unknown as { pdfjsLib: PdfJs }).pdfjsLib;
  const pdf = await lib.getDocument({ data }).promise;
  for (let n = 1; n <= pdf.numPages; n++) {
    const pg = await pdf.getPage(n), vp = pg.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const g = c.getContext('2d') as CanvasRenderingContext2D; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp }).promise;
    yield { url: c.toDataURL('image/jpeg', 0.92), page: n, pages: pdf.numPages };
  }
}

async function decodeUrl(url: string): Promise<OffscreenCanvas> {
  const img = new Image(); img.src = url; await img.decode();
  const c = mkCanvas(img.naturalWidth, img.naturalHeight); ctx(c).drawImage(img, 0, 0);
  return c;
}

export function defaultFilesEnv(): FilesEnv {
  return { objectUrl: f => URL.createObjectURL(f as unknown as Blob), pdfPages: renderPdf, decode: decodeUrl };
}

export const isPdf = (f: PickFile): boolean => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
export const isPhoto = (f: PickFile): boolean => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name || '');

/** The pictures of the picked files, one at a time, in the files' order — a PDF's pages as JPEGs. */
export async function* pickedPictures(files: PickFile[], env: FilesEnv, log: (t: string) => void): AsyncGenerator<PickedPicture> {
  for (let i = 0; i < files.length; i++) {
    const f = files[i], tag = 'file ' + (i + 1) + ' of ' + files.length;
    if (!isPdf(f) && !isPhoto(f)) { log('Not a photo or a PDF, left out: ' + (f.name || f.type)); continue; }
    if (!isPdf(f)) { yield { url: env.objectUrl(f), file: i + 1, files: files.length, page: 1, pages: 1, pdfPage: false, tag }; continue; }
    for await (const p of env.pdfPages(await f.arrayBuffer())) {
      yield { url: p.url, file: i + 1, files: files.length, page: p.page, pages: p.pages, pdfPage: true, tag: tag + ', page ' + p.page + ' of ' + p.pages };
    }
  }
}

/** A canvas scaled to w×h → its pixels. */
function scaledPixels(src: OffscreenCanvas, w: number, h: number): ImageData {
  const c = mkCanvas(w, h), g = ctx(c, true); g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}
/** The photos on a picture (boxes in its pixels); [] when it is no white page with photos. */
export function photosOnCanvas(page: OffscreenCanvas): [number, number, number, number][] {
  const { w, h } = photosSize(page.width, page.height);
  return photosOnPagePixels(scaledPixels(page, w, h), page.width, page.height);
}
/** A picture is white to its edges (a page made on a computer). */
export function whiteEdgesCanvas(page: OffscreenCanvas): boolean {
  return whiteEdgesPixels(scaledPixels(page, EDGES_W, Math.max(1, Math.round(EDGES_W * page.height / page.width))));
}

/** Where a picture's time goes (owner, 2026-10-24: one photo took 4.4 s): each step's time and model runs. */
export function pictureTimer(eng: Engine, now: () => number): { eng: Engine; at(name: string): void; text(): string } {
  const steps = new Map<string, { ms: number; runs: number }>(); let step = 'open', t = now();
  const at = (name: string): void => { const n = now(), x = steps.get(step) || { ms: 0, runs: 0 }; x.ms += n - t; steps.set(step, x); step = name; t = n; };
  const runs = (): void => { const x = steps.get(step) || { ms: 0, runs: 0 }; x.runs++; steps.set(step, x); };
  const timed: Engine = { hasCap: () => eng.hasCap(), detect: (which, input) => { runs(); return eng.detect(which, input); }, warp: (...a) => eng.warp(...a), stop: () => eng.stop() };
  const text = (): string => {
    at(step);
    let all = 0; const parts: string[] = [];
    for (const [name, x] of steps) { all += x.ms; if (x.ms >= 1) parts.push(name + ' ' + Math.round(x.ms) + (x.runs ? ' (' + x.runs + (x.runs > 1 ? ' runs' : ' run') + ')' : '')); }
    return parts.join('; ') + '; all ' + Math.round(all);
  };
  return { eng: timed, at, text };
}

/** One document on a picture part: its corners on the part and its cut, upright. */
export interface PictureDoc { pts: Quad; out: Upright }
/** A part of a picture: a photo cut out of a white page, or the picture itself; whole — a page made on a
 *  computer taken as it is (no corners of the model); onPicture maps the part's shares onto the picture's. */
export interface PicturePart { frame: OffscreenCanvas; w: number; h: number; whole: boolean; docs: PictureDoc[]; onPicture(q: Quad): Quad }
export interface Picture { parts: PicturePart[]; timing: string }
export type PictureStage = 'finding' | 'cutting';
export type StepFn = (stage: PictureStage, q: Quad | null) => void;

/** One picture on one engine, no screen (see the head of this file). */
export async function analyzePicture(url: string, pdfPage: boolean, eng0: Engine, onStep: StepFn, env: { decode(url: string): Promise<OffscreenCanvas>; log(t: string): void; now(): number }): Promise<Picture> {
  const tm = pictureTimer(eng0, env.now), eng = tm.eng;
  const page = await env.decode(url);
  const boxes = photosOnCanvas(page), parts: PicturePart[] = [];
  if (boxes.length) env.log('Photos inside a white page: ' + boxes.map(b => (b[2] - b[0]) + '×' + (b[3] - b[1]) + ' at ' + b[0] + ',' + b[1]).join('; ') + ' of ' + page.width + '×' + page.height);
  for (const box of boxes.length ? boxes : [null]) {
    let frame = page;
    if (box) { const [x0, y0, x1, y1] = box; frame = mkCanvas(x1 - x0, y1 - y0); ctx(frame).drawImage(page, x0, y0, frame.width, frame.height, 0, 0, frame.width, frame.height); }
    const w = frame.width, h = frame.height, pix = ctx(frame, true).getImageData(0, 0, w, h).data;
    const whole = pdfPage && !box && whiteEdgesCanvas(page);
    let first: Quad = WHOLE_PAGE;
    // a frame found, in the whole picture's shares (a photo cut out of a white page lies at its box)
    const onPicture = (q: Quad): Quad => q.map(([x, y]) => (box ? [(box[0] + x * w) / page.width, (box[1] + y * h) / page.height] : [x, y]) as Pt);
    onStep('finding', null);
    tm.at('first document');
    // the first frame is checked like the others (a sure, convex frame of a document's shape); none such:
    // looked for again as the next ones are, and only then the whole picture (its corners fixed by hand)
    if (!whole) {
      const { res } = await eng.detect(eng.hasCap() ? 'cap' : 'live', { rgba: smallRGBA(frame, w, h) });
      if (goodQuad(res) && docShape(res.pts, w, h)) first = res.pts;
      else { const q = await findNext(frame, w, h, [], eng); if (q) first = q; else env.log('No document frame found on a picked picture — the whole picture taken'); }
    }
    onStep('cutting', onPicture(first));
    tm.at('cut and upright turn');
    const docs: PictureDoc[] = [{ pts: first, out: await eng.warp(pix.slice(), w, h, first, true) }];
    if (!whole) {
      const found: Quad[] = [first];
      for (let n = 1; n < 4; n++) {
        tm.at('looking for more');
        const q = await findNext(frame, w, h, found, eng);
        if (!q) break;
        onStep('cutting', onPicture(q));
        tm.at('cut and upright turn');
        found.push(q); docs.push({ pts: q, out: await eng.warp(pix.slice(), w, h, q, true) });
      }
      // a document lying on one found (an ID card on its ספח)
      for (const q of found.slice()) {
        if (found.length >= MAX_DOCS) break;
        tm.at('a document lying on one');
        const c = await findInside(pix, w, h, q, eng, found);
        if (c) { onStep('cutting', onPicture(c)); tm.at('cut and upright turn'); found.push(c); docs.push({ pts: c, out: await eng.warp(pix.slice(), w, h, c, true) }); }
      }
    }
    parts.push({ frame, w, h, whole, docs, onPicture });
    tm.at('open');
  }
  return { parts, timing: tm.text() };
}

/** An engine and how the log names it. */
export type LaneEngine = Engine & { label?: string };

/** What working a pick's pictures needs of the session. */
export interface LaneCtx {
  /** Lane k's engine: 0 the main engine (or its capture thread), k the file thread k (the main engine when that
   *  one failed). */
  engineOf(lane: number): Promise<LaneEngine>;
  /** Start the file thread (called with the second picture); addLane(k) when it is up. */
  growFiles(addLane: (lane: number) => void): void;
  analyze(pic: PickedPicture, eng: Engine, onStep: StepFn): Promise<Picture>;
  /** What is being done on the picture that goes on the list next (n, 1-based). */
  step(n: number, pic: PickedPicture, stage: PictureStage, q: Quad | null): void;
  /** A worked picture onto the list, in the files' order. */
  show(n: number, pic: PickedPicture, picture: Picture): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(t: string): void;
  err(t: string): void;
}

/** The pictures worked on the lanes and shown in order (see the head of this file): how many, on how many
 *  lanes, whether a picture could not be worked on (the ones after it are not shown) or a file not opened. */
export async function workPictures(pics: AsyncIterable<PickedPicture>, c: LaneCtx): Promise<{ count: number; lanes: number; failed: boolean; openFailed: boolean }> {
  const free: number[] = [0], waiting: ((k: number) => void)[] = [], lanes = new Set<number>([0]);
  const take = (): Promise<number> => (free.length ? Promise.resolve(free.shift() as number) : new Promise(r => waiting.push(r)));
  const give = (k: number): void => { const r = waiting.shift(); if (r) r(k); else free.push(k); };
  const addLane = (k: number): void => { if (!lanes.has(k)) { lanes.add(k); give(k); } };
  let next = 1;
  const stepOf = (n: number, pic: PickedPicture): StepFn => (stage, q) => { if (n === next) c.step(n, pic, stage, q); };
  const work = async (pic: PickedPicture, step: StepFn): Promise<Picture> => {
    const k = await take();
    try {
      const eng = await c.engineOf(k);
      try { return await c.analyze(pic, eng, step); }
      catch (err) {
        c.log('Picked file on ' + (eng.label || 'the main thread') + ': ' + errText(err) + ' — again on the main thread');
        return await c.analyze(pic, await c.engineOf(0), step);
      }
    } finally { give(k); }
  };
  let order: Promise<void> = Promise.resolve(), n = 0, failed = false, openFailed = false;
  try {
    for await (const pic of pics) {
      const k = ++n;
      if (k === 2) c.growFiles(addLane);
      const done = work(pic, stepOf(k, pic));
      done.catch(() => {});
      // shown in the files' order, each as soon as it and the ones before it are done
      order = order.then(async () => {
        if (failed) return;
        try { await c.show(k, pic, await done); next = k + 1; }
        catch (err) { failed = true; c.err('Picked file ' + k + ': ' + errText(err)); }
      });
      // one picture at most waiting for a free lane, and no more pictures worked ahead of the list than there are
      // lanes (the next ones are not even opened yet: a worked picture holds its photo and its cut pages)
      while (!failed && (waiting.length || k - (next - 1) > lanes.size)) await c.sleep(20);
    }
  } catch (err) { openFailed = true; c.err('Picked file: ' + errText(err)); }
  await order;
  return { count: n, lanes: lanes.size, failed, openFailed };
}
