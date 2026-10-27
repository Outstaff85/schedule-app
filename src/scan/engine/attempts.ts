// The scanner's engine (docs/scan-plan.md → S9): the training attempts — ported from the lab's former plain page
// (newAttempt, decideAttempts, doneAttempts, trainDb / trainStore, queueAttempt, attemptPageDeleted, trainPost,
// flushAttempts, trainFigures; docs/scan-training.md). Every attempt goes for training: a camera shot or a
// picked picture, with the photo (at most 1600 px, JPEG 0.85), the models' corners (the first document's, the
// others found on it), the corners set by hand (edgesFixed, edgesMoreFixed) and, once decided, how it went —
// kept (Looks good on each of its pages still shown, Done, or left alone at Done), retaken (Retake: the next shot shares its
// group) or a page deleted. Sent to scan_feedback ('attempt') with the signed-in user's token (the surface's
// idToken); with no network it waits on the phone (IndexedDB 'scanAttempts'), 5 at most, an hour at most.
// On the site a kept attempt waits for Done (holdForDone: a window closed without Done sends nothing); the lab
// has no Done and sends it at once, and shows the new attempts since the last training (stats).
//
// Unlike the old lab, nothing is decided for the user (owner, 2026-10-24): a new shot or pick does not mark the
// pages before it as looked at — they stay undecided until Looks good, Retake, Done or a delete (the lab, with
// no Done: until the page is left, or beyond UNDECIDED_MAX undecided ones, the oldest sent as kept). The lab
// writes each attempt to the queue on the phone as soon as its photo is encoded, marked undecided (outcome unset;
// the row written again on a fix or a page deleted, and replaced once decided), so a tab swiped away or a
// browser killed before pagehide loses none: the next lab page sends another page's undecided rows as kept (as
// the site's Done keeps the ones left alone), in requests of QUEUE_MAX. Undecided rows are not the offline queue:
// they are left out of its 5 / an hour and of In queue, and the site never sends them. Every
// attempt not sent yet keeps its photo for the corner editor: the newest FRAMES_KEPT at full size, the older
// ones as their training picture (at most PICTURE_MAX px; the corners are shares of the photo, so the editor
// and the recut take either), dropped once it is sent, discarded or done.
import { SCAN_FEEDBACK_FN_URL } from '@/manager/logic/functions';
import { mkCanvas } from './upright';
import type { ScanSurface } from './surface';
import type { Pt, Quad } from './types';

/** scan_feedback: one copy of its URL (src/manager/logic/functions.ts), so a move of the function reaches the attempts too. */
export const TRAIN_URL = SCAN_FEEDBACK_FN_URL;
export const QUEUE_MAX = 5, QUEUE_MS = 3600e3, PICTURE_MAX = 1600, FRAMES_KEPT = 6, UNDECIDED_MAX = 24;
const DB = 'scanAttempts', STORE = 'queue';

export type AttemptInput = 'camera' | 'photo' | 'pdf';
export type Outcome = 'kept' | 'retaken';

/** One attempt as scan_feedback takes it. */
export interface AttemptData {
  id: string;
  group: string;
  source: 'site' | 'lab';
  input: AttemptInput;
  /** The photo, JPEG base64 (no data: prefix). */
  picture: string;
  edgesModel: Quad | null;
  edgesMore: Quad[];
  edgesFixed: Quad | null;
  edgesMoreFixed: (Quad | null)[];
  model: string;
  way: string;
  pages: number;
  deletedPages: number[];
  outcome?: Outcome;
}

/** Where an attempt's model corners are read from when it is sent (the shot's record, still growing while the
 *  other documents are looked for). */
export interface EdgeSource { edgesModel: Quad | null; edgesMore: Quad[]; pages: number }

/** A photo kept for the corner editor. */
export interface KeptFrame { frame: OffscreenCanvas; w: number; h: number }
/** An unsent attempt's photos: the full-size one (the newest FRAMES_KEPT only) and its training picture. */
interface Frames { full: KeptFrame | null; small: KeptFrame }

interface Live { a: Omit<AttemptData, 'picture'>; picture: Promise<string>; src: EdgeSource | null }
/** A row of the queue on the phone; `undecided` (the lab): not decided yet, by the page it names. */
interface Queued { a: AttemptData; at: number; undecided?: string }

/** What the attempts take of the browser (the tests give stand-ins). */
export interface AttemptsEnv {
  idb: IDBFactory | null;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; keepalive?: boolean }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now(): number;
  online(): boolean;
  /** A canvas → JPEG 0.85 base64. */
  encode(c: OffscreenCanvas): Promise<string>;
  newId(): string;
  setTimeout(fn: () => void, ms: number): void;
  /** Calls fn when the device is back online; returns the unsubscribe. */
  onOnline(fn: () => void): () => void;
}

async function jpegBase64(c: OffscreenCanvas): Promise<string> {
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function defaultAttemptsEnv(): AttemptsEnv {
  const g = globalThis as unknown as { indexedDB?: IDBFactory; navigator?: { onLine?: boolean }; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
  let idb: IDBFactory | null = null;
  try { idb = g.indexedDB || null; } catch { /* blocked */ }
  return {
    idb,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    online: () => !g.navigator || g.navigator.onLine !== false,
    encode: jpegBase64,
    newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    setTimeout: (fn, ms) => { setTimeout(fn, ms); },
    onOnline: fn => {
      if (!g.addEventListener) return () => {};
      g.addEventListener('online', fn);
      return () => { if (g.removeEventListener) g.removeEventListener('online', fn); };
    },
  };
}

/** The queue's and the lab's figures: the attempts waiting on the phone, the new ones since the last training. */
export interface TrainFigures { waiting: number; fresh: { n: number; at: number } | null }

const copyQ = (q: Quad): Quad => q.map(p => p.slice() as Pt);
const errText = (e: unknown): string => String((e as Error)?.message || e);

export class Attempts {
  readonly env: AttemptsEnv;
  /** The site's scan window: a kept attempt waits for Done. */
  holdForDone: boolean;
  /** The model version the attempts name. */
  modelsVersion = '';
  /** Attempt id → its folder on the server (for a page deleted later). */
  readonly attemptDirs = new Map<string, string>();
  /** Told the folders the server gave each batch of attempts sent ({attempt id: folder}): the site's scan window
   *  keeps its scan's, to tell them "saved" with the worker's id when the worker window saves (src/scan/server.ts). */
  onDirs: ((dirs: Record<string, string>) => void) | null = null;
  /** Attempts not decided yet (their pages on the screen). */
  private onScreen: Live[] = [];
  /** Kept, waiting for Done (the site). */
  heldForDone: Live[] = [];
  private retakeGroup: string | null = null;
  private frames = new Map<string, Frames>();
  /** Decided, its photo being encoded: a page deleted now goes with it. */
  private readonly queuing = new Map<string, Live>();
  /** The writes to the queue on the phone still running (settle waits for them). */
  private readonly writing = new Set<Promise<void>>();
  /** The queue where the phone keeps no IndexedDB (a private window): in memory, sent all the same. */
  private readonly mem = new Map<string, Queued>();
  private flushing: Promise<void> | null = null;
  private again = false;
  private readonly lateDeletes = new Map<string, number[]>();
  private fresh: TrainFigures['fresh'] = null;
  private figuresAt = 0;
  private listeners = new Set<(f: TrainFigures) => void>();
  private offOnline: (() => void) | null = null;
  /** This page's mark on its undecided rows: a row marked by another page is left over from a page gone without
   *  being left (its tab swiped away, the browser killed). */
  private readonly owner = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  /** Attempt id -> the end of its writes to the queue on the phone (each attempt's rows written in order). */
  private readonly rowChain = new Map<string, Promise<void>>();

  constructor(readonly surface: ScanSurface, private log: { log(t: string): void; err(t: string): void }, env: Partial<AttemptsEnv> = {}) {
    this.env = { ...defaultAttemptsEnv(), ...env };
    this.holdForDone = surface.source === 'site';
  }

  /** The queue flushed when the device comes back online, and once 3 s after the scanner opens (with the lab's
   *  figures). */
  start(): void {
    if (!this.offOnline) this.offOnline = this.env.onOnline(() => { void this.flush(); });
    this.env.setTimeout(() => { void this.flush(); void this.figures(true); }, 3000);
  }
  stop(): void { if (this.offOnline) { this.offOnline(); this.offOnline = null; } }

  /** Listen to the queue's figures; returns the unsubscribe. */
  // a new listener is told the queue as it is now (a window opened, or subscribed a moment late, over attempts already
  // waiting showed nothing until the next change)
  on(fn: (f: TrainFigures) => void): () => void {
    this.listeners.add(fn);
    void this.waiting().then(n => { if (this.listeners.has(fn)) { try { fn({ waiting: n, fresh: this.surface.source === 'lab' ? this.fresh : null }); } catch { /* the listener's own */ } } }, () => {});
    return () => { this.listeners.delete(fn); };
  }
  private show(waiting: number): void {
    const f: TrainFigures = { waiting, fresh: this.surface.source === 'lab' ? this.fresh : null };
    for (const fn of this.listeners) { try { fn(f); } catch { /* the listener's own */ } }
  }

  /** A new attempt for a photo (frame, w×h): its picture at most PICTURE_MAX px, the next one after a Retake
   *  sharing its group; src gives the model's corners when it is sent. Its photo is kept for the corner editor
   *  until it is sent: at full size while it is among the newest FRAMES_KEPT, then as its training picture.
   *  The lab (no Done) sends its oldest undecided attempt as kept beyond UNDECIDED_MAX (memory). */
  newAttempt(frame: OffscreenCanvas, w: number, h: number, input: AttemptInput, meta: { id?: string; way?: string; model?: string; src?: EdgeSource | null } = {}): AttemptData['id'] {
    const k = Math.min(1, PICTURE_MAX / Math.max(w, h)), c = mkCanvas(Math.round(w * k), Math.round(h * k));
    (c.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(frame, 0, 0, c.width, c.height);
    const id = meta.id || this.env.newId();
    const a: Live['a'] = { id, group: this.retakeGroup || id, source: this.surface.source, input,
      edgesModel: null, edgesMore: [], edgesFixed: null, edgesMoreFixed: [], model: meta.model ?? this.modelsVersion, way: meta.way || '', pages: 1, deletedPages: [] };
    const picture = this.env.encode(c).catch(e => { this.log.err('Training photo: ' + errText(e)); return ''; });
    this.retakeGroup = null;
    const live: Live = { a, picture, src: meta.src || null };
    this.onScreen.push(live);
    this.keepOnPhone(live);
    this.frames.set(id, { full: { frame, w, h }, small: { frame: c, w: c.width, h: c.height } });
    for (const key of [...this.frames.keys()].slice(0, -FRAMES_KEPT)) (this.frames.get(key) as Frames).full = null;  // full size: the newest few only (memory)
    if (!this.holdForDone && this.onScreen.length > UNDECIDED_MAX) this.decide('kept', this.onScreen.slice(0, this.onScreen.length - UNDECIDED_MAX).map(x => x.a.id));
    return id;
  }

  /** The photo kept for the corner editor — full size when still kept, else its training picture —, or
   *  undefined when it is gone (sent, retaken, discarded or done). */
  frameOf(id: string): KeptFrame | undefined { const f = this.frames.get(id); return f ? f.full || f.small : undefined; }

  /** Not sent yet (on the screen or waiting for Done): its corners can still be fixed, its pages deleted with it. */
  private unsent(id: string): Live | undefined { return this.onScreen.find(x => x.a.id === id) || this.heldForDone.find(x => x.a.id === id); }
  /** Not sent yet: its corners can still be fixed. */
  canFix(id: string): boolean { return !!this.unsent(id); }
  /** Undecided: on the screen, not looked at yet. */
  undecided(id: string): boolean { return this.onScreen.some(x => x.a.id === id); }
  /** The attempts not decided yet, oldest first (the lab sends them as kept when the page is left: it has no
   *  Done). */
  undecidedIds(): string[] { return this.onScreen.map(x => x.a.id); }
  /** How it went, once decided (null while undecided or unknown). */
  outcomeOf(id: string): Outcome | null { const l = this.unsent(id); return (l && l.a.outcome) || null; }

  /** The model's corners the corner editor starts from on page pg (the ones fixed by hand first). */
  cornersOf(id: string, pg: number): Quad | null {
    const l = this.unsent(id); if (!l) return null;
    const src = l.src || l.a;
    return (pg ? l.a.edgesMoreFixed[pg - 1] || src.edgesMore[pg - 1] : l.a.edgesFixed || src.edgesModel) || null;
  }

  /** The corners set by hand on page pg: the right answer (edgesFixed, or edgesMoreFixed[pg-1]). False when the
   *  attempt was sent already. */
  fixed(id: string, pg: number, pts: Quad): boolean {
    const l = this.unsent(id); if (!l) return false;
    if (pg) {
      const more = (l.src || l.a).edgesMore.length;
      while (l.a.edgesMoreFixed.length < Math.max(more, pg)) l.a.edgesMoreFixed.push(null);
      l.a.edgesMoreFixed[pg - 1] = copyQ(pts);
    } else l.a.edgesFixed = copyQ(pts);
    this.keepOnPhone(l);
    return true;
  }

  /** Decide the attempts (all those on the screen, or the ones named): kept — sent, or held for Done on the
   *  site —, or retaken — sent, the next attempt sharing its group. */
  decide(outcome: Outcome, ids?: string[]): void {
    const list = ids ? this.onScreen.filter(x => ids.includes(x.a.id)) : this.onScreen;
    this.onScreen = this.onScreen.filter(x => !list.includes(x));
    if (outcome === 'retaken' && list.length) this.retakeGroup = list[0].a.group;
    for (const l of list) {
      l.a.outcome = outcome;
      if (outcome === 'kept' && this.holdForDone) this.heldForDone.push(l);
      else { this.frames.delete(l.a.id); void this.queue(l); }  // sent: it can no longer be fixed
    }
  }

  /** Done (the site): every attempt left on the screen kept, and every kept one sent; their photos are no longer
   *  kept (sent: they can no longer be fixed). */
  done(): void {
    this.decide('kept');
    const list = this.heldForDone; this.heldForDone = [];
    for (const l of list) void this.queue(l);
    this.frames.clear();
  }

  /** The window closed without Done: the attempts on it are forgotten (nothing is sent), their photos too (and
   *  the lab's undecided rows on the phone). */
  drop(): void {
    if (!this.holdForDone) for (const l of this.onScreen) { const id = l.a.id; this.track(this.chained(id, () => this.del(id))); }
    this.onScreen = []; this.heldForDone = []; this.frames.clear(); this.retakeGroup = null;
  }

  /** fn run after the earlier writes of attempt id's rows (even a failed one). */
  private chained(id: string, fn: () => Promise<void>): Promise<void> {
    const p = (this.rowChain.get(id) || Promise.resolve()).then(fn, fn);
    const tail = p.catch(() => {});
    this.rowChain.set(id, tail);
    void tail.then(() => { if (this.rowChain.get(id) === tail) this.rowChain.delete(id); });
    return p;
  }
  /** A write to the queue on the phone that settle() waits for. */
  private track(w: Promise<void>): void {
    const t = w.catch(() => {});
    this.writing.add(t);
    void t.then(() => { this.writing.delete(t); });
  }

  /** The lab (no Done): an undecided attempt written to the queue on the phone as it now is (its photo once
   *  encoded, the corners fixed, the pages deleted), marked undecided by this page - so a page gone without
   *  pagehide loses none of them. Skipped once decided: its decided row follows (chained after this one). */
  private keepOnPhone(l: Live): void {
    if (this.holdForDone || !this.onScreen.includes(l)) return;
    this.track(this.chained(l.a.id, async () => {
      if (!this.onScreen.includes(l)) return;
      const a = await this.data(l);
      if (this.onScreen.includes(l)) await this.put({ a, at: this.env.now(), undecided: this.owner });
    }));
  }

  private async data(l: Live): Promise<AttemptData> {
    const src = l.src;
    const edges = src ? { edgesModel: src.edgesModel ? copyQ(src.edgesModel) : null, edgesMore: src.edgesMore.map(copyQ), pages: src.pages } : {};
    return { ...l.a, ...edges, picture: await l.picture };
  }

  private db(): Promise<IDBDatabase> {
    const idb = this.env.idb;
    if (!idb) return Promise.reject(new Error('no IndexedDB'));
    return new Promise((ok, no) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'a.id' });
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
  }
  private async store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const d = await this.db();
    try { return await new Promise<T>((ok, no) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); }
    finally { d.close(); }
  }
  /** The attempts waiting on the phone. */
  queued(): Promise<Queued[]> {
    const mem = (): Queued[] => [...this.mem.values()];
    return this.store<Queued[]>('readonly', s => s.getAll() as IDBRequest<Queued[]>).then(r => [...r, ...mem()], mem);
  }
  private async put(q: Queued): Promise<void> {
    try { await this.store('readwrite', s => s.put(q)); } catch { this.mem.set(q.a.id, q); }  // no storage here: kept in memory
  }
  private async del(id: string): Promise<void> {
    this.mem.delete(id);
    await this.store('readwrite', s => s.delete(id)).catch(() => {});
  }

  /** Decided: its photo encoded, then written to the queue and sent. It stays in `queuing` until the write is
   *  over, and is written again when a page was deleted meanwhile (a shares l.a's deletedPages, but the
   *  IndexedDB write copies it when it begins), so no deleted page is lost on the way. */
  private async queue(l: Live): Promise<void> {
    this.queuing.set(l.a.id, l);
    const write = this.chained(l.a.id, async () => {  // after its undecided rows (the lab), never overwritten by one
      try {
        const a = await this.data(l), at = this.env.now();
        let n = -1;
        while (n !== a.deletedPages.length) { n = a.deletedPages.length; await this.put({ a, at }); }
      } finally { this.queuing.delete(l.a.id); }
    });
    this.writing.add(write);
    try { await write; } finally { this.writing.delete(write); }
    await this.flush();
  }

  /** Every attempt decided so far written to the queue on the phone (the lab waits for it before it reloads:
   *  they are sent on the next open). */
  async settle(): Promise<void> {
    while (this.writing.size) await Promise.allSettled([...this.writing]);
  }

  /** A page of an attempt deleted: with it when not sent yet; told to the server when sent; told once its
   *  folder is known when on its way; else written into the queued one. */
  async pageDeleted(id: string, pg: number): Promise<void> {
    if (!id) return;
    const held = this.unsent(id) || this.queuing.get(id);
    if (held) { held.a.deletedPages.push(pg); this.keepOnPhone(held); return; }  // not sent yet: it goes with its deleted pages
    const dir = this.attemptDirs.get(id);
    if (dir) { await this.post({ action: 'attemptOutcome', dir, outcome: 'deleted', page: pg }).catch(() => {}); return; }
    if (this.flushing) { this.lateDeletes.set(id, [...(this.lateDeletes.get(id) || []), pg]); return; }  // on its way: told once its folder is known
    const m = this.mem.get(id);
    if (m) { m.a.deletedPages.push(pg); return; }
    try {
      const item = await this.store<Queued | undefined>('readonly', s => s.get(id) as IDBRequest<Queued | undefined>);
      if (item) { item.a.deletedPages.push(pg); await this.store('readwrite', s => s.put(item)); }
    } catch { /* gone already */ }
  }

  /** A request to scan_feedback with the signed-in user's token; keepalive: it outlives the page being left (a
   *  small body only — the browser takes 64 KB at most — so never an attempt with its photo). */
  async post(body: Record<string, unknown>, opts: { keepalive?: boolean } = {}): Promise<Record<string, unknown>> {
    const token = await this.surface.idToken().catch(() => null);
    if (!token) throw new Error('not signed in');
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), ...(opts.keepalive ? { keepalive: true } : {}) };
    const r = await this.env.fetch(TRAIN_URL, init);
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (!r.ok || !j || !j.ok) throw new Error(String((j && j.error) || 'HTTP ' + r.status));
    return j;
  }

  /** The attempts waiting to be sent (the undecided rows are not waiting). */
  private async waiting(): Promise<number> { return (await this.queued()).filter(x => !x.undecided).length; }

  /** The queue sent (the old ones dropped: over an hour, or beyond the newest 5), QUEUE_MAX a request (the
   *  server takes 10 at most); kept when it fails. The undecided rows are left alone, except in the lab another
   *  page's (gone without being left): written as kept and sent too - after the 5 / an hour are applied, so none
   *  is lost online; offline they are then ordinary queued attempts. */
  flush(): Promise<void> {
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      const all = (await this.queued()).sort((x, y) => x.at - y.at);
      let items = all.filter(x => !x.undecided);
      const now = this.env.now();
      const old = items.filter((x, i) => now - x.at > QUEUE_MS || i < items.length - QUEUE_MAX);
      for (const x of old) await this.del(x.a.id);
      items = items.filter(x => !old.includes(x));
      if (!this.holdForDone) {
        const left = all.filter(x => x.undecided && x.undecided !== this.owner);
        for (const x of left) { const kept: Queued = { a: { ...x.a, outcome: 'kept' }, at: now }; await this.put(kept); items.push(kept); }
        if (left.length) this.log.log('Training: ' + left.length + ' attempt(s) left undecided by an earlier page sent as kept');
      }
      if (items.length && this.env.online()) {
        try {
          while (items.length) {
            const batch = items.slice(0, QUEUE_MAX);
            const j = await this.post({ action: 'attempt', attempts: batch.map(x => x.a) });
            if (j.dirs && typeof j.dirs === 'object' && this.onDirs) { try { this.onDirs(j.dirs as Record<string, string>); } catch { /* the listener's own */ } }
            for (const [id, dir] of Object.entries((j.dirs || {}) as Record<string, string>)) {
              this.attemptDirs.set(id, dir);
              for (const pg of this.lateDeletes.get(id) || []) void this.post({ action: 'attemptOutcome', dir, outcome: 'deleted', page: pg }).catch(() => {});
              this.lateDeletes.delete(id);
            }
            for (const x of batch) await this.del(x.a.id);
            items = items.slice(batch.length);
          }
          void this.figures(true);
        } catch (e) { this.log.log('Training: kept on the phone (' + errText(e) + ')'); }
      }
      this.show(items.length);
    })().finally(() => { this.flushing = null; if (this.again) { this.again = false; void this.flush(); } });
    return this.flushing;
  }

  /** The lab's "New for training": the new attempts since the last training (a super-admin's; anyone else is
   *  refused, and nothing shows). At most once a minute unless now. */
  async figures(now = false): Promise<void> {
    if (this.surface.source !== 'lab' || (!now && this.env.now() - this.figuresAt < 60e3)) return;
    this.figuresAt = this.env.now();
    try { const j = await this.post({ action: 'stats' }); this.fresh = { n: Number(j.attemptsSince) || 0, at: Number(j.attemptsAt) || 15 }; } catch { this.fresh = null; }
    this.show(await this.waiting());
  }
}
