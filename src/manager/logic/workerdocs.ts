// The worker's documents built on request — the manager app's side of the `worker_docs` function
// (functions/workerdocs.py; docs/workers.md → Download data): the call with the login's ID token, the PDF
// answered raw (application/pdf) with what it holds in its headers, an error as JSON. Never draws.
import { gsAuth } from '../data/session';
import { loadFirestoreBackend } from '../data/api';
import { WORKER_DOCS_FN_URL } from './functions';

/** The parts the Download data picker offers; the summary page is always first and has no tick. */
export type DownloadPart = 'form101' | 'contract' | 'scans' | 'docs';
export type DownloadInclude = Record<DownloadPart, boolean>;
export const DOWNLOAD_PARTS: DownloadPart[] = ['form101', 'contract', 'scans', 'docs'];
/** The default ticks (owner, 2026-10-25): Form 101 and the ID sheet; the contract and the other documents not. */
export const DEFAULT_INCLUDE: DownloadInclude = { form101: true, contract: false, scans: true, docs: false };

/** A built PDF and what its headers say: its pages, its parts in order (summary, form101-preview / form101-signed,
 * contract, id-sheet, scan, doc), the pictures that could not be placed, what was left out (a contract that may
 * hold pay, for a login that does not see pay). */
export type WorkerPdf = { blob: Blob; name: string; pages: number; parts: string[]; dropped: number; withheld: string[] };

const list = (v: string | null) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export async function workerDocsCall(body: Record<string, unknown>): Promise<WorkerPdf> {
  const idToken = await (await loadFirestoreBackend()).idToken();
  const resp = await fetch(WORKER_DOCS_FN_URL, {
    method: 'POST',
    headers: idToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken } : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...gsAuth(), ...body }),
  });
  if (!resp.ok || !/application\/pdf/.test(resp.headers.get('Content-Type') || '')) {
    const json = await resp.json().catch(() => null);
    throw new Error((json && json.error) || 'HTTP ' + resp.status);
  }
  let name = 'data.pdf';
  try { name = decodeURIComponent(resp.headers.get('X-Name') || '') || name; } catch { /* the default name */ }
  return {
    blob: await resp.blob(), name,
    pages: Number(resp.headers.get('X-Pages') || 0), parts: list(resp.headers.get('X-Parts')),
    dropped: Number(resp.headers.get('X-Dropped') || 0), withheld: list(resp.headers.get('X-Withheld')),
  };
}

const PICKS_KEY = 'downloadDataPicks';
/** The last choice of the picker on this device (a per-viewer convenience: an empty or blocked storage gives the default). */
export function storedInclude(): DownloadInclude {
  try {
    const v = JSON.parse(localStorage.getItem(PICKS_KEY) || 'null');
    if (v && typeof v === 'object') return Object.fromEntries(DOWNLOAD_PARTS.map(k => [k, typeof v[k] === 'boolean' ? v[k] : DEFAULT_INCLUDE[k]])) as DownloadInclude;
  } catch { /* the default */ }
  return { ...DEFAULT_INCLUDE };
}
export function storeInclude(v: DownloadInclude): void {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(v)); } catch { /* not kept: the default next time */ }
}
