// What the app works out about a worker (from schedule-manager.html): its
// document number and address, active or not, the contract-expiry warning,
// the completeness of its documents. Pure: the worker in, the answer out.
import { tr } from './i18n';
import type { Rec } from '../data/state';
export { workerDocId, workerAddress, workerHasScan, WORKER_DOC_TYPES } from '../worker';
import { workerDocId, workerHasScan, WORKER_DOC_TYPES } from '../worker';

/** Where worker files are kept, as the UI names it. */
export const DOC_STORE = 'Firebase Storage';

// Inactive workers (status 'fired') leave the everyday lists — the Workers
// tab (unless its Status filter picks them), the Schedule, Today and the
// contract warnings — and come back when set Active again on their card
// (per user request 2026-10-11). Accounting still counts their hours.
export function isActiveWorker(w: Rec | null | undefined): boolean { return !!w && w.status !== 'fired'; }

// ── Contract-expiry warning (per-worker, opt-in) ──
// A contract has no end date (owner, 2026-10-25): the term is the worker's own
// option — expiryMonths (how long the term is) and expiryWarnMonths (how many
// months before its end to start warning), on only with expiryEnabled. The
// term counts from the latest contract (currentContractDoc: an Add document
// upload, a scanned or a signed contract — a new contract restarts it), or
// from startDate when the worker has no contract document. null if the option
// is off / unset or the term is not near its end, else
// {level:'warning'|'overdue', deadline, from} (from: the contract that started
// the term, null when it counts from startDate). The one source for every
// badge and notice.
export function workerExpiryStatus(w: Rec | null | undefined): {level: 'warning' | 'overdue'; deadline: Date; from: Rec | null} | null {
  if (!w || !isActiveWorker(w) || !w.expiryEnabled || !w.expiryMonths) return null;
  const t = termStart(w);
  if (!t) return null;
  const deadline = new Date(t.date);
  deadline.setMonth(deadline.getMonth() + Number(w.expiryMonths));
  const warnFrom = new Date(deadline);
  warnFrom.setMonth(warnFrom.getMonth() - Number(w.expiryWarnMonths || 0));
  const now = new Date();
  if (now >= deadline) return {level: 'overdue', deadline, from: t.doc};
  if (now >= warnFrom) return {level: 'warning', deadline, from: t.doc};
  return null;
}
/** Where the contract term counts from: the latest contract (currentContractDoc), else startDate; null when neither. */
export function termStart(w: Rec): {date: Date; doc: Rec | null} | null {
  const c = currentContractDoc(w);
  if (c) return c;
  if (!w.startDate) return null;
  const start = new Date(w.startDate + 'T00:00:00');
  return isNaN(start.getTime()) ? null : {date: start, doc: null};
}
/** A contract document's date — the day its term counts from: the contract date set in Add document
 * (`contractDate`), for a signed contract its signing day (`contractDate`, or the worker's `signDate`), else the
 * day it was uploaded. A contract's old `expiry` (from before 2026-10-25) is not a date of the term. */
export function contractDocDate(w: Rec, d: Rec): Date | null {
  const set = parseDocDate(d.contractDate) || (d.signed ? parseDocDate(w.signDate) : null);
  if (set && !isNaN(set.getTime())) return set;
  const at = d.uploadedAt ? new Date(String(d.uploadedAt)) : null;
  if (!at || isNaN(at.getTime())) return null;
  at.setHours(0, 0, 0, 0);
  return at;
}
/** The contract the term counts from: the latest contract upload (currentDocs — an Add document upload, a scanned
 * or a signed contract; a new one replaces the old) with its date (contractDocDate; the latest if its files
 * differ); null with no contract document — the term counts from startDate then. */
export function currentContractDoc(w: Rec): {doc: Rec; date: Date} | null {
  let best: {doc: Rec; date: Date} | null = null;
  for (const d of currentDocs(w)) {
    if (d.type !== 'contract') continue;
    const date = contractDocDate(w, d);
    if (date && (!best || date > best.date)) best = {doc: d, date};
  }
  return best;
}

// ── Worker document completeness ──
// One status per worker, used by the Workers list badge, the worker card and
// the "Documents incomplete" filter.
//   missing — ID/passport number (workerDocId), Form 101 PDF (w.docUrl), the
//     scan (workerHasScan: its stored pages, or the old sidecar), signature and, for an Israeli ID, the ספח page. Signature /
//     ספח are only known for documents saved since these flags existed
//     (w.docHasSignature / w.docExtraPages, set by aiFillForm101()); older
//     records are treated as unknown, not missing.
//   expiry — w.docExpiry (ID/passport validity) already past → error; within
//     DOC_EXPIRY_WARN_MONTHS → warning.
//   failed — w.docUploadFailed (last upload failed) → error.
export const DOC_EXPIRY_WARN_MONTHS = 3;
// Worker documents uploaded from the worker card (w.docs):
// [{id, type, name, fileId, url, mediaType, uploadedAt, expiry:'YYYY-MM-DD'|''}] — a contract has no expiry:
// contractDate:'YYYY-MM-DD' instead, the day its term counts from (workerExpiryStatus).
// Warn this many days before expiry.
export const WORKER_DOC_WARN_DAYS: Record<string, number> = {visa: 60, work_permit: 60, other: 30};
export function parseDocDate(v: unknown): Date | null {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}
type DocNote = {doc: Rec; level: 'error' | 'warn'; date: Date; text: string};
/** The worker's documents that count for expiry: of a contract, a visa or a work permit only the latest upload
 * (the files uploaded together share their time) — a new one replaces the old, so the old one's date no longer
 * warns; every "other" document counts. (A contract has no expiry — its date starts the contract term,
 * workerExpiryStatus — so workerDocExpiries leaves contracts out.) */
export function currentDocs(w: Rec): Rec[] {
  const docs = (w.docs || []) as Rec[], latest: Record<string, string> = {};
  for (const d of docs) if (d.type !== 'other') { const at = String(d.uploadedAt || ''); if (!(d.type in latest) || at > latest[d.type]) latest[d.type] = at; }
  return docs.filter(d => d.type === 'other' || String(d.uploadedAt || '') === latest[d.type]);
}
export function workerDocExpiries(w: Rec): DocNote[] {
  const today = new Date(); today.setHours(0,0,0,0);
  const out: DocNote[] = [], seen = new Set<string>();
  for (const d of currentDocs(w)) {
    if (d.type === 'contract') continue;  // no expiry: its date starts the contract term (workerExpiryStatus)
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
  if (!workerHasScan(w)) missing.push(tr('document scan'));
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
