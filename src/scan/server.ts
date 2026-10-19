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
  /** the firm's page-kind model's answer, once a version has one (S7); kindSure: no Haiku needed */
  kind?: string; kindConf?: number; kindSure?: boolean;
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
  image?: string; cornersModel: Pt[]; cornersFixed: Pt[]; source: string; model: string; kindModel?: string; kindFixed?: string; pageImage?: string; keep?: boolean;
  /** who gave kindModel: Haiku, or the firm's page-kind model (S7) */
  kindBy?: 'haiku' | 'model';
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

/** The scanner's training counts — a super-admin's (the bell's "time to retrain"). */
export type TrainingStats = { due: boolean; newSince: number; kindsDue: boolean; kinds: Record<string, number> };
export async function trainingStats(): Promise<TrainingStats | null> {
  try {
    const j = await post(SCAN_FEEDBACK_FN_URL, { action: 'stats' });
    return { due: !!j.due, newSince: Number(j.stats?.newSince || 0), kindsDue: !!j.kindsDue, kinds: j.kinds || {} };
  }
  catch { return null; }
}
