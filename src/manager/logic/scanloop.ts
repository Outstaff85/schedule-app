// The scanner's automatic training cycle as the app tells it (docs/scan-training.md → The automatic cycle →
// Reports): the owner's PC writes each cycle's report (scripts/scan-train/loop_report.py →
// scanTrainingStats/loop), scan_feedback's "stats" hands the latest and the last 20 to a super-admin
// (src/scan/server.ts trainingStats → loop). Here: the bell's notice for the latest report when it is
// new — its id names the cycle and its state, so a report already marked read never comes back, and a
// report older than LOOP_FRESH_DAYS is not shown — and the words the bell and Admin → Scanner →
// Automatic training share (the state's name, its reason, the models' names). It never draws.
import { tr } from './i18n';
import type { LoopModel, LoopReport, LoopState } from '../../scan/server';

export const LOOP_FRESH_DAYS = 14;
export const LOOP_MODELS = ['edges', 'doctype', 'mrz', 'he'] as const;

export function loopModelName(m: string): string {
  return ({ edges: tr('Document edges'), doctype: tr('Document type'), mrz: tr('Passport zone reader'), he: tr('Hebrew field reader') } as Record<string, string>)[m] || m;
}

export function loopStateName(s: LoopState | string): string {
  return ({ 'not-due': tr('Nothing due'), running: tr('Running'), paused: tr('Paused until the next night'), published: tr('Published to the lab'),
    rejected: tr('Not better — nothing published'), 'waiting-golden': tr('Waiting for the golden set'), failed: tr('Failed') } as Record<string, string>)[s] || String(s);
}

/** The first exam rule that failed, as "<model>: <rule>" (a rejected cycle's reason). */
export function loopFirstFailed(r: LoopReport): string {
  for (const m of LOOP_MODELS) {
    const x = r.models[m] as LoopModel | undefined;
    if (x && x.failed && x.failed.length) return loopModelName(m) + ': ' + x.failed[0];
  }
  return '';
}

/** Why the cycle ended as it did, in one line: what needs the owner first, else the state's own reason. */
export function loopReason(r: LoopReport): string {
  if (r.needsOwner.length) return r.needsOwner[0];
  if (r.state === 'rejected') return loopFirstFailed(r) || tr('No exam said worth publishing');
  if (r.state === 'waiting-golden') return tr('At least 20 golden attempts are needed before the loop publishes to the lab');
  if (r.state === 'failed') return r.notes[r.notes.length - 1] || tr('See the cycle\'s log on the PC');
  if (r.state === 'published') return tr('Merge the pull request to give the lab the new version');
  return r.notes[r.notes.length - 1] || '';
}

const when = (r: LoopReport) => Date.parse(r.finishedAt || r.startedAt || '') || 0;

/** The bell's notice for the latest report, or null: a published, rejected, waiting or failed cycle, or any that
 * needs the owner, within LOOP_FRESH_DAYS. */
export function loopNotice(r: LoopReport | null | undefined, now = Date.now()): { id: string; lvl: string; icon: string; title: string; detail: string; at: number } | null {
  if (!r) return null;
  const ends = ['published', 'rejected', 'waiting-golden', 'failed'].includes(r.state);
  if (!ends && !r.needsOwner.length) return null;
  const at = when(r);
  if (!at || now - at > LOOP_FRESH_DAYS * 864e5) return null;
  const title = r.state === 'published' ? tr('New lab version {0} from the training loop — PR to merge', { 0: r.version || '—' })
    : r.state === 'rejected' ? tr('The training loop published nothing — the models were not better')
    : r.state === 'waiting-golden' ? tr('The training loop is waiting for the golden set')
    : r.state === 'failed' ? tr('The training loop failed')
    : tr('The training loop needs you');
  const lvl = r.state === 'published' ? 'green' : r.state === 'failed' ? 'red' : r.state === 'rejected' ? 'amber' : 'blue';
  return { id: 'scan-loop:' + r.id + ':' + r.state, lvl, icon: 'ti-scan', title, detail: loopReason(r), at };
}
