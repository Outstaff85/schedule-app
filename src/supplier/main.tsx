// /supplier — the supplier portal (docs/supplier-portal.md, react-migration-plan.md → stage 4).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@/styles/globals.css';
import { I18nProvider } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UndoHost } from '@/components/shared/undo';
import { getSession, queryClient } from './api';
import { App } from './App';

// A signed-in supplier's language choice is also kept on its account (login brings it back on any device).
const saveLanguage = (language: string) => {
  if (!getSession()) return;
  loadBackend().then(b => b.handleAction('updateMyLanguage', { action: 'updateMyLanguage', language }, {})).catch(() => {});
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider onSave={saveLanguage}>
        <TooltipProvider>
          <App />
          <UndoHost />
          <Toaster />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
