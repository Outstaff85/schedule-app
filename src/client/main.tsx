// /client — the client portal (docs/client-portal.md, react-migration-plan.md → stage 3).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { I18nProvider } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App, getSession } from './App';

// A signed-in client's language choice is also kept on its account (login brings it back on any device).
const saveLanguage = (language: string) => {
  if (!getSession()) return;
  loadBackend().then(b => b.handleAction('updateMyLanguage', { action: 'updateMyLanguage', language }, {})).catch(() => {});
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider onSave={saveLanguage}>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
