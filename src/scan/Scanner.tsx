// The scan window (docs/scan.md → The scan window): the full-screen scanner (src/scan/ui/ScannerScreen.tsx, mode
// 'site') in a full Window, driving a scan session on the site's own surface (/scan/ and its models — never the
// lab's, CLAUDE.md → Scanner: the lab and the site are apart). The session — its engines and the models they
// loaded — outlives the window by 3 minutes (keep.ts), so the next worker's scan opens at once.
//
// Every page the session cuts (a camera shot — batch s<n> —, or the pictures of one pick — f<n>) is typed once
// its readouts are there: by Haiku, or by the document type model as Admin → Scanner says (Off / Shadow / Mixed —
// in Mixed the model's answer is taken when it is sure of the type and the turn, SURE); a page Haiku says lies on
// its side is turned upright (and what the zone and field readers read on it is dropped). A page typed Other is
// not saved. The pages are kept on this phone until Done has read them (store.ts, 3 minutes): a window closed by
// mistake opens again with them, first in the strip (and so do the pages from before a Scan again — 'before').
// Done waits for the pages' types, sends the scan's training attempts (held until Done), runs the scan process
// (read, src/scan-process/) with its progress in the window — an error text keeps the window open with the
// pages — and then gives the pages (onDone) and sends the pages' document type examples.
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { Window } from '@/components/shared/window';
import { loadFirestoreBackend } from '@/manager/data/api';
import { DOCTYPES, detectDoctype, pageCopy, type Doctype } from './doctype';
import { doctypeMode, sendFeedback, type DoctypeMode, type Example } from './server';
import { loadBatches, saveBatches } from './store';
import { engineStatusText } from './status-text';
import { releaseSession, takeSession } from './keep';
import { ScanSession } from './engine/session';
import { siteSurface } from './engine/surface';
import { QUEUE_MAX } from './engine/attempts';
import { turned } from './engine/upright';
import type { ShotPage } from './engine/shot';
import type { SessionStatus } from './engine/status';
import { ScannerScreen } from './ui/ScannerScreen';
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
 * example (doctypeShadow). */
type Stored = ScannedPage & { id: string; doctypeModel?: Doctype | null; doctypeBy?: 'haiku' | 'model'; doctypeShadow?: Doctype; modelSaid?: Doctype };
/** A batch: a camera shot (s<n>), the pictures of one pick (f<n>), or the pages before a Scan again. */
type Batch = { key: string; source: 'camera' | 'file' | 'before'; pages: Stored[] };
/** A page kept from before, with its batch. */
type KeptStored = Stored & { batch: string; source: Batch['source'] };
/** How a page of this session was typed, with its picture as it is given. */
type Typed = Omit<Stored, 'id' | 'turn' | 'blurry'> & { kind?: Doctype };

/** How sure the model must be of the type and the turn for Mixed to skip Haiku (as the server's docfind.DOCTYPE_SURE was). */
const SURE = 0.9;
/** The statuses of a shot still in work: its pages are typed once it settles (a refined cut would be typed again). */
const SHOT_WORK = new Set<SessionStatus['key']>(['captured', 'refining', 'looking_more']);
let rightSeen = 0; // one right page in five keeps its copy (the document type model's examples)
let nextBefore = 0;

/** The pages' training examples (functions/feedback.py, source "page"): every page with a type from
 * Haiku or the model — a changed one with its copy, one right page in five with its copy too. */
async function examples(pages: Stored[]): Promise<Example[]> {
  const out: Example[] = [];
  for (const p of pages) {
    if (!p.doctypeModel) continue;
    const fixed = p.kind || p.doctypeModel, changed = fixed !== p.doctypeModel, keep = !changed && rightSeen++ % 5 === 0;
    const copy = changed || keep ? await pageCopy(p.b64, p.mediaType).catch(() => undefined) : undefined;
    if (changed && !copy) continue;
    out.push({ source: 'page', doctypeModel: p.doctypeModel, doctypeFixed: fixed, doctypeBy: p.doctypeBy || 'haiku',
      ...(p.doctypeShadow ? { doctypeShadow: p.doctypeShadow } : {}), ...(copy ? { pageImage: copy } : {}), ...(keep && copy ? { keep: true } : {}) });
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

export function Scanner({ open, onDone, onClose, initial, read, superAdmin }: {
  open: boolean; onDone: (pages: ScannedPage[]) => void; onClose: () => void;
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

  const untype = (id: string) => {
    typed.current.delete(id);
    setTyping(t => { if (!(id in t)) return t; const n = { ...t }; delete n[id]; return n; });
  };

  // A page's type and turn: Mixed takes the model's when it is sure of both, else Haiku's (Shadow keeps the
  // model's answer beside it); a page said to be turned is set upright and given back to the session.
  const classify = React.useCallback(async (s: ScanSession, p: ShotPage) => {
    const canvas = p.canvas;
    typedOn.current.set(p.id, canvas);
    const still = () => shots.current.get(p.id)?.canvas === canvas;
    let b64 = await jpegB64(canvas, 0.9).catch(() => '');
    const m = await mode.current, d = p.readouts?.doctype || null;
    const a = m === 'off' || !d || !isDoctype(d.doctype) ? null : { doctype: d.doctype, conf: d.conf, turn: d.turn * 90, turnConf: d.turnConf };
    const sure = !!a && m === 'mixed' && a.conf >= SURE && a.turnConf >= SURE;
    const { kind, rotate } = sure && a ? { kind: a.doctype as Doctype | null, rotate: a.turn } : b64 ? await detectDoctype(b64, 'image/jpeg') : { kind: null, rotate: 0 };
    if (!still()) return;  // cut again (or deleted) meanwhile: that cut is typed on its own
    const lines = p.readouts?.mrz?.lines, he = cleanHe(p.readouts?.he?.read);
    const t: Typed = { b64, mediaType: 'image/jpeg', doctypeModel: kind, doctypeBy: sure ? 'model' : 'haiku',
      ...(kind ? { kind } : {}), ...(a ? { modelSaid: a.doctype } : {}), ...(m === 'shadow' && a ? { doctypeShadow: a.doctype } : {}),
      ...(Array.isArray(lines) ? { mrz: lines.filter(x => typeof x === 'string').slice(0, 2).map(x => x.slice(0, 60)) } : {}), ...(he ? { he } : {}) };
    // a page turned here was read by the zone reader and the field reader on its side: what they read says nothing
    if ([90, 180, 270].includes(rotate)) {
      try {
        const up = turned(canvas, rotate / 90) as OffscreenCanvas;
        b64 = await jpegB64(up, 0.92);
        if (!still()) return;
        t.b64 = b64; delete t.mrz; delete t.he;
        const np: ShotPage = { ...p, canvas: up, page: { ...p.page, width: up.width, height: up.height } };
        typedOn.current.set(p.id, up);
        shots.current.set(p.id, np);
        s.inject(np);
      } catch { /* kept as cut */ }
    }
    if (!t.b64) return;
    typed.current.set(p.id, t);
    setTyping(x => ({ ...x, [p.id]: { kind, pending: false } }));
  }, []);

  /** The pages read and not typed yet (a camera shot's once it settled, or all of them at Done). */
  const typeWaiting = React.useCallback((s: ScanSession) => {
    for (const p of shots.current.values()) {
      if (!p.readouts || typedOn.current.get(p.id) === p.canvas) continue;
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
    return () => offs.forEach(off => off());
  }, [session, typeWaiting]);

  // a page deleted (its Undo over): no longer typed nor kept on the phone
  const view = React.useMemo(() => (session ? siteView(session, id => { shots.current.delete(id); typedOn.current.delete(id); untype(id); }) : null), [session]);

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
        const t = typed.current.get(id);
        if (!t) continue;
        const { key, source } = batchOf(shot);
        put(key, source, { id, turn: -1, blurry: false, ...t });
      }
      void saveBatches(list);
    }, 400);
    return () => window.clearTimeout(t);
  }, [kept, typing]);

  const close = () => { session?.discard(); onClose(); };

  // Done: the camera stops, the types waited for, the attempts sent, the pages read (src/scan-process/)
  const finish = async (shown: UiPage[]): Promise<boolean> => {
    if (!session) return false;
    setHint('');
    session.sleep();
    forcing.current = true;
    typeWaiting(session);
    const mine = () => shown.filter(u => !u.kept && shots.current.has(u.id));
    while (mine().some(u => !typed.current.has(u.id))) await new Promise(r => setTimeout(r, 100));
    forcing.current = false;
    session.attempts.done();  // the scan's attempts go for training (held until Done)
    const list: Stored[] = [];
    for (const u of shown) {
      if (u.kept) {
        const k = keptRef.current.find(x => x.id === u.id);
        if (k) { const { batch: _b, source: _s, ...p } = k; list.push({ ...p, kind: u.chosen || p.kind }); }
        continue;
      }
      const t = typed.current.get(u.id);
      if (t) list.push({ id: u.id, turn: -1, blurry: false, ...t, kind: u.chosen || t.kind });
    }
    void examples(list).then(sendFeedback);  // in the background, queued when offline
    const out: ScannedPage[] = list.filter(p => p.kind !== 'other').map(({ b64, mediaType, turn, blurry, kind, mrz, he }) => ({ b64, mediaType, turn, blurry, kind, ...(mrz ? { mrz } : {}), ...(he ? { he } : {}) }));
    if (read) {
      setReading({ label: tr('Reading the pages…'), pct: 2 });
      let err: string | null;
      try { err = await read(out, (label, pct) => setReading({ label, pct })); }
      catch (e) { err = tr('The pages could not be read: {0}', { 0: (e as Error)?.message || String(e) }); }
      if (err) { setReading(null); setHint(err); session.wake(); return false; }
    }
    saveOn.current = false; void saveBatches([]);  // read: nothing left to keep on the phone
    session.done();
    shots.current.clear(); typed.current.clear(); typedOn.current.clear();
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
          onRemoveKept={id => setKept(xs => xs.filter(x => x.id !== id))} onDone={finish}>
          {(hint || queue > 0) && (
            <div className="pointer-events-none absolute inset-x-4 top-[calc(76px+env(safe-area-inset-top,0px))] z-10 flex flex-col items-start gap-1.5">
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
