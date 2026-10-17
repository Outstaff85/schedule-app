// /next — the new stack's test page (docs/build.md, react-migration-plan.md →
// stage 0). Not linked from the app. It shows that the build, Tailwind with the
// Odinson Glass tokens and React all work on the live site. Its texts join the
// dictionaries (i18n/<lang>.json) with the translation module of stage 1.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
