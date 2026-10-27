// Opens the scan window (Scanner.tsx, the full-screen scanner) over the manager page and resolves with the
// pages when Done is tapped (and, with read, once they are read), or null when the window is closed. The
// scanner — its screen and its engine — is its own chunk, loaded the first time the window opens, so the
// manager's main bundle does not carry it. workerId: the worker scanned again from their window, when known.
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { adoptLanguage } from '@/lib/i18n';
import type { ReadFn, ScannedPage } from './Scanner';
import { imagesToPdf, jpegSize } from './pdf';
import { bridge, hasBridge } from '../manager/bridge';
import { earlyWanted } from './keep';

let root: Root | null = null;
let seq = 0;
/** The scan window is open (from openScanner until its pages or its close): nothing is started early then. */
let showing = false;
let chunk: Promise<typeof import('./Scanner')> | null = null;
/** The scanner's chunk, loaded once (a failed load is tried again next time). */
function loadScanner(): Promise<typeof import('./Scanner')> {
  if (!chunk) { chunk = import('./Scanner'); chunk.catch(() => { chunk = null; }); }
  return chunk;
}

/** The scan session started in the background ahead of the scan window (owner, 2026-10-27: the Workers tab opened
 *  — its New worker button opens the scanner — or a new worker's window; the scanner then finds the models ready):
 *  the scanner's chunk loaded and its session's models started, no camera and no screen; kept 3 minutes, then
 *  stopped (keep.ts prepareEarly). Once only: nothing when a session is kept or in use (a kept one gets a fresh 3
 *  minutes). mayAdd: the login may add workers (access.ts canAddWorkers); never while the scan window is open; not
 *  on a phone with under 4 GB of memory. On a computer with no camera too: photos and PDFs picked in the scanner
 *  need the same accurate model. */
export function prepareScanEarly(mayAdd: boolean): void {
  const memoryGb = (navigator as { deviceMemory?: number }).deviceMemory;
  if (!earlyWanted({ mayAdd, scanOpen: showing, memoryGb })) return;
  void loadScanner().then(m => { if (!showing) m.prepareSiteEarly(); }, () => { /* the chunk did not load: the window loads it on open */ });
}

export async function openScanner(opts: { initial?: ScannedPage[]; read?: ReadFn; workerId?: string } = {}): Promise<ScannedPage[] | null> {
  const api = hasBridge() ? bridge() : null;
  if (api) adoptLanguage(api.lang(), api.dict());
  showing = true;
  let Scanner: typeof import('./Scanner').Scanner;
  try { ({ Scanner } = await loadScanner()); } catch (e) { showing = false; throw e; }
  if (!root) {
    const el = document.createElement('div');
    el.dataset.island = 'scanner';
    document.body.append(el);
    root = createRoot(el);
  }
  const key = ++seq;
  return new Promise(resolve => {
    let settled = false;
    const end = (pages: ScannedPage[] | null) => {
      if (settled) return;
      settled = true;
      showing = false;
      root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open={false} onDone={() => {}} onClose={() => {}} /></TooltipProvider></React.StrictMode>);
      resolve(pages);
    };
    root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open initial={opts.initial} read={opts.read} workerId={opts.workerId} superAdmin={!!api?.admin().isSuper} onDone={p => end(p)} onClose={() => end(null)} /></TooltipProvider></React.StrictMode>);
  });
}

// For the browser tests (like window.ManagerAcc): the contract PDF builder, and the scanner's own hooks
// (hooks.ts: the engine's pure functions, the kept session, its attempts, pages given with no camera), loaded
// with its chunk.
(window as unknown as { ManagerScan: unknown }).ManagerScan = { imagesToPdf, jpegSize, hooks: () => import('./hooks') };
