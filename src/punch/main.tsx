// /punch — the worker punch page (docs/punch.md, react-migration-plan.md → stage 5).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import './punch.css';
import { I18nProvider } from '@/lib/i18n';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { reportError, startQueue } from './core';
import { App } from './App';

// Client errors go to the errors collection (throttled, silent).
window.addEventListener('error', ev => reportError(ev.message, (ev.filename || '') + ':' + (ev.lineno || ''), ev.error && ev.error.stack));
window.addEventListener('unhandledrejection', ev => { const r = ev.reason; reportError((r && r.message) || String(r), 'promise', r && r.stack); });

// The offline queue: sent when the connection returns, and now if any is left from before.
startQueue();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);

// The PWA service worker: always fresh (network-first); a new version taking control reloads the page.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; refreshing = true;
    if (hadController) window.location.reload();
  });
  const register = () => navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(reg => { void reg.update(); }).catch(() => {});
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register);
}
