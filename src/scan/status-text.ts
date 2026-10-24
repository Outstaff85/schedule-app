// The scanner's status line while the models load (docs/scan-plan.md → S9): the engine's status key
// (src/scan/engine/status.ts) → the text on the screen, through tr(). The site's scanner says it plainly (no
// model files, ways or GPU layouts — those are the lab's); the lab says what the engine is doing, as its old
// page did. The engine's free-text log and error lines stay English: they are shown only in the lab's tools
// drawer (docs/scan-plan.md → S9).
import { tr } from '@/lib/i18n';
import { mb, type EngineStatus } from './engine/status';

export function engineStatusText(s: EngineStatus, lab: boolean): string {
  if (!lab) {
    switch (s.key) {
      case 'downloading': return s.total ? tr('Downloading the scanner: {got} / {total} MB', { got: mb(s.got), total: mb(s.total) }) : tr('Downloading the scanner: {got} MB', { got: mb(s.got) });
      case 'ready_files': return tr('Ready for photos and PDFs — the camera is getting ready…');
      case 'ready': return tr('The scanner is ready');
      case 'failed': return tr('The scanner could not start — close it and open it again');
      default: return tr('Preparing the scanner…');
    }
  }
  switch (s.key) {
    case 'preparing': return tr('Preparing the model…');
    case 'preparing_accurate': return tr('Preparing the accurate model…');
    case 'trying_way': return tr('Trying {way}…', { way: s.way });
    case 'downloading': return s.total ? tr('Downloading {model}: {got} / {total} MB', { model: s.model, got: mb(s.got), total: mb(s.total) }) : tr('Downloading {model}: {got} MB', { model: s.model, got: mb(s.got) });
    case 'starting': return s.on === 'gpu' ? tr('Starting {model} on the GPU ({layout})…', { model: s.model, layout: s.layout }) : tr('Starting {model} on the CPU…', { model: s.model });
    case 'warming': return s.on === 'gpu' ? tr('Warming up {model} on the GPU ({layout})…', { model: s.model, layout: s.layout }) : tr('Warming up {model} on the CPU…', { model: s.model });
    case 'checking': return s.on === 'gpu' ? tr('Checking the GPU ({layout}) with {model}…', { model: s.model, layout: s.layout }) : tr('Checking the CPU with {model}…', { model: s.model });
    case 'face': return tr('Loading the face finder…');
    case 'ready_files': return tr('Ready for photos and PDFs — the camera\'s model is loading…');
    case 'ready': return tr('Model ready — scanning is available');
    case 'failed': return tr('The model could not start — see the log in Lab tools');
  }
}
