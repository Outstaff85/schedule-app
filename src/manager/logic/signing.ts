// One signature for Form 101 and the contract — the manager app's side (docs/contracts.md →
// Signing, D3): the calls to the `sign_documents` function (functions/signing.py) with the
// login's ID token, the firm's requests kept in memory (Sent to sign / Signed on the worker),
// and the signed PDFs taken onto the worker record once: Form 101 as the worker's document
// (`docUrl`), the contract into `docs` (signed), the signature, the date — the replaced
// signed documents' files kept (docs/contracts.md → Signed files are kept). Never draws: it emits events.
import { state, type Rec } from '../data/state';
import { emit } from '../data/events';
import { autoSave } from '../data/store';
import { loadFirestoreBackend } from '../data/api';
import { gsAuth } from '../data/session';
import { SIGN_FN_URL } from './functions';

export type SignRequest = {
  id: string; workerId: string; status: 'sent' | 'signing' | 'signed' | 'replaced' | 'withdrawn'; way?: string;
  templateId?: string; templateName?: string; templateVersion?: number; signDate?: string | null; dateFixed?: boolean;
  sentAt?: string; signedAt?: string; signedAtIso?: string; sigPath?: string; appliedAt?: string; printHash?: string; printPay?: boolean; printMarks?: string[];
  /** why a document could not be built after the signature (the server's text) */
  buildError?: string | null;
  parts?: Record<'form101' | 'contract', { path: string; name: string; size: number }>;
};

/** How long a signature may wait for its documents with no error: signing.STUCK_AFTER_S in functions/signing.py. */
const STUCK_AFTER_MS = 10 * 60e3;
/** A signature nobody is finishing: its build failed, or it has been waiting for longer than any build takes. */
export function isStuck(r: Pick<SignRequest, 'status' | 'buildError' | 'signedAtIso'> | null | undefined): boolean {
  if (!r || r.status !== 'signing') return false;
  // a date that cannot be read counts as stuck, as on the server
  return !!r.buildError || !(Date.now() - Date.parse(r.signedAtIso || '') <= STUCK_AFTER_MS);
}

/** A worker who signed (a request taken on, or an older signing / a move from another firm). */
export function isSignedWorker(w: Rec | null | undefined): boolean {
  return !!(w && (w.signedAt || w.signedRequestId));
}

export async function signCall<T = Rec>(body: Rec): Promise<T> {
  const idToken = await (await loadFirestoreBackend()).idToken();
  const resp = await fetch(SIGN_FN_URL, {
    method: 'POST',
    headers: idToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken } : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...gsAuth(), ...body }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.ok) throw new Error((json && json.error) || 'HTTP ' + resp.status);
  return json as T;
}

let reqs: SignRequest[] = [], at = 0, busy: Promise<void> | null = null;
/** The worker's latest request (not replaced), or null. */
export function signRequestOf(workerId: string): SignRequest | null {
  return reqs.filter(r => r.workerId === workerId && r.status !== 'replaced')
    .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))[0] || null;
}

/** Reads the firm's requests (at most once a minute — or once in `maxAge` ms — unless forced) and takes the signed
 * ones onto the workers. A forced read while another is on its way reads again after it: the one on its way may
 * have left before what the caller waits for (a signing just built) was there. */
export function loadSignRequests(force?: boolean, maxAge = 60e3): Promise<void> {
  if (busy) return force ? busy.then(() => loadSignRequests(true)) : busy;
  if (!force && Date.now() - at < maxAge) return Promise.resolve();
  at = Date.now();
  busy = (async () => {
    try {
      const j = await signCall<{ requests: SignRequest[] }>({ action: 'list' });
      reqs = j.requests || [];
      await adoptSigned();
      emit('requests');
    } catch { /* kept as it was: no network, or a login without workers */ }
    finally { busy = null; }
  })();
  return busy;
}

/** A sent request, known at once (the list is read again later). */
export function rememberRequest(r: SignRequest): void {
  reqs = [r, ...reqs.filter(x => x.id !== r.id).map(x => (x.workerId === r.workerId && x.status === 'sent' ? { ...x, status: 'replaced' as const } : x))];
  emit('requests');
}

async function adoptSigned(): Promise<void> {
  const todo = reqs.filter(r => r.status === 'signed' && !r.appliedAt && r.parts?.form101 && r.parts?.contract);
  if (!todo.length) return;
  const b = await loadFirestoreBackend();
  let changed = false;
  for (const r of todo) {
    const w = state.workers.find(x => x.id === r.workerId);
    if (!w) continue;
    if (w.signedRequestId !== r.id) {
      const [u101, uC] = await Promise.all([b.storageUrl(r.parts!.form101.path), b.storageUrl(r.parts!.contract.path)]);
      const now = new Date().toISOString();
      w.docUrl = u101; w.docFileId = r.parts!.form101.path; w.docSavedAt = now; w.docUploadFailed = false; w.docHasSignature = true;
      w.docs = [...(w.docs || []).filter((d: Rec) => !d.signed), {
        id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'contract', name: r.parts!.contract.name,
        fileId: r.parts!.contract.path, url: uC, mediaType: 'application/pdf', uploadedAt: now, expiry: '',
        signed: true, templateId: r.templateId, templateVersion: r.templateVersion, signRequestId: r.id,
      }];
      w.signedAt = r.signedAt || now; w.signDate = r.signDate || ''; w.signedRequestId = r.id;
      if (r.sigPath) { w.sigFileId = r.sigPath; w.sigSavedAt = w.signedAt; }
      w.signedPrint = r.printHash || ''; w.signedPrintPay = !!r.printPay; w.signedPrintMarks = r.printMarks || [];
      // the replaced documents' files are kept: an earlier signed set stays in Storage, named by its own request's parts
      changed = true;
    }
    r.appliedAt = new Date().toISOString();
    void signCall({ action: 'applied', id: r.id }).catch(() => {});
  }
  if (changed) { autoSave(); emit('data'); }
}
