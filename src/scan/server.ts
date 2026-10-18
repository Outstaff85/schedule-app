// The server's half of the scan (docs/scan.md → Server-side finding): the whole
// photo goes to preprocess_scan with "find" — the accurate model finds the
// documents' corners (the phone's live corners as a hint), cuts every document
// flat, turns it upright and enhances it. At most 4 photos are in flight at once
// (the phone's memory); the rest wait their turn.
import { PREPROCESS_SCAN_FN_URL } from '@/manager/logic/functions';
import { loadFirestoreBackend } from '@/manager/data/api';
import type { Pt } from './engine';

export type ServerPage = {
  quad: Pt[]; box: number[] | null; source: string; turn: number;
  blurry: boolean; imageBase64: string; mediaType: string;
};

const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const queue: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>(r => queue.push(r));
  inFlight++;
  try { return await run(); } finally { inFlight--; queue.shift()?.(); }
}

export function findPages(b64: string, corners?: Pt[] | null): Promise<ServerPage[]> {
  return slot(async () => {
    const idToken = await (await loadFirestoreBackend()).idToken();
    const resp = await fetch(PREPROCESS_SCAN_FN_URL, {
      method: 'POST',
      headers: idToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, find: true, corners: corners || undefined }),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json || !json.ok) throw new Error((json && (json.error || json.reason)) || 'HTTP ' + resp.status);
    return json.pages as ServerPage[];
  });
}
