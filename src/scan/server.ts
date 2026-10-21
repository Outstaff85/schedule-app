// The scanner's server calls (scan_feedback): the pages' document type examples (the queue), the
// document type model's mode, a full document after a scan's save (H8a, docs/hf-plan.md), the
// scanner's settings and its training figures (Admin → Scanner). Finding and cutting the documents is the phone's (scan/, the scanner lab's own page — docs/scan.md → The scan window).
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
  /** the passport zone reader's lines and values on the primary page, in shadow (H8b) */
  mrzShadow?: Record<string, unknown>;
  /** the Hebrew field reader's fields on the primary ID card, in shadow (H8c) */
  heShadow?: Record<string, unknown>;
};
export async function sendScanDocument(doc: ScanDocument): Promise<void> {
  try { await post(SCAN_FEEDBACK_FN_URL, { action: 'document', ...doc }); } catch { /* offline or refused: this one is not collected */ }
}

/** A page's training example (functions/feedback.py): the scan window's pages are cut by the phone
 * (source "page" — no corners), so each teaches only its document type: who typed it (Haiku or the
 * document type model), the type the user left, the model's answer in shadow, and a 256×256 copy of
 * the page when its type was changed (or one right page in five, keep). */
export type Example = {
  source: 'page'; doctypeModel: string; doctypeFixed: string; doctypeBy: 'haiku' | 'model';
  doctypeShadow?: string; pageImage?: string; keep?: boolean;
};
const QUEUE_KEY = 'scanFeedbackQueue', QUEUE_MAX = 60;
const readQueue = (): Example[] => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const writeQueue = (q: Example[]) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX))); } catch { /* full or private */ } };
let sending = false;

/** Adds the scan's examples to the phone's queue and sends the queue in the background;
 * what cannot be sent now (no network) waits for the next scan. Never throws. */
export async function sendFeedback(examples: Example[] = []): Promise<void> {
  if (examples.length) writeQueue([...readQueue(), ...examples]);
  if (sending) return;
  sending = true;
  try {
    for (let q = readQueue(); q.length; q = readQueue()) {
      const batch = q.slice(0, 10);
      await post(SCAN_FEEDBACK_FN_URL, { action: 'add', examples: batch });
      writeQueue(readQueue().slice(batch.length));
    }
  } catch { /* offline or refused: kept for the next time */ }
  finally { sending = false; }
}

/** How the scan window uses the document type model (Admin → Scanner's Off / Shadow / Mixed); shadow
 * when it cannot be read — the model's answer is then only recorded, never trusted. */
export async function doctypeMode(): Promise<DoctypeMode> {
  try {
    const m = (await post(SCAN_FEEDBACK_FN_URL, { action: 'mode' })).doctypeMode;
    return m === 'off' || m === 'mixed' ? m : 'shadow';
  } catch { return 'shadow'; }
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
export type TrainingStats = { due: boolean; edgesSince: number; doctypesDue: boolean; doctypes: Record<string, number>; stats: Record<string, any>;
  /** every scan attempt (docs/scan-plan.md → S8): new since the last training, the threshold, whether it is reached */
  attemptsSince?: number; attemptsAt?: number; attemptsDue?: boolean };
export async function trainingStats(): Promise<TrainingStats | null> {
  try {
    const j = await post(SCAN_FEEDBACK_FN_URL, { action: 'stats' });
    return { due: !!j.due, edgesSince: Number(j.edgesSince ?? j.stats?.edgesSince ?? 0), doctypesDue: !!j.doctypesDue, doctypes: j.doctypes || {}, stats: j.stats || {} };
  }
  catch { return null; }
}
