// The scanner's engine (docs/scan-plan.md → S9): what the engine says while it works — the status line (a key
// with its figures, status.ts, and how far, 0..1; the screen words it through tr()), the loading-and-work log
// and the errors (free English text, shown only in the lab's tools drawer) — as events; the lab's Errors and
// Loading-and-work blocks listen to it, the site's scanner its status line. The way failures are kept on the
// device through fails.ts (noteFail) and shown when the scanner opens (showFails). Ported from the lab's
// index.html (log, logErr, logAny, status, noteFail, showFails).
import { failLine, failLines, readFails, recordFail, type FailKind } from './fails';
import type { EngineStatus } from './status';
import type { KeyValue } from './types';

export interface ScanLogEvents {
  status: (s: EngineStatus, frac?: number) => void;
  log: (text: string) => void;
  err: (text: string) => void;
  /** The earlier failures on this device, top to bottom (the heading, then the newest first). */
  fails: (lines: string[]) => void;
}

/** A line from the models' loading (the page's or a background thread's): its failures go to the errors. */
export const isErrLine = (t: string): boolean => /^Could not start|wrong on this GPU|^WebGPU is not available/.test(t);

function safeStorage(): KeyValue | null {
  try { return (globalThis as { localStorage?: KeyValue }).localStorage || null; } catch { return null; }
}
const deviceMemory = (): number | null => ((globalThis as { navigator?: { deviceMemory?: number } }).navigator || {}).deviceMemory || null;

export class ScanLog {
  private listeners: { [K in keyof ScanLogEvents]: Set<ScanLogEvents[K]> } = { status: new Set(), log: new Set(), err: new Set(), fails: new Set() };

  /** store: where the way failures are kept (localStorage by default); memory: the device's (GB). */
  constructor(private store: KeyValue | null = safeStorage(), private memory: () => number | null = deviceMemory) {}

  /** Listen; returns the unsubscribe. */
  on<K extends keyof ScanLogEvents>(ev: K, fn: ScanLogEvents[K]): () => void {
    this.listeners[ev].add(fn);
    return () => { this.listeners[ev].delete(fn); };
  }
  private emit<K extends keyof ScanLogEvents>(ev: K, ...args: Parameters<ScanLogEvents[K]>): void {
    for (const fn of this.listeners[ev]) {
      try { (fn as (...a: Parameters<ScanLogEvents[K]>) => void)(...args); } catch { /* a listener's fault stays its own */ }
    }
  }

  status = (s: EngineStatus, frac?: number): void => this.emit('status', s, frac);
  log = (text: string): void => this.emit('log', text);
  err = (text: string): void => this.emit('err', text);
  /** A line from scan's model loading (one onLog for the page and the threads): errors apart. */
  any = (text: string): void => (isErrLine(text) ? this.err : this.log)(text);

  /** A way failed: said in the errors and kept on the device (the last 8); returns its kind. */
  noteFail(label: string, text: unknown): FailKind {
    this.err(failLine(label, text));
    return recordFail(this.store, label, text, this.memory());
  }

  /** The earlier failures kept on this device, given to the 'fails' listeners (nothing when none). */
  showFails(): void {
    const lines = failLines(readFails(this.store));
    if (lines.length) this.emit('fails', lines);
  }
}
