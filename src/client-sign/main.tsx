// /client-sign — a client's contract to sign (docs/contracts.md → Client contracts; docs/build.md → Adding a new page).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { I18nProvider } from '@/lib/i18n';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';

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
