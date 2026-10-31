// The scanner's engine (docs/scan-plan.md → S9): why a way of running the models failed on this device,
// kept on it (the last 8, with the device's memory; localStorage scanWayFails), so a way that keeps failing —
// and why: memory, a hang, the GPU, another error — can be looked up on the phone itself. The drawer no longer
// shows them (owner, 2026-10-31: only this opening's errors); failLines is the old list's wording, held to the old
// page by tests/scan/engine.test.mjs.
// Ported unchanged from the lab's former plain page (failKind, noteFail, showFails; tests/scan/engine.test.mjs).
import type { KeyValue } from './types';

export const FAIL_KEY = 'scanWayFails', FAILS_KEPT = 8;

export type FailKind = 'memory' | 'hang' | 'GPU' | 'error';
/** One failure kept: when (ISO), the way's label, its kind, the error's first 160 letters, the memory (GB). */
export interface WayFail { at: string; way: string; kind: FailKind; text: string; mem: number | null }

export function failKind(text: unknown): FailKind {
  const t = String(text || '');
  if (/memory|alloc|oom|out of range|rangeerror|bad_alloc/i.test(t)) return 'memory';
  if (/no answer|silent|timed? ?out|stopped answering/i.test(t)) return 'hang';
  if (/webgpu|gpu|adapter|device (was )?lost|shader/i.test(t)) return 'GPU';
  return 'error';
}

/** The failures kept on this device, oldest first ([] when none or unreadable). */
export function readFails(store: KeyValue | null | undefined): WayFail[] {
  try { return JSON.parse((store && store.getItem(FAIL_KEY)) || '[]'); } catch { return []; }
}

/** A way failed: kept (the last FAILS_KEPT); returns its kind. Storage that fails is ignored. */
export function recordFail(store: KeyValue | null | undefined, way: string, text: unknown, mem: number | null, now: Date = new Date()): FailKind {
  const kind = failKind(text);
  try {
    const list = JSON.parse(store!.getItem(FAIL_KEY) || '[]');
    list.push({ at: now.toISOString(), way, kind, text: String(text || '').slice(0, 160), mem: mem || null });
    store!.setItem(FAIL_KEY, JSON.stringify(list.slice(-FAILS_KEPT)));
  } catch { /* storage blocked: nothing kept */ }
  return kind;
}

/** The errors' line for a failure as it happens. */
export const failLine = (way: string, text: unknown): string => 'Failed — ' + way + ': ' + failKind(text) + ' (' + String(text || '').slice(0, 160) + ')';

/** The earlier failures as text, top to bottom: the heading, then the newest first; [] when none. */
export function failLines(list: WayFail[]): string[] {
  if (!list.length) return [];
  const lines = list.map(f => '  ' + f.at.slice(0, 16).replace('T', ' ') + ' — ' + f.way + ': ' + f.kind + ' (' + f.text + ')' + (f.mem ? ', memory ' + f.mem + ' GB' : ''));
  return ['Earlier failures on this device (last ' + list.length + ', newest on top):', ...lines.reverse()];
}
