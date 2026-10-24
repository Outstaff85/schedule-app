// Opens the scan window (Scanner.tsx) over the manager page and resolves with the
// pages when Done is tapped (and, with read, once they are read), or null when the
// window is closed. workerId: the worker scanned again from their window, when known.
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { adoptLanguage } from '@/lib/i18n';
import { Scanner, type ReadFn, type ScannedPage } from './Scanner';
import { imagesToPdf, jpegSize } from './pdf';
import { bridge, hasBridge } from '../manager/bridge';

let root: Root | null = null;
let seq = 0;

export function openScanner(opts: { initial?: ScannedPage[]; read?: ReadFn; workerId?: string } = {}): Promise<ScannedPage[] | null> {
  const api = hasBridge() ? bridge() : null;
  if (api) adoptLanguage(api.lang(), api.dict());
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
    root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open initial={opts.initial} read={opts.read} workerId={opts.workerId} superAdmin={!!api?.admin().isSuper} onDone={p => end(p)} onClose={() => end(null)} /></TooltipProvider></React.StrictMode>);
  });
}

// For the browser tests (like window.ManagerAcc): the contract PDF builder.
(window as unknown as { ManagerScan: unknown }).ManagerScan = { imagesToPdf, jpegSize };
