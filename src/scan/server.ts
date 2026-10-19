// The server's half of the scan (docs/scan.md → Server-side finding): the whole
// photo goes to preprocess_scan with "find" — the accurate model finds the
// documents' corners (the phone's live corners as a hint), cuts every document
// flat, turns it upright and enhances it; with "cut" it cuts one page exactly by
// the corners the user set. At most 4 photos are in flight at once (the phone's
// memory); the rest wait their turn. The corrections go to scan_feedback (S6).
import { PREPROCESS_SCAN_FN_URL, SCAN_FEEDBACK_FN_URL } from '@/manager/logic/functions';
import { loadFirestoreBackend } from '@/manager/data/api';
import type { Pt } from './engine';

export type ServerPage = {
  quad: Pt[]; box: number[] | null; source: string; turn: number;
  blurry: boolean; imageBase64: string; mediaType: string;
  /** the firm's document type model's answer, once a version has one (S7); doctypeSure: no Haiku needed */
  doctype?: string; doctypeConf?: number; doctypeSure?: boolean;
  /** in shadow mode (Admin → Scanner) the model's answer, only recorded — never trusted */
  doctypeShadow?: string;
};
export type FindResult = { pages: ServerPage[]; size: [number, number] };

const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const queue: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>(r => queue.push(r));
  inFlight++;
  try { return await run(); } finally { inFlight--; queue.shift()?.(); }
}

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

/** The documents on a photo, as the server finds them. */
export function findPages(b64: string, corners?: Pt[] | null): Promise<FindResult> {
  return slot(async () => {
    const json = await post(PREPROCESS_SCAN_FN_URL, { image: b64, find: true, corners: corners || undefined });
    return { pages: json.pages as ServerPage[], size: json.size as [number, number] };
  });
}

/** One page cut exactly by these corners (0..1 of the photo), turned upright and enhanced. */
export function cutPage(b64: string, quad: Pt[]): Promise<ServerPage> {
  return slot(async () => {
    const json = await post(PREPROCESS_SCAN_FN_URL, { image: b64, cut: quad });
    if (!json.pages || !json.pages[0]) throw new Error('the page could not be cut');
    return json.pages[0] as ServerPage;
  });
}

// ── the training examples (docs/scan-plan.md → S6) ──
export type Example = {
  image?: string; edgesModel: Pt[]; edgesFixed: Pt[]; source: string; model: string; doctypeModel?: string; doctypeFixed?: string; pageImage?: string; keep?: boolean;
  /** who gave doctypeModel: Haiku, or the firm's document type model (S7) */
  doctypeBy?: 'haiku' | 'model';
  /** the document type model's answer in shadow mode, compared with Haiku's and the user's */
  doctypeShadow?: string;
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
