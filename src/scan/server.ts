// The scanner's server calls (scan_feedback): a full document after a scan's save (H8a, docs/hf-plan.md),
// the scanner's settings and its training figures (Admin → Scanner). Finding and cutting the
// documents is the phone's (scan/, the scanner lab's own page — docs/scan.md → The scan window).
import { SCAN_FEEDBACK_FN_URL } from '@/manager/logic/functions';
import { loadFirestoreBackend } from '@/manager/data/api';

async function post(url: string, body: unknown) {
  const idToken = await (await loadFirestoreBackend()).idToken();
  const resp = await fetch(url, {
    method: 'POST',
    headers: idToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken } : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.ok) throw new Error((json && (json.error || json.reason)) || 'HTTP ' + resp.status);
  return json;
}

/** A full document for the field reader model (docs/hf-plan.md → H8a): the scan's pages, the AI's
 * read, the fields the scan filled and the fields the user saved. Sent once, in the background, on
 * the save of the worker window; the server keeps it when the firm collects documents. Never throws. */
export type ScanDocument = {
  workerId: string; pages: { b64: string; mediaType: string; doctype: string | null; primary: boolean }[];
  read: Record<string, unknown>; reads: (Record<string, unknown> | null)[]; scanned: Record<string, unknown>; saved: Record<string, unknown>;
};
export async function sendScanDocument(doc: ScanDocument): Promise<void> {
  try { await post(SCAN_FEEDBACK_FN_URL, { action: 'document', ...doc }); } catch { /* offline or refused: this one is not collected */ }
}

/** Admin → Scanner (a super-admin): how the document type model is used, and which firms' full
 * documents are collected (docs/hf-plan.md); with a change, the settings after it. */
export type DoctypeMode = 'off' | 'shadow' | 'mixed';
export type ScanSettings = { doctypeMode: DoctypeMode; collect: Record<string, boolean> };
export async function scanSettings(change?: { doctypeMode?: DoctypeMode; collect?: Record<string, boolean> }): Promise<ScanSettings> {
  const j = await post(SCAN_FEEDBACK_FN_URL, change ? { action: 'setSettings', ...change } : { action: 'settings' });
  return { doctypeMode: j.doctypeMode, collect: j.collect || {} };
}

/** The scanner's training counts — a super-admin's (the bell's "time to retrain"). */
export type TrainingStats = { due: boolean; edgesSince: number; doctypesDue: boolean; doctypes: Record<string, number>; stats: Record<string, any> };
export async function trainingStats(): Promise<TrainingStats | null> {
  try {
    const j = await post(SCAN_FEEDBACK_FN_URL, { action: 'stats' });
    return { due: !!j.due, edgesSince: Number(j.edgesSince ?? j.stats?.edgesSince ?? 0), doctypesDue: !!j.doctypesDue, doctypes: j.doctypes || {}, stats: j.stats || {} };
  }
  catch { return null; }
}
