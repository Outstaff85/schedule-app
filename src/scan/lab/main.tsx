// /scan-lab/ — the scanner lab (docs/scan-plan.md → S9; Admin → Scanner lab opens it): the full-screen scanner in
// lab mode over the lab's own surface (/scan-lab/ and its models), with the Lab tools drawer (LabApp.tsx).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { I18nProvider } from '@/lib/i18n';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { UndoHost } from '@/components/shared/undo';
import { LabApp } from './LabApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <LabApp />
        <UndoHost />
        <Toaster />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
