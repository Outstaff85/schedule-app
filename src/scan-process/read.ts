// The scan process (docs/scan.md → Reading): the pages the scanner hands over — cut,
// enhanced, most of them upright and with their kind — are read into one record.
//   1. A page with no face and no kind asks Haiku for its turn and kind (detect).
//   2. Page 1's full read starts at once (aiReadDoc), its digits and text re-read zoomed;
//      as soon as it is known to be an ID card or passport, the following pages' reads
//      (the ספח in two halves) start too, in the background.
//   3. The pages are merged strictly in page order (merge.ts): the first page read as an
//      ID card or passport is the primary, every later one only fills what it lacks.
// Independent requests start at once and the code waits only where a step needs a result
// (docs/backend.md → Parallel AI calls); sending them in parallel changes the time, never
// the number of AI calls. Every read is kept by the page's image (cache): a scan read
// again after pages were added, removed or re-cut reads only the pages that changed.
import { tr } from '@/lib/i18n';
import { extraReadWanted, initPrimary, isNonIdKind, mergePage } from './merge';
import { verifyDigitFields, verifyIdChecksum } from './verify';
import type { Box, Img, Job, Rec, Verifier } from './types';

/** mrz: the passport zone reader's lines on the page (the scanner's; only kept for its shadow — session.ts). */
export type InPage = Img & { kind: string | null; upright: boolean; mrz?: string[] };
export type OutPage = Img & {
  kind: string | null;
  /** the page's own read (the primary's: its verified read), null when not read */
  read: Rec | null;
  primary: boolean;
  /** a page the AI calls a contract that reads as no ID page: the worker's contract */
  contract: boolean;
};
export type ReadResult = { record: Rec | null; pages: OutPage[] };
export type Deps = {
  readDoc: (img: Img) => Promise<Rec | null>;
  extraPageReader: (kind: string | null) => ((img: Img) => Promise<Rec | null>) | null;
  verifierFor: (img: Img) => Verifier;
  verifyOneFor: (img: Img) => (box: Box, kind: Job['kind']) => Promise<string | null>;
  /** Haiku's kind and turn of a page; the page turned upright. */
  detect: (img: Img) => Promise<{ kind: string | null; img: Img }>;
  /** progress: a text (translated) and a percentage */
  progress?: (label: string, pct: number) => void;
  timing?: (ms: number, extra: Rec) => void;
};
export type Cache = Map<string, Promise<unknown>>;

/** A short fingerprint of a page's image, the cache key. */
export function imageKey(img: Img): string {
  let h = 0x811c9dc5;
  const s = img.b64;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + s.length;
}
const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
/** The cached result of `make` for this page and step, a fresh copy for every use (the
 * merge must never change a cached read). A failed step is not kept. */
function cached<T>(cache: Cache, img: Img, step: string, make: () => Promise<T>): Promise<T> {
  const k = imageKey(img) + ':' + step;
  let p = cache.get(k) as Promise<T> | undefined;
  if (!p) {
    p = make();
    cache.set(k, p);
    p.catch(() => cache.delete(k));
  }
  return p.then(clone);
}

export async function readPages(input: InPage[], deps: Deps, cache: Cache = new Map()): Promise<ReadResult> {
  const t0 = Date.now(), total = input.length;
  const tm = { primaryReadMs: 0, verifyMs: 0, extraWaitMs: 0 };
  const progress = deps.progress || (() => {});
  if (!total) return { record: null, pages: [] };

  // 1. a page with no face and no kind: Haiku's turn and kind (all such pages at once)
  let turned = 0;
  const prepared: Promise<InPage>[] = input.map(q => q.upright ? Promise.resolve(q) : cached(cache, q, 'detect', () => deps.detect(q))
    .then(d => { turned++; progress(tr('Straightening the pages… ({0} of {1})', { 0: turned, 1: total }), 5); return { ...d.img, kind: q.kind || d.kind, upright: true }; })
    .catch(() => q));

  const readDoc = (img: Img) => cached(cache, img, 'doc', async () => { const rs = Date.now(); const p = await deps.readDoc(img); tm.primaryReadMs += Date.now() - rs; return p; });
  // the primary's read, its zoomed re-reads and check digit — one cached step per image
  const verified = (img: Img) => cached(cache, img, 'primary', async () => {
    const p = await readDoc(img);
    if (!(p && (p.type === 'israeli_id' || p.type === 'passport'))) return null;
    const vs = Date.now();
    let v = p.fieldBoxes ? await verifyDigitFields(p, deps.verifierFor(img)) : p;
    v = await verifyIdChecksum(v, deps.verifyOneFor(img));
    tm.verifyMs += Date.now() - vs;
    return v;
  });
  const extraRead = (img: Img, kind: string | null) => {
    const rd = deps.extraPageReader(kind);
    return rd ? cached(cache, img, 'extra:' + (kind === 'id_front' ? 'front' : 'sefach'), () => rd(img)) : Promise.resolve(null);
  };

  // 2. page 1's read starts as soon as it is upright
  const first = await prepared[0];
  const earlyRead = isNonIdKind(first.kind) ? null : readDoc(first);
  earlyRead?.catch(() => {});
  const pages = await Promise.all(prepared);
  // the following pages' reads: started as soon as the primary's read says which are wanted
  const extraReads = new Map<number, Promise<Rec | null>>();
  const prefetchFrom = (start: number, p: Rec) => {
    for (let j = start; j < pages.length; j++) {
      if (!extraReadWanted(p, pages[j].kind) || extraReads.has(j) || !deps.extraPageReader(pages[j].kind)) continue;
      extraReads.set(j, extraRead(pages[j], pages[j].kind));
    }
  };
  if (earlyRead && pages.length > 1) earlyRead.then(p => { if (p && (p.type === 'israeli_id' || p.type === 'passport')) prefetchFrom(1, p); }).catch(() => {});

  // 3. in page order
  let record: Rec | null = null;
  const out: OutPage[] = [];
  const readPct = (i: number) => Math.round(40 + 50 * (i + 1) / pages.length);
  for (let i = 0; i < pages.length; i++) {
    const it: Img = { b64: pages[i].b64, mediaType: pages[i].mediaType }, kind = pages[i].kind;
    let read: Rec | null = null;
    if (!record && !isNonIdKind(kind)) {
      progress(tr('Reading the document… (page {0} of {1})', { 0: i + 1, 1: total }), Math.max(45, readPct(i) - 30));
      try {
        const p = await readDoc(it);
        if (p && (p.type === 'israeli_id' || p.type === 'passport')) {
          prefetchFrom(i + 1, p);
          if (p.fieldBoxes) progress(tr('Checking the digits again… (page {0} of {1})', { 0: i + 1, 1: total }), Math.max(55, readPct(i) - 20));
          const v = await verified(it);
          if (v) {
            record = initPrimary(v);
            out.push({ ...it, kind, read: v, primary: true, contract: false });
            continue;
          }
        }
      } catch (e) { console.error(e); }
    } else if (extraReadWanted(record, kind)) {
      progress(tr('Reading the appendix… (page {0} of {1})', { 0: i + 1, 1: total }), Math.max(60, readPct(i) - 10));
      const ws = Date.now();
      const p = extraReads.has(i) ? await extraReads.get(i)! : await extraRead(it, kind);
      tm.extraWaitMs += Date.now() - ws;
      if (p && p.type === 'israeli_id') { record = mergePage(record!, p); read = p; }
    }
    const idLike = read && (read.idNo || read.surname || read.given);
    out.push({ ...it, kind, read, primary: false, contract: kind === 'contract' && !idLike });
  }
  progress(tr('All pages read'), 100);
  deps.timing?.(Date.now() - t0, { pages: total, kinds: pages.map(x => x.kind || '?'), ...tm,
    docType: (record && record.type) || '', ...(record ? {} : { aborted: 'no-document' }) });
  return { record, pages: out };
}
