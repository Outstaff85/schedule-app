// The scanner's engine (docs/scan-plan.md → S9): what the status line says while the models load, as a key with
// its figures — the text is the screen's, through tr() (src/scan/status-text.ts), the same way as steady.ts's
// SteadyHint. statusEnglish() gives the lab's own sentence for each (its former plain page and its worker —
// the parity tests compare it with what that code says, tests/scan/legacy-lab.js). Runs in the page and the background thread.
// SessionStatus, at the end, is the scan session's status line (session.ts): keys only, no text in any language.
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

/** What the scan session's status line says (session.ts), as a key with its figures — no text in any
 *  language: the screen words it through tr(). In the order a shot goes:
 *  - finding: no document in the frame yet (the lab's "No document in the frame");
 *  - corners_out: n corners outside the frame — move the phone back;
 *  - edges_unclear: the edges are not clear — more light, a darker background;
 *  - hold: still for seconds more before the shot (the lab's "Hold still… 0.6 s");
 *  - found: count documents found (1 on the live frame once it is steady; after a shot, how many it held);
 *  - no_frame: Capture tapped with no frame to take yet;
 *  - captured: the shot is cut by the live frame's corners (ms after the tap);
 *  - refining: the accurate model is refining the corners;
 *  - looking_more: count documents so far, looking for more on the photo;
 *  - shot_failed: the shot failed (the log says why), the camera goes on;
 *  - stopped: the live frame stopped after 5 failed frames;
 *  - camera_failed: the camera or the model could not start (the log says why);
 *  - picture_finding / picture_cutting: a picked picture (file of files, page of pages — a photo is page 1 of
 *    1) is being looked at / a document on it was found and is being cut out (files.ts);
 *  - picked: a pick is done — pages from files;
 *  - pick_failed: a picked file could not be worked on (the log says why; the ones after it are not shown);
 *  - pick_open_failed: a picked file could not be opened (a PDF pdf.js could not read, pdf.js not loaded). */
export type SessionStatus =
  | { key: 'finding' }
  | { key: 'corners_out'; n: number }
  | { key: 'edges_unclear' }
  | { key: 'hold'; seconds: number }
  | { key: 'found'; count: number }
  | { key: 'no_frame' }
  | { key: 'captured'; ms: number }
  | { key: 'refining' }
  | { key: 'looking_more'; count: number }
  | { key: 'shot_failed' }
  | { key: 'stopped' }
  | { key: 'camera_failed' }
  | { key: 'picture_finding' | 'picture_cutting'; file: number; files: number; page: number; pages: number }
  | { key: 'picked'; pages: number; files: number }
  | { key: 'pick_failed' }
  | { key: 'pick_open_failed' };
