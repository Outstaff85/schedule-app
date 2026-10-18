// What the app works out about a worker (from schedule-manager.html): its
// document number and address, active or not, the contract-expiry warning,
// the completeness of its documents. Pure: the worker in, the answer out.
import { tr } from './i18n';
import type { Rec } from '../data/state';
export { workerDocId, workerAddress, WORKER_DOC_TYPES } from '../worker';
import { workerDocId, WORKER_DOC_TYPES } from '../worker';

/** Where worker files are kept, as the UI names it. */
export const DOC_STORE = 'Firebase Storage';

// Inactive workers (status 'fired') leave the everyday lists — the Workers
// tab (unless its Status filter picks them), the Schedule, Today and the
// contract warnings — and come back when set Active again on their card
// (per user request 2026-10-11). Accounting still counts their hours.
export function isActiveWorker(w: Rec | null | undefined): boolean { return !!w && w.status !== 'fired'; }

// ── Contract-expiry warning (per-worker, opt-in) ──
// A worker can set expiryMonths (how many months after startDate the deadline
// hits) and expiryWarnMonths (how many months before the deadline to start
// warning). null if the feature is off / unset for this worker, else
// {level:'warning'|'overdue', deadline}. The one source for every badge and notice.
export function workerExpiryStatus(w: Rec | null | undefined): {level: 'warning' | 'overdue'; deadline: Date} | null {
  if (!w || !isActiveWorker(w) || !w.expiryEnabled || !w.startDate || !w.expiryMonths) return null;
  const start = new Date(w.startDate + 'T00:00:00');
  if (isNaN(start.getTime())) return null;
  const deadline = new Date(start);
  deadline.setMonth(deadline.getMonth() + Number(w.expiryMonths));
  const warnFrom = new Date(deadline);
  warnFrom.setMonth(warnFrom.getMonth() - Number(w.expiryWarnMonths || 0));
  const now = new Date();
  if (now >= deadline) return {level: 'overdue', deadline};
  if (now >= warnFrom) return {level: 'warning', deadline};
  return null;
}

// ── Worker document completeness ──
// One status per worker, used by the Workers list badge, the worker card and
// the "Documents incomplete" filter.
//   missing — ID/passport number (workerDocId), Form 101 PDF (w.docUrl), the
//     raw scan (w.assetsFileId — the sidecar is only written when a scan
//     exists), signature and, for an Israeli ID, the ספח page. Signature /
//     ספח are only known for documents saved since these flags existed
//     (w.docHasSignature / w.docExtraPages, set by aiFillForm101()); older
//     records are treated as unknown, not missing.
//   expiry — w.docExpiry (ID/passport validity) already past → error; within
//     DOC_EXPIRY_WARN_MONTHS → warning.
//   failed — w.docUploadFailed (last upload failed) → error.
export const DOC_EXPIRY_WARN_MONTHS = 3;
// Worker documents uploaded from the worker card (w.docs):
// [{id, type, name, fileId, url, mediaType, uploadedAt, expiry:'YYYY-MM-DD'|''}].
// Warn this many days before expiry.
export const WORKER_DOC_WARN_DAYS: Record<string, number> = {contract: 30, visa: 60, work_permit: 60, other: 30};
export function parseDocDate(v: unknown): Date | null {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}
type DocNote = {doc: Rec; level: 'error' | 'warn'; date: Date; text: string};
export function workerDocExpiries(w: Rec): DocNote[] {
  const today = new Date(); today.setHours(0,0,0,0);
  const out: DocNote[] = [], seen = new Set<string>();
  for (const d of (w.docs || []) as Rec[]) {
    const date = parseDocDate(d.expiry);
    if (!date || isNaN(date.getTime())) continue;
    // One reminder per document, not per file (a visa uploaded as front +
    // back shares its type and expiry).
    const key = d.type + '|' + d.expiry; if (seen.has(key)) continue; seen.add(key);
    const label = tr(WORKER_DOC_TYPES[d.type] || 'Document');
    const warnAt = new Date(today); warnAt.setDate(warnAt.getDate() + (WORKER_DOC_WARN_DAYS[d.type] || 30));
    if (date < today) out.push({doc: d, level: 'error', date, text: tr('{0} expired {1}', {0: label, 1: date.toLocaleDateString('en-GB')})});
    else if (date <= warnAt) out.push({doc: d, level: 'warn', date, text: tr('{0} expires {1}', {0: label, 1: date.toLocaleDateString('en-GB')})});
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
export function workerDocStatus(w: Rec) {
  const missing: string[] = [];
  if (!workerDocId(w as Parameters<typeof workerDocId>[0])) missing.push(tr('ID/passport no.'));
  if (!w.docUrl) missing.push(tr('Form 101'));
  if (!w.assetsFileId) missing.push(tr('document scan'));
  if (w.docHasSignature === false) missing.push(tr('signature'));
  if ((w.docType || 'israeli_id') === 'israeli_id' && w.docExtraPages === 0) missing.push(tr('ספח (ID appendix)'));
  let expiry: {level: 'error' | 'warn'; date: Date; text: string} | null = null;
  const d = parseDocDate(w.docExpiry);
  if (d && !isNaN(d.getTime())) {
    const today = new Date(); today.setHours(0,0,0,0);
    const warnAt = new Date(today); warnAt.setMonth(warnAt.getMonth() + DOC_EXPIRY_WARN_MONTHS);
    if (d < today) expiry = {level: 'error', date: d, text: tr('ID/passport expired {0}', {0: d.toLocaleDateString('en-GB')})};
    else if (d <= warnAt) expiry = {level: 'warn', date: d, text: tr('ID/passport expires {0}', {0: d.toLocaleDateString('en-GB')})};
  }
  const failed = !!w.docUploadFailed;
  const docExpiries = workerDocExpiries(w);
  const docExpired = docExpiries.find(x => x.level === 'error') || null;
  const level: 'error' | 'warn' | 'ok' = (failed || (expiry && expiry.level === 'error') || docExpired) ? 'error' : ((missing.length || expiry || docExpiries.length) ? 'warn' : 'ok');
  const lines: string[] = [];
  if (failed) lines.push(tr('Last upload to {0} failed', {0: DOC_STORE}));
  if (missing.length) lines.push(tr('Missing: {0}', {0: missing.join(', ')}));
  if (expiry) lines.push(expiry.text);
  for (const x of docExpiries) lines.push(x.text);
  return {level, missing, expiry, docExpiries, docExpired, failed, lines};
}
