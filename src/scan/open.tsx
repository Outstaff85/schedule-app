// Opens the scan window (Scanner.tsx, the full-screen scanner) over the manager page and resolves with the
// pages when Done is tapped (and, with read, once they are read), or null when the window is closed. The
// scanner — its screen and its engine — is its own chunk, loaded the first time the window opens, so the
// manager's main bundle does not carry it.
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { adoptLanguage } from '@/lib/i18n';
import type { ReadFn, ScannedPage } from './Scanner';
import { imagesToPdf, jpegSize } from './pdf';
import { bridge, hasBridge } from '../manager/bridge';

let root: Root | null = null;
let seq = 0;
let chunk: Promise<typeof import('./Scanner')> | null = null;
/** The scanner's chunk, loaded once (a failed load is tried again next time). */
function loadScanner(): Promise<typeof import('./Scanner')> {
  if (!chunk) { chunk = import('./Scanner'); chunk.catch(() => { chunk = null; }); }
  return chunk;
}

export async function openScanner(opts: { initial?: ScannedPage[]; read?: ReadFn } = {}): Promise<ScannedPage[] | null> {
  const api = hasBridge() ? bridge() : null;
  if (api) adoptLanguage(api.lang(), api.dict());
  const { Scanner } = await loadScanner();
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
      root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open={false} onDone={() => {}} onClose={() => {}} /></TooltipProvider></React.StrictMode>);
      resolve(pages);
    };
    root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open initial={opts.initial} read={opts.read} superAdmin={!!api?.admin().isSuper} onDone={p => end(p)} onClose={() => end(null)} /></TooltipProvider></React.StrictMode>);
  });
}

// For the browser tests (like window.ManagerAcc): the contract PDF builder, and the scanner's own hooks
// (hooks.ts: the engine's pure functions, the kept session, its attempts, pages given with no camera), loaded
// with its chunk.
(window as unknown as { ManagerScan: unknown }).ManagerScan = { imagesToPdf, jpegSize, hooks: () => import('./hooks') };
