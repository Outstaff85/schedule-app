// The scan window (docs/scan.md → The scan window): the full-screen scanner (src/scan/ui/ScannerScreen.tsx, mode
// 'site') in a full Window, driving a scan session on the site's own surface (/scan/ and its models — never the
// lab's, CLAUDE.md → Scanner: the lab and the site are apart). The session — its engines and the models they
// loaded — outlives the window by 3 minutes (keep.ts), so the next worker's scan opens at once.
//
// Every page the session cuts (a camera shot — batch s<n> —, or the pictures of one pick — f<n>) is typed once
// its readouts are there: by Haiku, or by the document type model as Admin → Scanner says (Off / Shadow / Mixed —
// in Mixed the model's type is taken when it is sure of it, SURE); its turn (turn.ts) is the face's, else the
// model's when it is sure of the turn (Shadow and Mixed), else Haiku's — 90, 180 or 270° clockwise: a page so
// turned is set upright (and what the zone and field readers read on it is dropped). A page typed Other is
// not saved. The pages are kept on this phone until Done has read them (store.ts, 3 minutes), with the type
// picked by hand on them: a window closed by mistake opens again with them, first in the strip (and so do the
// pages from before a Scan again — 'before'). Done waits for the pages' types (the pages as they are then: a
// type picked meanwhile counts; at most WAIT_MS, then a page not typed goes untyped — the scan process types it),
// sends the scan's training attempts (held until Done), runs the scan process (read, src/scan-process/) with
// its progress in the window — an error text keeps the window open with the pages — and then gives the pages
// (onDone) and sends the pages' document type examples — each with the scan's session id, the worker's id on a
// known worker's scan, and who set its turn (the face finder, or whoever typed it). The scan's attempts are kept
// by server.ts (their ids from the pages, their folders as the server gives them back) and told the worker's id
// when the worker window saves. A typing that ends after the window closed (or after
// Done) gives nothing back to the session: its scan is over (gen). The phone's back closes the step on top inside
// it, then the window, as closing it by hand does (ui/back.ts).
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { Window } from '@/components/shared/window';
import { loadFirestoreBackend } from '@/manager/data/api';
import { DOCTYPES, detectDoctype, pageCopy, type Doctype } from './doctype';
import { attemptFolders, doctypeMode, scanAttempts, scanSessionId, sendFeedback, type DoctypeMode, type Example } from './server';
import { loadBatches, saveBatches } from './store';
import { engineStatusText } from './status-text';
import { prepareEarly, releaseSession, takeSession } from './keep';
import { ScanSession } from './engine/session';
import { siteSurface } from './engine/surface';
import { QUEUE_MAX } from './engine/attempts';
import { turned } from './engine/upright';
import { finalTurn, modelPick, type ModelPick } from './turn';
import type { ShotPage } from './engine/shot';
import type { SessionStatus } from './engine/status';
import { ScannerScreen } from './ui/ScannerScreen';
import { useBack } from './ui/back';
import { kindOf, type KeptPage, type PageTyping, type ScanSessionLike, type UiPage } from './ui/useScanSession';

/** The Hebrew field reader's fields on an ID card (docs/hf-plan.md → H8c; the readers' heRead): the card layout it
 * found and each field as written — only kept beside the AI's read. */
export type HeFields = { layout?: string; surname?: string; given?: string; idNo?: string; dob?: string; expiry?: string; idOk?: boolean };
const HE_KEYS = ['layout', 'surname', 'given', 'idNo', 'dob', 'expiry'] as const;
/** The fields as read, cleaned: known keys only, short strings; undefined when there are none. */
function cleanHe(v: unknown): HeFields | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>, out: HeFields = {};
  for (const k of HE_KEYS) if (typeof o[k] === 'string' && o[k]) out[k] = (o[k] as string).slice(0, 60);
  if (typeof o.idOk === 'boolean') out.idOk = o.idOk;
  return out.layout ? out : undefined;
}

/** mrz: the passport zone reader's lines on the page (docs/hf-plan.md → H8b), he: the Hebrew field reader's
 * fields (H8c) — only kept beside the AI's read. */
export type ScannedPage = { b64: string; mediaType: string; turn: number; blurry: boolean; kind?: Doctype; mrz?: string[]; he?: HeFields };

/** read: the scan process run on Done (src/scan-process/) — the window shows its progress
 * and closes when it succeeds; an error text keeps the window open with the pages. */
export type ReadFn = (pages: ScannedPage[], progress: (label: string, pct: number) => void) => Promise<string | null>;

/** A page as the window keeps it (on the phone too): what Done gives, and how it was typed — Haiku's or the
 * model's type (doctypeModel, doctypeBy), the model's answer beside it (modelSaid) and, in Shadow, kept for the
 * example (doctypeShadow); turnBy: who set the turn the page is at — the face finder when it set the page upright
 * by its face (the cut's turn ≥ 0), else the same who gave its type. */
type Stored = ScannedPage & { id: string; doctypeModel?: Doctype | null; doctypeBy?: 'haiku' | 'model'; doctypeShadow?: Doctype; modelSaid?: Doctype; turnBy?: 'face' | 'haiku' | 'model' };
/** A batch: a camera shot (s<n>), the pictures of one pick (f<n>), or the pages before a Scan again. */
type Batch = { key: string; source: 'camera' | 'file' | 'before'; pages: Stored[] };
/** A page kept from before, with its batch. */
type KeptStored = Stored & { batch: string; source: Batch['source'] };
/** How a page of this session was typed, with its picture as it is given. */
type Typed = Omit<Stored, 'id' | 'turn' | 'blurry'> & { kind?: Doctype };

/** The statuses of a shot still in work: its pages are typed once it settles (a refined cut would be typed again). */
const SHOT_WORK = new Set<SessionStatus['key']>(['captured', 'refining', 'looking_more']);
/** How long Done waits for the pages' types before it goes on without the ones still missing. */
const WAIT_MS = 30e3;
let rightSeen = 0; // one right page in five keeps its copy (the document type model's examples)
let nextBefore = 0;

/** The pages' training examples (functions/feedback.py, source "page"): every page with a type from
 * Haiku or the model — a changed one with its copy, one right page in five with its copy too —, each with the
 * scan's session id, the worker's id when known, and who set its turn. */
async function examples(pages: Stored[], workerId?: string): Promise<Example[]> {
  const out: Example[] = [], sessionId = scanSessionId();
  for (const p of pages) {
    if (!p.doctypeModel) continue;
    const fixed = p.kind || p.doctypeModel, changed = fixed !== p.doctypeModel, keep = !changed && rightSeen++ % 5 === 0;
    const copy = changed || keep ? await pageCopy(p.b64, p.mediaType).catch(() => undefined) : undefined;
    if (changed && !copy) continue;
    out.push({ source: 'page', doctypeModel: p.doctypeModel, doctypeFixed: fixed, doctypeBy: p.doctypeBy || 'haiku',
      ...(p.doctypeShadow ? { doctypeShadow: p.doctypeShadow } : {}), ...(copy ? { pageImage: copy } : {}), ...(keep && copy ? { keep: true } : {}),
      sessionId, ...(workerId ? { workerId } : {}), turnBy: p.turnBy || p.doctypeBy || 'haiku' });
  }
  return out;
}

/** A canvas as JPEG base64 (no data: prefix). */
async function jpegB64(c: OffscreenCanvas, quality: number): Promise<string> {
  const b = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const isDoctype = (k: unknown): k is Doctype => (DOCTYPES as readonly unknown[]).includes(k);
const batchOf = (p: ShotPage): { key: string; source: Batch['source'] } =>
  (p.record.shot > 0 ? { key: 's' + p.record.batch, source: 'camera' } : { key: 'f' + p.record.batch, source: 'file' });

/** The signed-in user's ID token for the training attempts (scan_feedback), null when there is none. */
async function idToken(): Promise<string | null> {
  try { return await (await loadFirestoreBackend()).idToken(); } catch { return null; }
}
/** The site's scan session (made once, kept 3 minutes after the window closes: keep.ts). */
const newSiteSession = (): ScanSession => new ScanSession(siteSurface(idToken));
/** The site's session started ahead of the window (keep.ts prepareEarly; open.tsx prepareScanEarly). */
export const prepareSiteEarly = (): boolean => !!prepareEarly(newSiteSession);

/** The session as the screen drives it, with the window told of each page deleted. */
function siteView(s: ScanSession, removed: (id: string) => void): ScanSessionLike {
  return {
    get auto() { return s.auto; },
    on: (ev, fn) => s.on(ev, fn),
    startCamera: v => s.startCamera(v),
    snap: () => s.snap(),
    setAuto: on => s.setAuto(on),
    wake: v => s.wake(v),
    sleep: () => s.sleep(),
    hold: () => s.hold(),
    resume: () => s.resume(),
    pick: files => s.pick(files),
    keep: id => s.keep(id),
    remove: id => { s.remove(id); removed(id); },
    fixable: id => s.fixable(id),
    fix: (id, pts) => s.fix(id, pts),
    done: () => s.done(),
    discard: () => s.discard(),
  };
}

export function Scanner({ open, onDone, onClose, initial, read, superAdmin, workerId }: {
  open: boolean; onDone: (pages: ScannedPage[]) => void; onClose: () => void;
  /** the worker scanned again, when the scan started from their window (sent with the pages' examples) */
  workerId?: string;
  /** a super-admin sees the document type model's chip on each page */
  superAdmin?: boolean;
  /** pages already scanned (this session's, for "Scan again"): shown first */
  initial?: ScannedPage[]; read?: ReadFn;
}) {
  // the site's session, taken when the window opens and kept 3 minutes after it closes (its camera stopped at once)
  const [session, setSession] = React.useState<ScanSession | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const s = takeSession(newSiteSession);
    setSession(s);
    void s.prepare();
    return () => releaseSession();
  }, [open]);

  // Admin → Scanner's mode, read when the window opens (shadow until it is known)
  const mode = React.useRef<Promise<DoctypeMode>>(Promise.resolve('shadow'));
  React.useEffect(() => { if (open) { mode.current = doctypeMode(); void sendFeedback(); } }, [open]);

  // the pages kept from before (the phone's batches, the pages before a Scan again), first in the strip
  const [kept, setKept] = React.useState<KeptStored[]>(() => (initial || []).map(p => ({ ...p, id: 'before:' + ++nextBefore, batch: 'before', source: 'before' as const, doctypeModel: null })));
  const keptRef = React.useRef(kept); keptRef.current = kept;
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (!open || restored.current || (initial && initial.length)) return;
    restored.current = true;
    void loadBatches<Batch>().then(old => {
      if (!old || !old.length) return;
      const back: KeptStored[] = [];
      for (const b of old) {
        if (!b || !Array.isArray(b.pages) || b.source === 'before') continue;
        for (const p of b.pages) {
          if (!p || typeof p.b64 !== 'string' || typeof p.mediaType !== 'string') continue;
          back.push({ ...p, id: typeof p.id === 'string' ? p.id : 'kept:' + ++nextBefore, kind: isDoctype(p.kind) ? p.kind : undefined, batch: String(b.key), source: b.source === 'camera' ? 'camera' : 'file' });
        }
      }
      setKept(xs => [...back.filter(p => !xs.some(x => x.id === p.id)), ...xs]);
    });
  }, [open, initial]);
  const keptPages = React.useMemo<KeptPage[]>(() => kept.map(p => ({ id: p.id, src: 'data:' + p.mediaType + ';base64,' + p.b64, kind: p.kind || null })), [kept]);

  // this session's pages: the latest cut of each (by id), how each was typed, and the cut each was typed on
  const shots = React.useRef(new Map<string, ShotPage>());
  const typed = React.useRef(new Map<string, Typed>());
  const typedOn = React.useRef(new Map<string, OffscreenCanvas>());
  const [typing, setTyping] = React.useState<Record<string, PageTyping>>({});
  const shotBusy = React.useRef(false);
  const forcing = React.useRef(false);
  const [engineText, setEngineText] = React.useState<string | undefined>(undefined);
  const [queue, setQueue] = React.useState(0);
  const [hint, setHint] = React.useState('');
  const [reading, setReading] = React.useState<{ label: string; pct: number } | null>(null);
  // this window's scan: bumped when it ends (closed, Done read, unmounted) — a typing still in work then gives
  // nothing back to the session, and Done stops waiting
  const gen = React.useRef(0);
  React.useEffect(() => () => { gen.current++; }, []);
  // the types picked by hand on this session's pages (kept on the phone with them; a kept page's goes into kept)
  const chosen = React.useRef(new Map<string, Doctype>());
  const [chosenTick, setChosenTick] = React.useState(0);
  const choose = React.useCallback((id: string, kind: Doctype) => {
    if (keptRef.current.some(x => x.id === id)) { setKept(xs => xs.map(x => (x.id === id ? { ...x, kind } : x))); return; }
    chosen.current.set(id, kind);
    setChosenTick(n => n + 1);
  }, []);

  const untype = (id: string) => {
    typed.current.delete(id);
    setTyping(t => { if (!(id in t)) return t; const n = { ...t }; delete n[id]; return n; });
  };

  // A page's type and turn (turn.ts): Mixed takes the model's type when it is sure of it, else Haiku's (Shadow
  // keeps the model's answer beside it); the turn is the face's (the page came upright), else the model's when it
  // is sure of the turn (Shadow and Mixed), else Haiku's — a page so turned is set upright and given back to the
  // session.
  const classify = React.useCallback(async (s: ScanSession, p: ShotPage) => {
    const canvas = p.canvas, g = gen.current;
    typedOn.current.set(p.id, canvas);
    const still = () => shots.current.get(p.id)?.canvas === canvas;
    // its picture: tried again lighter when the phone could not make it (low on memory); '' when it cannot be
    // made at all — the page is then recorded with no picture (Done leaves it out), so Done never waits on it
    const b64 = await jpegB64(canvas, 0.9).catch(() => jpegB64(canvas, 0.7)).catch(() => '');
    let kind: Doctype | null = null, rotate = 0, m: DoctypeMode = 'shadow', pick: ModelPick = modelPick('off', p.turn, null);
    try {
      m = await mode.current;
      pick = modelPick(m, p.turn, p.readouts?.doctype);
      const h = pick.haiku && b64 ? await detectDoctype(b64, 'image/jpeg') : { kind: null, rotate: 0 };
      kind = pick.kind || h.kind;
      rotate = finalTurn(p.turn, pick, h.rotate);
    } catch { kind = pick.kind; rotate = finalTurn(p.turn, pick, 0); }
    const a = pick.said, sure = !!pick.kind;
    if (!still()) return;  // cut again (or deleted) meanwhile: that cut is typed on its own
    const lines = p.readouts?.mrz?.lines, he = cleanHe(p.readouts?.he?.read);
    const t: Typed = { b64, mediaType: 'image/jpeg', doctypeModel: kind, doctypeBy: sure ? 'model' : 'haiku', turnBy: p.turn >= 0 ? 'face' : pick.rotate !== null ? 'model' : 'haiku',
      ...(kind ? { kind } : {}), ...(a ? { modelSaid: a.doctype } : {}), ...(m === 'shadow' && a ? { doctypeShadow: a.doctype } : {}),
      ...(Array.isArray(lines) ? { mrz: lines.filter(x => typeof x === 'string').slice(0, 2).map(x => x.slice(0, 60)) } : {}), ...(he ? { he } : {}) };
    // a page turned here was read by the zone reader and the field reader on its side: what they read says nothing
    if (b64 && [90, 180, 270].includes(rotate)) {
      try {
        const up = turned(canvas, rotate / 90) as OffscreenCanvas;
        const upB64 = await jpegB64(up, 0.92);
        if (!still()) return;
        t.b64 = upB64; delete t.mrz; delete t.he;
        // given back to the session only while this scan goes on (closed meanwhile: the page is still kept on
        // the phone, turned, but the scan that held it is over)
        if (gen.current === g) {
          const np: ShotPage = { ...p, canvas: up, page: { ...p.page, width: up.width, height: up.height } };
          typedOn.current.set(p.id, up);
          shots.current.set(p.id, np);
          s.inject(np);
        }
      } catch { /* kept as cut */ }
    }
    typed.current.set(p.id, t);
    setTyping(x => ({ ...x, [p.id]: { kind, pending: false } }));
  }, []);

  /** The pages read and not typed yet (a camera shot's once it settled), or all of them at Done — a page with no
   *  readouts then too (its search stopped: Haiku types it). */
  const typeWaiting = React.useCallback((s: ScanSession) => {
    for (const p of shots.current.values()) {
      if ((!p.readouts && !forcing.current) || typedOn.current.get(p.id) === p.canvas) continue;
      if (shotBusy.current && !forcing.current && p.record.shot > 0) continue;
      void classify(s, p);
    }
  }, [classify]);

  React.useEffect(() => {
    if (!session) return;
    let seen = false;
    const offs = [
      session.on('page', p => {
        shots.current.set(p.id, p);
        scanAttempts([p.record.attempt]);  // this scan's attempts: told the worker's id when the worker window saves
        if (typedOn.current.get(p.id) === p.canvas) return;  // typed on this cut already (or turned upright here)
        if (typedOn.current.has(p.id)) { typedOn.current.delete(p.id); untype(p.id); }  // a new cut: typed again once read
        typeWaiting(session);
      }),
      session.on('status', st => {
        if (!seen) { seen = true; setEngineText(undefined); }
        const busy = SHOT_WORK.has(st.key);
        if (busy !== shotBusy.current) { shotBusy.current = busy; if (!busy) typeWaiting(session); }
      }),
      // while the models load, the status line says so (plainly: no model files or GPU layouts on the site)
      session.log.on('status', st => { if (!seen) setEngineText(engineStatusText(st, false)); }),
      session.attempts.on(f => setQueue(f.waiting)),
    ];
    // the folders the server gives this session's attempts (sent at Done, or later from the queue — so it is left
    // set after the window closes): server.ts keeps this scan's for the worker window's save
    session.attempts.onDirs = attemptFolders;
    return () => offs.forEach(off => off());
  }, [session, typeWaiting]);

  // a page deleted (its Undo over): no longer typed nor kept on the phone
  const view = React.useMemo(() => (session ? siteView(session, id => { shots.current.delete(id); typedOn.current.delete(id); chosen.current.delete(id); untype(id); }) : null), [session]);

  // the batches kept on the phone, a moment after every change (cleared when Done has read them)
  const saveOn = React.useRef(true);
  React.useEffect(() => {
    if (!saveOn.current) return;
    const t = window.setTimeout(() => {
      const list: Batch[] = [];
      const put = (key: string, source: Batch['source'], p: Stored) => {
        let b = list.find(x => x.key === key);
        if (!b) list.push(b = { key, source, pages: [] });
        b.pages.push(p);
      };
      for (const { batch, source, ...p } of keptRef.current) if (source !== 'before') put(batch, source, p);
      for (const [id, shot] of shots.current) {
        const t = typed.current.get(id), k = chosen.current.get(id);
        if (!t || !t.b64) continue;
        const { key, source } = batchOf(shot);
        put(key, source, { id, turn: -1, blurry: false, ...t, ...(k ? { kind: k } : {}) });
      }
      void saveBatches(list);
    }, 400);
    return () => window.clearTimeout(t);
  }, [kept, typing, chosenTick]);

  const close = () => { gen.current++; session?.discard(); onClose(); };
  // the phone's back with nothing open inside: the window closed as by hand (back to where it was opened from —
  // never off the site; ui/back.ts)
  useBack(open, close);

  // Done: the camera stops, the types waited for (the pages as they are while it waits: `current`), the attempts
  // sent, the pages read (src/scan-process/)
  const finish = async (_shown: UiPage[], current: () => UiPage[]): Promise<boolean> => {
    if (!session) return false;
    const g = gen.current, until = Date.now() + WAIT_MS;
    setHint('');
    session.sleep();
    forcing.current = true;
    const mine = () => current().filter(u => !u.kept && shots.current.has(u.id));
    try {
      typeWaiting(session);
      while (gen.current === g && Date.now() < until && mine().some(u => !typed.current.has(u.id))) await new Promise(r => setTimeout(r, 100));
    } finally { forcing.current = false; }
    if (gen.current !== g) return false;  // the window closed meanwhile
    const shown = current();
    session.attempts.done();  // the scan's attempts go for training (held until Done)
    const list: Stored[] = [];
    for (const u of shown) {
      if (u.kept) {
        const k = keptRef.current.find(x => x.id === u.id);
        if (k) { const { batch: _b, source: _s, ...p } = k; list.push({ ...p, kind: u.chosen || p.kind }); }
        continue;
      }
      let t = typed.current.get(u.id);
      // not typed in time (or its picture could not be made then): its picture as it is now, untyped if it was
      // not typed (the scan process types it)
      if (!t || !t.b64) {
        const shot = shots.current.get(u.id), b64 = shot ? await jpegB64(shot.canvas, 0.9).catch(() => '') : '';
        if (b64) t = { ...(t || {}), b64, mediaType: 'image/jpeg' };
      }
      if (t && t.b64) list.push({ id: u.id, turn: -1, blurry: false, ...t, kind: u.chosen || chosen.current.get(u.id) || t.kind });
    }
    if (gen.current !== g) return false;
    void examples(list, workerId).then(sendFeedback);  // in the background, queued when offline
    const out: ScannedPage[] = list.filter(p => p.kind !== 'other').map(({ b64, mediaType, turn, blurry, kind, mrz, he }) => ({ b64, mediaType, turn, blurry, kind, ...(mrz ? { mrz } : {}), ...(he ? { he } : {}) }));
    if (read) {
      setReading({ label: tr('Reading the pages…'), pct: 2 });
      let err: string | null;
      try { err = await read(out, (label, pct) => setReading({ label, pct })); }
      catch (e) { err = tr('The pages could not be read: {0}', { 0: (e as Error)?.message || String(e) }); }
      if (gen.current !== g) return false;
      if (err) { setReading(null); setHint(err); session.wake(); return false; }
    }
    gen.current++;  // this scan is over: a typing still in work gives nothing back
    saveOn.current = false; void saveBatches([]);  // read: nothing left to keep on the phone
    session.done();
    shots.current.clear(); typed.current.clear(); typedOn.current.clear(); chosen.current.clear();
    onDone(out);
    return true;
  };

  // under a thumbnail: Not saved on a page typed Other; a super-admin sees how the document type model did on the
  // page (docs/scan.md → The scan window) — its own pick, or beside the AI's: the same as the AI's, or not
  const note = (p: UiPage) => {
    const t: Partial<Stored> | undefined = p.kept ? kept.find(x => x.id === p.id) : typed.current.get(p.id);
    const model = !superAdmin || !t || !t.modelSaid ? null
      : t.doctypeBy === 'model' ? { text: tr('model'), ok: true }
      : t.modelSaid === t.doctypeModel ? { text: tr('model ✓'), ok: true } : { text: tr('model ≠ AI'), ok: false };
    if (!model && kindOf(p) !== 'other') return null;
    return (
      <span className="flex flex-wrap gap-1">
        {kindOf(p) === 'other' && <span data-testid="scan-not-saved" className="text-[11px] text-ink-2">{tr('Not saved')}</span>}
        {model && <span data-testid="scan-model" data-ok={model.ok ? '1' : '0'} className={'text-[11px] ' + (model.ok ? 'text-ok' : 'text-warn')}>{model.text}</span>}
      </span>
    );
  };

  return (
    <Window full open={open} onOpenChange={o => { if (!o) close(); }} title={tr('Scan documents')}
      description={tr('ID card, its appendix (ספח), passport — several pages and documents at once')}>
      {view && (
        <ScannerScreen mode="site" session={view} kept={keptPages} typing={typing} thumbNote={note} statusText={engineText}
          onRemoveKept={id => setKept(xs => xs.filter(x => x.id !== id))} onChoose={choose} onDone={finish}>
          {(hint || queue > 0) && (
            <div className="pointer-events-none absolute inset-x-4 top-[var(--scan-top,calc(76px+env(safe-area-inset-top,0px)))] z-10 flex flex-col items-start gap-1.5">
              {hint && <div data-testid="scan-error" role="alert" className="og-glass-menu !rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] text-[var(--amber-text)]">{hint}</div>}
              {queue > 0 && <div data-testid="scan-queue" className="og-glass-menu !rounded-full px-3 py-1 text-[12px] text-ink-2">{tr('In queue: {n} / {max}', { n: queue, max: QUEUE_MAX })}</div>}
            </div>
          )}
          {reading && (
            <div data-testid="scan-reading" className="absolute inset-0 z-40 grid place-items-center bg-background/90 px-6 backdrop-blur-md">
              <div className="grid w-full max-w-sm gap-3">
                <div className="text-center text-[14px] font-semibold text-ink-2">{reading.label}</div>
                <div className="h-1.5 overflow-hidden rounded-full bg-plate"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: reading.pct + '%' }} /></div>
              </div>
            </div>
          )}
        </ScannerScreen>
      )}
    </Window>
  );
}
