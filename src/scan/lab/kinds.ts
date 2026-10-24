// The scanner lab's document type collection (docs/scan-plan.md → S9, package 7; docs/scan-training.md) — the
// lab's addKind / sendKind / dropKind, ported (its former plain page). On every page the lab keeps, when its model
// version has a document type model, the page's kind chips start on the model's answer. Only what the user did is
// a label — the model's answer nobody touched never is (it would teach the model its own guesses; the training
// audit, 2026-10-24): a type picked is sent KIND_WAIT after the last change or when the page is left (pagehide);
// the tick sends the type shown at once (keep: true when it is the model's); each page once, with a 256×256 copy
// (scan_feedback "add", source "page", doctypeBy "model"). Only in lab mode — the site's scan window types its
// pages itself (src/scan/Scanner.tsx) — and only with a document type model in the version (no answer: nothing
// is offered, nothing sent). The tick says "Sent for training" only once scan_feedback took it; a send that
// failed (offline, no token) is shown as not sent and tried again when the device is back online, with the next
// send, and when the page is left — then with keepalive (the request outlives the page; the copy is small).
import { DOCTYPE_LABELS, type Doctype } from '../engine/doctypes';
import type { DoctypeAnswer } from '../engine/readers';

export const KIND_WAIT = 20000;

/** One example as scan_feedback "add" takes it. */
export interface KindExample {
  source: 'page';
  model: string;
  doctypeModel: Doctype;
  doctypeFixed: Doctype;
  doctypeBy: 'model';
  pageImage: string;
  keep?: true;
}

/** What the collection takes of the page (the tests give their own). */
export interface KindsEnv {
  /** A request to scan_feedback with the signed-in user's token (attempts.ts post); keepalive when the page is left. */
  post(body: Record<string, unknown>, opts?: { keepalive?: boolean }): Promise<unknown>;
  /** The lab's model version (models.json). */
  version(): string;
  /** The 256×256 copy as base64 JPEG (no data: prefix). */
  encode(square: OffscreenCanvas): Promise<string>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Called when the page is left; returns the unsubscribe. */
  onPageHide(fn: () => void): () => void;
  /** Called when the device is back online; returns the unsubscribe. */
  onOnline(fn: () => void): () => void;
  /** The page is going away (hidden at pagehide): the sends then need keepalive. */
  leaving(): boolean;
  log(text: string): void;
  err(text: string): void;
}

/** The 256×256 copy as base64 JPEG 0.85, as the lab sent it. */
export async function squareJpeg(square: OffscreenCanvas): Promise<string> {
  const b = new Uint8Array(await (await square.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function defaultKindsEnv(post: KindsEnv['post'], version: KindsEnv['version'], log: KindsEnv['log'], err: KindsEnv['err']): KindsEnv {
  return {
    post, version, log, err,
    encode: squareJpeg,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    onPageHide: fn => { addEventListener('pagehide', fn); return () => removeEventListener('pagehide', fn); },
    onOnline: fn => { addEventListener('online', fn); return () => removeEventListener('online', fn); },
    leaving: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  };
}

/** A page's send: not yet (idle), on its way, taken by scan_feedback, failed (to be tried again), or never
 *  (the page deleted). */
export type KindState = 'idle' | 'sending' | 'sent' | 'failed' | 'dropped';
/** A page offered: the model's answer (the latest cut's), its copy, the type picked, its timer, its send (and
 *  the type a failed send was for). */
interface Job { model: Doctype; copy: Promise<string>; chosen: Doctype | null; timer: unknown; state: KindState; fixed?: Doctype }

export class Kinds {
  private readonly jobs = new Map<string, Job>();
  /** A type picked before the model's answer came (the chips are there while the page is read). */
  private readonly early = new Map<string, Doctype>();
  private readonly listeners = new Set<() => void>();
  private off: (() => void) | null = null;

  constructor(private readonly env: KindsEnv) {}

  /** The picks still waiting go when the page is left. */
  start(): void {
    if (this.off) return;
    const hide = this.env.onPageHide(() => { void this.flush(this.env.leaving()); }), online = this.env.onOnline(() => { void this.retry(); });
    this.off = () => { hide(); online(); };
  }
  stop(): void { if (this.off) { this.off(); this.off = null; } }

  /** Listen to a page being sent (the tick shows it); returns the unsubscribe. */
  on(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed(): void { for (const fn of this.listeners) { try { fn(); } catch { /* the listener's own */ } } }

  /** A page's document type answer (again on each cut: the latest stands until it is sent); nothing with no model. */
  offer(id: string, a: DoctypeAnswer | null): void {
    if (!a) return;
    const copy = this.env.encode(a.square);
    copy.catch(() => {});
    const j = this.jobs.get(id);
    if (j) { if (j.state === 'idle') { j.model = a.doctype; j.copy = copy; } return; }
    this.jobs.set(id, { model: a.doctype, copy, chosen: null, timer: null, state: 'idle' });
    const k = this.early.get(id);
    if (k) { this.early.delete(id); this.pick(id, k); }
    this.changed();
  }

  /** Whether the page has the model's answer (the tick is shown), whether scan_feedback took it, and whether it
   *  is on its way. */
  offered(id: string): boolean { return this.jobs.has(id); }
  sent(id: string): boolean { return this.jobs.get(id)?.state === 'sent'; }
  sending(id: string): boolean { return this.jobs.get(id)?.state === 'sending'; }

  /** A type picked on the page: sent KIND_WAIT after the last change (or when the page is left). */
  pick(id: string, kind: Doctype): void {
    const j = this.jobs.get(id);
    if (!j) { this.early.set(id, kind); return; }
    if (j.state !== 'idle' && j.state !== 'failed') return;
    j.state = 'idle'; j.fixed = undefined;
    j.chosen = kind;
    if (j.timer != null) this.env.clearTimeout(j.timer);
    j.timer = this.env.setTimeout(() => this.send(id), KIND_WAIT);
  }

  /** The tick: the type shown sent at once (keep when it is the model's). */
  tick(id: string, shown?: Doctype | null): void {
    const j = this.jobs.get(id);
    if (!j || (j.state !== 'idle' && j.state !== 'failed')) return;
    void this.send(id, shown || j.chosen || j.model);
  }

  /** The page deleted: nothing of it is sent. */
  drop(id: string): void {
    this.early.delete(id);
    const j = this.jobs.get(id);
    if (!j) return;
    if (j.timer != null) this.env.clearTimeout(j.timer);
    j.timer = null; j.state = 'dropped';
  }

  /** The picks still waiting and the sends that failed, sent now (the page is left: keepalive); resolves once
   *  they are all answered. */
  flush(keepalive = false): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [id, j] of this.jobs) {
      if (j.state === 'idle' && j.timer != null) sends.push(this.send(id, undefined, keepalive));
      else if (j.state === 'failed') sends.push(this.send(id, j.fixed, keepalive));
    }
    return Promise.all(sends).then(() => {});
  }

  /** The sends that failed, tried again (back online, or with the next send). */
  private retry(): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const [id, j] of this.jobs) if (j.state === 'failed') sends.push(this.send(id, j.fixed));
    return Promise.all(sends).then(() => {});
  }

  private send(id: string, fixed?: Doctype, keepalive = false): Promise<void> {
    const j = this.jobs.get(id);
    if (!j || (j.state !== 'idle' && j.state !== 'failed')) return Promise.resolve();
    const again = j.state === 'failed';
    j.state = 'sending';
    if (j.timer != null) this.env.clearTimeout(j.timer);
    j.timer = null;
    const kind = fixed || j.chosen || j.model, model = j.model, version = this.env.version();
    j.fixed = kind;
    this.changed();
    if (!again && !keepalive) void this.retry();
    return j.copy.then(pageImage => {
      const ex: KindExample = { source: 'page', model: version, doctypeModel: model, doctypeFixed: kind, doctypeBy: 'model', pageImage };
      if (kind === model) ex.keep = true;
      return this.env.post({ action: 'add', examples: [ex] }, keepalive ? { keepalive: true } : undefined);
    }).then(() => {
      if (j.state === 'sending') j.state = 'sent';
      this.env.log('Document type sent for training: ' + DOCTYPE_LABELS[kind] + (kind === model ? " (the model's, confirmed)" : ' (the model said ' + DOCTYPE_LABELS[model] + ')'));
    }, e => {
      if (j.state === 'sending') j.state = 'failed';
      this.env.err('Document type not sent (tried again when back online): ' + ((e as Error)?.message || e));
    }).finally(() => this.changed());
  }
}
