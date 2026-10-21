// The scan of this session (docs/scan.md → Reading): the scanner's pages read into one
// record, kept in memory until the worker is saved. "Scan again" from the worker window
// opens the scanner with these pages already in it; Done reads only what changed (the
// reads are kept by the pages' images). The page's Form 101 reads the stored pages from
// window.__aiScanImage (the primary) and window.__aiPacketOtherPages (the rest).
import { detectDoctype, rotateImage } from '@/scan/doctype';
import { reportTiming } from '@/manager/data/telemetry';
import { extraPageReader, readDoc, verifierFor, verifyOneFor } from './ai';
import { readPages, type Cache, type Deps, type InPage, type OutPage } from './read';
import { workerFields } from './worker';
import { mrzFields, parseMrz } from './mrz';
import type { Rec } from './types';

let cache: Cache = new Map();
let last: OutPage[] = [];
let lastRead: { record: Rec; reads: (Rec | null)[] } | null = null;
/** the passport zone reader's lines on the primary page (docs/hf-plan.md → H8b), null when it did not read it */
let lastZone: string[] | null = null;

const deps = (progress: (label: string, pct: number) => void): Deps => ({
  readDoc, extraPageReader, verifierFor, verifyOneFor, progress,
  detect: async img => {
    const { kind, rotate } = await detectDoctype(img.b64, img.mediaType);
    if (!rotate) return { kind, img };
    try { return { kind, img: { b64: await rotateImage(img.b64, img.mediaType, rotate), mediaType: 'image/jpeg' } }; }
    catch { return { kind, img }; }
  },
  timing: (ms, extra) => reportTiming('scan', ms, extra),
});

/** Reads the pages; stores them for Form 101. → the record, or null when no page reads
 * as an ID card or passport (nothing is stored then). */
export async function readScan(pages: InPage[], progress: (label: string, pct: number) => void): Promise<{ record: Rec; reads: (Rec | null)[] } | null> {
  const res = await readPages(pages, deps(progress), cache);
  if (!res.record) return null;
  last = res.pages;
  // the pages come out in the order they went in: the primary's zone lines, when the reader read it
  const zone = pages[res.pages.findIndex(p => p.primary)]?.mrz;
  lastZone = Array.isArray(zone) ? zone : null;
  lastRead = { record: res.record, reads: res.pages.filter(p => !p.primary).map(p => p.read) };
  const front = res.pages.find(p => p.primary)!;
  window.__aiScanImage = { b64: front.b64, mediaType: front.mediaType, kind: front.kind };
  window.__aiPacketOtherPages = res.pages.filter(p => !p.primary).map(p => ({ b64: p.b64, mediaType: p.mediaType, kind: p.kind, contract: p.contract }));
  return { record: res.record, reads: res.pages.filter(p => !p.primary).map(p => p.read) };
}

/** The pages of this session's scan, primary first — the scanner's starting pages for "Scan again". */
export function sessionPages(): { b64: string; mediaType: string; kind: string | null }[] {
  if (!window.__aiScanImage) return [];
  return [...last.filter(p => p.primary), ...last.filter(p => !p.primary)].map(p => ({ b64: p.b64, mediaType: p.mediaType, kind: p.kind }));
}

/** A new scan: the reads of the last one are forgotten. */
export function resetScan(): void {
  cache = new Map(); last = []; lastRead = null; lastZone = null;
  window.__aiScanImage = null;
  window.__aiPacketOtherPages = [];
}

/** This session's scan as a full document for the field reader model (docs/hf-plan.md → H8a):
 * its pages, the AI's read, the fields the scan filled and the ones saved; null when no scan is in memory. */
export function scanDocument(saved: Rec): { pages: { b64: string; mediaType: string; doctype: string | null; primary: boolean }[];
  read: Rec; reads: (Rec | null)[]; scanned: Rec; saved: Rec; mrzShadow?: Rec } | null {
  if (!lastRead || !window.__aiScanImage) return null;
  // the document's own pages only: a contract (or a page that is no document) is not collected
  const pages = [...last.filter(p => p.primary), ...last.filter(p => !p.primary && !p.contract && p.kind !== 'contract' && p.kind !== 'other')]
    .map(p => ({ b64: p.b64, mediaType: p.mediaType, doctype: p.kind, primary: !!p.primary }));
  // the reads keep their fieldBoxes: where each field is on the page is what a field reader learns from too
  // the passport zone reader in shadow (H8b): what it read on the primary page, beside the AI's — never used for the worker
  const mrzShadow = lastZone ? { lines: lastZone, ...(mrzFields(parseMrz(lastZone.join('\n'))) || {}) } : null;
  return { pages, read: lastRead.record, reads: lastRead.reads, scanned: workerFields(lastRead.record, lastRead.reads), saved,
    ...(mrzShadow ? { mrzShadow } : {}) };
}
