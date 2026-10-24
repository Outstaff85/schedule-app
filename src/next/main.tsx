// /next — the new stack's component gallery (docs/components.md,
// archive/docs/react-migration-plan.md → stage 1). Not linked from the app.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { I18nProvider } from '@/lib/i18n';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UndoHost } from '@/components/shared/undo';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <App />
        <UndoHost />
        <Toaster />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
