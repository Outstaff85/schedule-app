// The scanner's status line while the models load (docs/scan-plan.md → S9): the engine's status key
// (src/scan/engine/status.ts) → the text on the screen, through tr(). The site's scanner says it plainly (no
// model files, ways or GPU layouts — those are the lab's); the lab says what the engine is doing, as its old
// page did. The engine's free-text log and error lines stay English: they are shown only in the lab's tools
// drawer (docs/scan-plan.md → S9). sessionStatusText words the scan session's status line (the scanner's
// status pill, src/scan/ui/StatusPill.tsx) — the same for the site and the lab.
import { tr } from '@/lib/i18n';
import { mb, type EngineStatus, type SessionStatus } from './engine/status';

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

/** How the status pill looks for a session status: busy (a spinner), ok (green — the frame is steady, documents
 *  found), warn (the user must do something — move back, more light) or bad (something failed). */
export type StatusTone = 'plain' | 'busy' | 'ok' | 'warn' | 'bad';

/** The scan session's status line (src/scan/engine/status.ts SessionStatus) as the screen says it. */
export function sessionStatusText(s: SessionStatus): string {
  switch (s.key) {
    case 'finding': return tr('Finding the document…');
    case 'corners_out': return s.n === 1 ? tr('A corner is outside the frame — move the phone back') : tr('{n} corners are outside the frame — move the phone back', { n: s.n });
    case 'edges_unclear': return tr('The edges are not clear — more light, a darker background');
    case 'hold': return tr('Hold still · {seconds} s', { seconds: s.seconds.toFixed(1) });
    case 'found': return s.count === 1 ? tr('1 document found') : tr('{count} documents found', { count: s.count });
    case 'no_frame': return tr('No frame to capture yet');
    case 'captured': return tr('Captured in {ms} ms', { ms: Math.round(s.ms) });
    case 'refining': return tr('Refining the corners…');
    case 'looking_more': return s.count === 1 ? tr('1 document — looking for more…') : tr('{count} documents — looking for more…', { count: s.count });
    case 'shot_failed': return tr('The shot failed — try again');
    case 'stopped': return tr('The camera stopped finding documents — take the shot by hand');
    case 'camera_failed': return tr('The camera could not start');
    case 'picture_finding':
    case 'picture_cutting': {
      const what = s.key === 'picture_finding' ? tr('Finding the document') : tr('Found — cutting it out');
      const where = s.pages > 1 ? tr('file {file} of {files}, page {page} of {pages}', { file: s.file, files: s.files, page: s.page, pages: s.pages }) : tr('file {file} of {files}', { file: s.file, files: s.files });
      return what + ' · ' + where;
    }
    case 'picked': return s.pages === 1 ? tr('1 page from your files') : tr('{pages} pages from your files', { pages: s.pages });
    case 'pick_failed': return tr('A file could not be worked on');
    case 'pick_open_failed': return tr('A file could not be opened');
  }
}

export function sessionStatusTone(s: SessionStatus): StatusTone {
  switch (s.key) {
    case 'hold': case 'found': case 'picked': return 'ok';
    case 'corners_out': case 'edges_unclear': case 'no_frame': return 'warn';
    case 'shot_failed': case 'stopped': case 'camera_failed': case 'pick_failed': case 'pick_open_failed': return 'bad';
    case 'finding': case 'captured': case 'refining': case 'looking_more': case 'picture_finding': case 'picture_cutting': return 'busy';
    default: return 'plain';
  }
}
