// The scanner's engine (docs/scan-plan.md → S9): what the status line says while the models load, as a key with
// its figures — the text is the screen's, through tr() (src/scan/status-text.ts), the same way as steady.ts's
// SteadyHint. statusEnglish() gives the lab's own sentence for each (index.html, scan-core.js, scan-worker.js —
// the parity tests compare it with what the lab's code says). Runs in the page and the background thread.
import type { GpuLayout } from './ort';

/** On which the model starts: the GPU with a memory layout, or the CPU. */
export type StatusOn = { on: 'gpu'; layout: GpuLayout } | { on: 'cpu' };

export type EngineStatus =
  | { key: 'preparing' }
  | { key: 'preparing_accurate' }
  | { key: 'trying_way'; way: string }
  | { key: 'downloading'; model: string; got: number; total: number }
  | ({ key: 'starting' | 'warming' | 'checking'; model: string } & StatusOn)
  | { key: 'face' }
  | { key: 'ready_files' }
  | { key: 'ready' }
  | { key: 'failed' };

/** Megabytes with one decimal, as the lab shows them. */
export const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);

const onName = (s: StatusOn): string => (s.on === 'gpu' ? 'the GPU (' + s.layout + ')' : 'the CPU');

/** The lab's sentence for a status (its log and the parity tests). */
export function statusEnglish(s: EngineStatus): string {
  switch (s.key) {
    case 'preparing': return 'Preparing the model…';
    case 'preparing_accurate': return 'Preparing the accurate model…';
    case 'trying_way': return 'Trying ' + s.way + '…';
    case 'downloading': return 'Downloading ' + s.model + ': ' + mb(s.got) + (s.total ? ' / ' + mb(s.total) : '') + ' MB';
    case 'starting': return 'Starting ' + s.model + ' on ' + onName(s) + '…';
    case 'warming': return 'Warming up ' + s.model + ' on ' + onName(s) + '…';
    case 'checking': return 'Checking ' + onName(s) + ' with ' + s.model + '…';
    case 'face': return 'Loading the face finder…';
    case 'ready_files': return 'Ready for photos and PDFs — the camera\'s model is loading…';
    case 'ready': return 'Model ready — scanning is available';
    case 'failed': return 'The model could not start — see the log below';
  }
}
