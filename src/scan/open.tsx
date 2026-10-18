// Opens the scan window (Scanner.tsx) over the manager page and resolves with the
// pages when Done is tapped, or null when the window is closed.
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { adoptLanguage } from '@/lib/i18n';
import { Scanner, type ScannedPage } from './Scanner';

let root: Root | null = null;
let seq = 0;

export function openScanner(): Promise<ScannedPage[] | null> {
  const api = window.ManagerBridge;
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
    root!.render(<React.StrictMode><TooltipProvider><Scanner key={key} open onDone={p => end(p)} onClose={() => end(null)} /></TooltipProvider></React.StrictMode>);
  });
}
