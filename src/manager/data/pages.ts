// A worker's scanned pages and signature in Storage (docs/contracts.md → Scanned pages):
// each page its own JPEG (pages/, listed on the worker as `scanPages` with its kind and
// date, the ID card or passport first), the signature a small PNG (signature/,
// `sigFileId`, `sigSavedAt`). They replace the old sidecar — one JSON with the pictures
// inside (`assetsFileId`) — which is still read for a worker whose sidecar was not split
// into pages yet (scripts/migrate/scan_pages.py), and is dropped the next time the
// worker's pages are saved. Form 101's build, its rebuild and the field search read the
// pages through here.
import { API_URL, gsDeleteWorkerDoc, uploadWorkerFile } from './api';
import { gsAuth } from './session';
import { pageForStorage } from '../logic/uploads';
import type { ScanPage } from '../bridge';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;
export interface PageImg { b64: string; mediaType: string; kind?: string | null }
/** What Form 101 is built from: the first page (the ID card or passport), the other pages, the signature (a data URL). */
export interface StoredAssets { scanB64: string | null; scanMediaType: string | null; sigPng: string | null; extraPages: PageImg[] }

export const PAGE_KINDS: ScanPage['kind'][] = ['id_front', 'id_back', 'sefach', 'passport', 'other'];

/** A page's kind as stored: the scanner's kind when it is one of PAGE_KINDS; else the first page
 * is the worker's document (an ID card's front or a passport) and any other page is `other`. */
export function pageKind(kind: unknown, primary: boolean, docType?: string): ScanPage['kind'] {
  if ((PAGE_KINDS as unknown[]).includes(kind)) return kind as ScanPage['kind'];
  return primary ? (docType === 'passport' ? 'passport' : 'id_front') : 'other';
}

/** The worker has pages or a signature stored as files (not only the old sidecar). */
const hasPageFiles = (w: Rec) => (Array.isArray(w.scanPages) && w.scanPages.length > 0) || !!w.sigFileId;
/** The worker has something stored to build Form 101 from: pages, a signature, or the old sidecar. */
export const hasStoredAssets = (w: Rec | null | undefined): boolean => !!w && (hasPageFiles(w) || !!w.assetsFileId);

/** Every stored file of the worker's scan and signature (to delete with the worker). */
export function scanFileIds(w: Rec): string[] {
  return [...(w.scanPages || []).map((p: ScanPage) => p.fileId), w.sigFileId, w.assetsFileId].filter(Boolean);
}

const post = async (body: Rec) => (await fetch(API_URL, { method: 'POST', body: JSON.stringify({ ...body, ...gsAuth() }) })).json();

/** Reads the worker's stored pages and signature back in one call (users_admin loadWorkerPages),
 * or the old sidecar; null when nothing is stored or the read failed. */
export async function loadStoredAssets(w: Rec): Promise<StoredAssets | null> {
  if (hasPageFiles(w)) {
    const pages: ScanPage[] = w.scanPages || [];
    const ids = [...pages.map(p => p.fileId), ...(w.sigFileId ? [w.sigFileId] : [])];
    const j = await post({ action: 'loadWorkerPages', fileIds: ids });
    if (!j || !j.ok) return null;
    const got = new Map<string, Rec>((j.pages || []).map((p: Rec) => [p.fileId, p]));
    const img = (p: ScanPage): PageImg | null => { const g = got.get(p.fileId); return g ? { b64: g.b64, mediaType: g.mediaType, kind: p.kind } : null; };
    const first = pages.find(p => p.primary) || null;
    const front = first && img(first);
    const sig = w.sigFileId && got.get(w.sigFileId);
    return {
      scanB64: front ? front.b64 : null, scanMediaType: front ? front.mediaType : null,
      sigPng: sig ? 'data:image/png;base64,' + sig.b64 : null,
      extraPages: pages.filter(p => p !== first).map(img).filter((x): x is PageImg => !!x),
    };
  }
  if (w.assetsFileId) {
    const j = await post({ action: 'loadWorkerAssets', fileId: w.assetsFileId });
    if (!j || !j.ok) return null;
    return { scanB64: j.scanB64 || null, scanMediaType: j.scanMediaType || null, sigPng: j.sigPng || null,
      extraPages: Array.isArray(j.extraPages) ? j.extraPages : [] };
  }
  return null;
}

/** What a save keeps from what is already stored (it came from there unchanged). */
export interface Keep { front?: boolean; others?: boolean; sig?: boolean }
export interface SavedPages { scanPages: ScanPage[]; sigFileId?: string; sigSavedAt?: string }

/**
 * Stores the worker's pages and signature: every new page and the signature are uploaded at
 * once (each page shrunk to a JPEG of at most 2000 px, `pageForStorage`); a part `keep` names is
 * reused as it is stored. Once everything is up, the replaced files (and the old sidecar) are
 * deleted. → the fields to set on the worker, or null when an upload failed (the worker keeps
 * what it had; the new files already up are deleted).
 */
export async function saveScanPages(w: Rec, a: { front: PageImg | null; others: PageImg[]; sigPng: string | null },
  keep: Keep, onProgress?: (sent: number, total: number) => void): Promise<SavedPages | null> {
  const old: ScanPage[] = hasPageFiles(w) ? (w.scanPages || []) : [];
  const oldFront = old.find(p => p.primary) || null;
  const oldOthers = old.filter(p => p !== oldFront);
  // Reused only when they are stored as files (a worker still on the sidecar gets every part uploaded).
  const reuseFront = !!keep.front && !!oldFront;
  const reuseOthers = !!keep.others && hasPageFiles(w);
  const reuseSig = !!keep.sig && !!w.sigFileId;
  const now = new Date().toISOString();
  const sent: number[] = [], total: number[] = [];
  const progress = (i: number) => (l: number, t: number) => {
    sent[i] = l; total[i] = t;
    if (onProgress) onProgress(sent.reduce((x, y) => x + (y || 0), 0), total.reduce((x, y) => x + (y || 0), 0));
  };
  let n = 0;
  const upPage = async (p: PageImg, kind: ScanPage['kind'], index: number, primary: boolean): Promise<ScanPage> => {
    const img = await pageForStorage(p.b64, p.mediaType);
    const r = await uploadWorkerFile({ action: 'saveWorkerPage', workerId: w.id, fileBase64: img.b64, kind, index }, progress(n++));
    if (!r || !r.ok) throw new Error((r && r.error) || 'upload failed');
    return { fileId: r.id, kind, ...(primary ? { primary: true } : {}), savedAt: now };
  };
  const front: Promise<ScanPage | null> = reuseFront ? Promise.resolve(oldFront)
    : a.front ? upPage(a.front, pageKind(a.front.kind, true, w.docType), 0, true) : Promise.resolve(null);
  const others: Promise<ScanPage[]> = reuseOthers ? Promise.resolve(oldOthers)
    : Promise.all(a.others.map((p, i) => upPage(p, pageKind(p.kind, false), i + 1, false)));
  const sigData = a.sigPng ? String(a.sigPng).split(',').pop() || '' : '';
  const sig: Promise<{ id?: string; at?: string }> = reuseSig ? Promise.resolve({ id: w.sigFileId, at: w.sigSavedAt })
    : sigData ? uploadWorkerFile({ action: 'saveWorkerSignature', workerId: w.id, fileBase64: sigData }, progress(n++))
      .then(r => { if (!r || !r.ok) throw new Error((r && r.error) || 'upload failed'); return { id: r.id as string, at: now }; })
    : Promise.resolve({});
  const all = await Promise.allSettled([front, others, sig]);
  const fresh = (x: string | undefined) => !!x && !scanFileIds(w).includes(x);
  if (all.some(r => r.status === 'rejected')) {
    // what did get up is not kept
    const up: string[] = [];
    if (all[0].status === 'fulfilled' && all[0].value) up.push(all[0].value.fileId);
    if (all[1].status === 'fulfilled') up.push(...all[1].value.map(p => p.fileId));
    if (all[2].status === 'fulfilled' && all[2].value.id) up.push(all[2].value.id);
    up.filter(fresh).forEach(id => gsDeleteWorkerDoc(id));
    return null;
  }
  const f = (all[0] as PromiseFulfilledResult<ScanPage | null>).value;
  const o = (all[1] as PromiseFulfilledResult<ScanPage[]>).value;
  const s = (all[2] as PromiseFulfilledResult<{ id?: string; at?: string }>).value;
  const out: SavedPages = { scanPages: [...(f ? [f] : []), ...o], ...(s.id ? { sigFileId: s.id, sigSavedAt: s.at } : {}) };
  // the replaced files and the old sidecar go once the new ones are up
  const kept = new Set([...out.scanPages.map(p => p.fileId), out.sigFileId].filter(Boolean));
  scanFileIds(w).filter(id => !kept.has(id)).forEach(id => gsDeleteWorkerDoc(id));
  return out;
}

/** Sets what saveScanPages returned on the worker; the old sidecar's id goes. */
export function applySavedPages(w: Rec, s: SavedPages): void {
  w.scanPages = s.scanPages;
  if (s.sigFileId) { w.sigFileId = s.sigFileId; w.sigSavedAt = s.sigSavedAt; } else { delete w.sigFileId; delete w.sigSavedAt; }
  delete w.assetsFileId;
}
