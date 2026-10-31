// The worker's documents to sign (docs/contracts.md → Signing, D3): read through the
// `sign_documents` function with the link's token — only this worker's own documents. Form 101
// and the contract are fetched at once and shown filled; one signature; the two signed PDFs are
// then built by two calls at once; afterwards the page keeps them to read and download. A signature whose documents are
// not built yet ('signing': the page was closed, or a build failed) is built again when the page opens, once, and by Try
// again: the server keeps one copy of each, and the state read afterwards says what happened.
import { getState, set, wpToken, type SignReq } from './core';

export const SIGN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/sign_documents';

export async function signFn<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(SIGN_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, token: wpToken() }) });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.ok) throw new Error((json && json.error) || 'HTTP ' + resp.status);
  return json as T;
}

/** Reads whether documents wait for this worker's signature (or were signed). Never throws. */
export async function loadSignState(): Promise<void> {
  if (!wpToken() || !navigator.onLine) return;
  try {
    const j = await signFn<{ request: SignReq | null }>({ action: 'mine' });
    set({ signReq: j.request });
    if (j.request?.status === 'signing' && builtFor !== j.request.id) await buildSigned();
  } catch { /* kept as it was */ }
}

let builtFor = '';
/** The two signed PDFs, built at once (a failure is read from the state afterwards: `buildError`). */
export async function buildSigned(): Promise<void> {
  builtFor = getState().signReq?.id || '';
  await Promise.allSettled(['form101', 'contract'].map(which => signFn({ action: 'build', which })));
  await loadSignState();
}

export type Viewed = { pdfBase64: string; name: string; signDate?: string; signed: boolean };
/** Both documents at once, Form 101 first. */
export const viewBoth = (): Promise<Viewed[]> => Promise.all(['form101', 'contract'].map(which => signFn<Viewed>({ action: 'view', which })));

/** The signature, then the two signed PDFs built at once. */
export async function signDocs(png: string): Promise<void> {
  await signFn({ action: 'sign', signaturePng: png });
  const cur = getState().signReq;
  if (cur) set({ signReq: { ...cur, status: 'signing' } });
  await buildSigned();
}

/** A PDF opened in a new tab (or downloaded when the browser blocks it). */
export function openPdf(b64: string, name: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── Another firm asks to take the worker's details (D6, functions/transfer.py) ──
const tr_ = (body: Record<string, unknown>) => signFn({ ...body, transfer: true });
/** Reads whether another firm asks for this worker. Never throws. */
export async function loadTransferState(): Promise<void> {
  if (!wpToken() || !navigator.onLine) return;
  try {
    const j = await tr_({ action: 'mine' }) as { transfer: import('./core').TransferReq | null };
    set({ transfer: j.transfer });
    if (j.transfer?.status === 'signing' && movedFor !== j.transfer.id) await buildTransfer();
  } catch { /* kept */ }
}

let movedFor = '';
/** The new firm's two PDFs, built at once; the copy follows. A failure is read from the state afterwards. */
export async function buildTransfer(): Promise<void> {
  movedFor = getState().transfer?.id || '';
  await Promise.allSettled(['form101', 'contract'].map(which => tr_({ action: 'build', which })));
  await loadTransferState();
}
export const viewTransfer = (): Promise<Viewed[]> => Promise.all(['form101', 'contract'].map(which => tr_({ action: 'view', which }) as Promise<Viewed>));
/** The consent and the signing in one: the signature, then the new firm's two PDFs — true once the copy is made. */
export async function signTransfer(png: string): Promise<boolean> {
  await tr_({ action: 'sign', signaturePng: png });
  await buildTransfer();
  return !getState().transfer;
}
export async function declineTransfer(): Promise<void> { await tr_({ action: 'decline' }); set({ transfer: null }); }
