// The full-screen scanner (docs/scan-plan.md → S9): the screen's state over a scan session. The screen draws
// only what this hook gives — the pages (as thumbnails with their document type), the picked picture being
// worked on, whether the live frame waits and whether a shot or a pick is in work — and runs the session's
// actions through it. The live frame itself is drawn by LiveOverlay straight from the session's frame events,
// the status line by StatusPill from its status events, and the lab's figures by the lab's tools
// (useFigures.ts) — each on its own, so the screen is not drawn again on every camera frame.
//
// ScanSessionLike is what the screen takes of a session: ScanSession (src/scan/engine/session.ts) is one, and
// the /next gallery's fake (fake-session.ts) another, so the screen can be looked at without a camera.
//
// The pages: each one the moment it is cut (the session's page event), again under its id when it is refined
// or read; its picture made a JPEG object URL for the thumbnail (the old one let go). Before them the pages the
// host keeps already (`kept`: the site's batches kept on the phone until read, the pages from before Scan
// again) — shown, deletable, counted and given at Done like the others, but not fixed (their photo is gone).
// Delete hides a page at once and offers Undo (the Undo snack); the session (or the host, for a kept page) is
// told when the snack ends — or at Done, or when the screen goes, which end the snack — and the page's picture
// is let go then; a page brought back by Undo was never deleted. The document type picked by hand is kept here
// (the session keeps the model's answer only) and told to the host (`onChoose`: the site keeps it on the phone
// with the page); Looks good marks that one page (session.keep: its photo's
// attempt is kept once every page of it was looked at). A host may type the pages itself (`typing`: the site's
// scan window, by Haiku or the model as Admin → Scanner says): its type then stands in for the model's on the
// page, which counts as being read until the host has typed it.
//
// Done: settle() ends the Undo snack (its deletes made) and gives the pages shown; end() then ends the scan
// (session.done) and empties the screen — done() is the two at once. The site's host reads the pages between
// the two, and ends the scan only once they are read; while it waits for their types it reads them as they are
// then (current(): a type picked or given meanwhile counts).
//
// After a shot or a pick the live frame waits (the session's rule: Auto does not take the same document
// twice): `paused` is on, the shutter then starts the live frame again (session.wake), and so does Looks good —
// but not while a shot is still in work (refining, looking for more documents: `busy`) or a pick is (`picking`):
// the shutter is off then, and Looks good leaves the live frame waiting, so the shot finishes and gives its
// other documents.
import * as React from 'react';
import { finishUndo, undoDelete } from '@/components/shared/undo';
import { tr } from '@/lib/i18n';
import type { VideoLike } from '../engine/camera';
import type { Doctype } from '../engine/doctypes';
import type { PickFile } from '../engine/files';
import type { PreviewEvent, SessionEvents } from '../engine/session';
import type { ShotPage } from '../engine/shot';
import type { SessionStatus } from '../engine/status';
import type { Quad } from '../engine/types';

/** What the corner editor gets for a page: its photo and the corners to start from. */
export interface Fixable { frame: CanvasImageSource & { width: number; height: number }; w: number; h: number; pts: Quad }

/** What the scanner screen takes of a scan session (ScanSession is one; the gallery's fake another). */
export interface ScanSessionLike {
  auto: boolean;
  on<K extends keyof SessionEvents>(ev: K, fn: SessionEvents[K]): () => void;
  startCamera(video: VideoLike): Promise<void>;
  snap(): Promise<number>;
  setAuto(on: boolean): void;
  wake(video?: VideoLike): void;
  sleep(): void;
  /** The live frame paused while a page is opened large over the camera, and started again after. */
  hold(): void;
  resume(): void;
  pick(files: PickFile[]): Promise<number>;
  keep(pageId: string): void;
  remove(pageId: string): void;
  fixable(pageId: string): Fixable | null;
  fix(pageId: string, pts: Quad): Promise<boolean>;
  done(): void;
  discard(): void;
}

/** A page the host keeps already (the site's batches on the phone, the pages from before Scan again). */
export interface KeptPage {
  id: string;
  /** Its picture (the host's URL). */
  src: string;
  kind: Doctype | null;
}

/** A page's type as the host gives it (the site's scan window): null when it found none; pending while it is
 *  still typing it. */
export interface PageTyping { kind: Doctype | null; pending: boolean }

/** A page as the screen shows it. */
export interface UiPage {
  id: string;
  /** Its picture (a JPEG object URL — let go at Done —, the host's for a kept page), '' until made. */
  src: string;
  /** The model's document type and how sure it is (0..1), null before it is read or with no model; a kept
   *  page's type as the host gave it (conf null). */
  model: Doctype | null;
  conf: number | null;
  /** Still being read (its readouts not there yet). */
  reading: boolean;
  /** The type picked by hand, null when the model's stands. */
  chosen: Doctype | null;
  /** The host's type (`typing`), which stands in for the model's; undefined when the host types nothing. */
  typed?: Doctype | null;
  /** Looks good was tapped on it (a kept page counts as looked at). */
  looked: boolean;
  /** The session's page (its record, corners, readouts); null for a page the host kept. */
  shot: ShotPage | null;
  /** A page the host kept (not of this session: no Fix corners, no Looks good). */
  kept: boolean;
}

/** The type a page goes with: the one picked by hand, else the host's (when it types the pages), else the
 *  model's. */
export const kindOf = (p: UiPage): Doctype | null => p.chosen || (p.typed !== undefined ? p.typed : p.model);

/** The statuses after which the live frame waits for wake() (a shot taken, a pick in work or over). */
const PAUSING = new Set<SessionStatus['key']>(['captured', 'picture_finding', 'picture_cutting', 'picked', 'pick_failed', 'pick_open_failed']);
/** The statuses of a live frame running again. */
const LIVE = new Set<SessionStatus['key']>(['finding', 'corners_out', 'edges_unclear', 'hold', 'shot_failed', 'camera_failed', 'stopped']);
/** The statuses of a shot still in work (cut, being refined, looking for more documents); any other ends it. */
const SHOT_WORK = new Set<SessionStatus['key']>(['captured', 'refining', 'looking_more']);

export interface ScanScreenState {
  pages: UiPage[];
  /** The picked picture being worked on (shown in place of the camera), null on the camera. */
  preview: PreviewEvent | null;
  auto: boolean;
  paused: boolean;
  /** A shot is still in work (refining, looking for more documents). */
  busy: boolean;
  /** A pick is in work. */
  picking: boolean;
  setAuto(on: boolean): void;
  /** The shutter: the shot — or, while the live frame waits after one, the live frame again; nothing while a
   *  shot or a pick is in work. */
  shutter(): void;
  pick(files: PickFile[]): void;
  choose(id: string, kind: Doctype): void;
  keep(id: string): void;
  /** Delete with the Undo snack. */
  remove(id: string): void;
  fixable(id: string): Fixable | null;
  fix(id: string, pts: Quad): Promise<boolean>;
  /** Done: the Undo snack ended (its delete made), the session's done(); the pages shown at that moment (their
   *  pictures let go: a page's pixels are its shot's canvas). The screen starts empty again. */
  done(): UiPage[];
  /** The first half of done(): the Undo snack ended (its deletes made); the pages shown at that moment. */
  settle(): UiPage[];
  /** The pages shown now (as last drawn): what a host waiting at Done reads again. */
  current(): UiPage[];
  /** The second half: the session's done(), the pictures let go, the screen empty again. */
  end(): void;
}

/** A page's picture as a JPEG blob. */
async function jpeg(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

function without<T>(m: Record<string, T>, id: string): Record<string, T> {
  if (!(id in m)) return m;
  const n = { ...m };
  delete n[id];
  return n;
}

export function useScanSession(session: ScanSessionLike, video: React.RefObject<HTMLVideoElement | null>, opts: {
  /** the pages the host keeps already, shown before this session's */
  kept?: KeptPage[];
  /** a kept page deleted (its Undo over) */
  onRemoveKept?: (id: string) => void;
  /** the host's types of this session's pages, by page id (a page missing is still being typed) */
  typing?: Record<string, PageTyping>;
  /** a type picked by hand on a page (this session's or a kept one) */
  onChoose?: (id: string, kind: Doctype) => void;
} = {}): ScanScreenState {
  const { kept, onRemoveKept, typing } = opts;
  const onChoose = React.useRef(opts.onChoose);
  onChoose.current = opts.onChoose;
  const [order, setOrder] = React.useState<string[]>([]);
  const [shots, setShots] = React.useState<Record<string, ShotPage>>({});
  const [srcs, setSrcs] = React.useState<Record<string, string>>({});
  const [chosen, setChosen] = React.useState<Record<string, Doctype>>({});
  const [looked, setLooked] = React.useState<Record<string, true>>({});
  const [hidden, setHidden] = React.useState<Record<string, true>>({});
  const [preview, setPreview] = React.useState<PreviewEvent | null>(null);
  const [auto, setAutoState] = React.useState(session.auto);
  const [paused, setPaused] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [picking, setPicking] = React.useState(0);
  // what is drawn now, so a status event that changes nothing draws nothing
  const now = React.useRef({ paused: false, busy: false, preview: false });
  // the pages deleted whose Undo is still offered (told when the snack ends, or at Done, or when the screen goes)
  const pendingDeletes = React.useRef(new Set<string>());
  // each page's canvas its URL was made from, and the URLs to let go
  const madeFrom = React.useRef(new Map<string, OffscreenCanvas>());
  const urls = React.useRef(new Map<string, string>());
  const removeKept = React.useRef(onRemoveKept);
  removeKept.current = onRemoveKept;
  const keptIds = React.useRef(new Set<string>());
  keptIds.current = new Set((kept || []).map(k => k.id));

  const putPaused = React.useCallback((v: boolean) => { if (now.current.paused !== v) { now.current.paused = v; setPaused(v); } }, []);
  const putBusy = React.useCallback((v: boolean) => { if (now.current.busy !== v) { now.current.busy = v; setBusy(v); } }, []);
  const clearPreview = React.useCallback(() => { if (now.current.preview) { now.current.preview = false; setPreview(null); } }, []);

  /** A page's picture let go (deleted, or Done). */
  const letGo = React.useCallback((id: string) => {
    const u = urls.current.get(id);
    if (u) URL.revokeObjectURL(u);
    urls.current.delete(id);
    madeFrom.current.delete(id);
  }, []);

  const commitDelete = React.useCallback((id: string) => {
    if (!pendingDeletes.current.delete(id)) return;
    if (keptIds.current.has(id)) { removeKept.current?.(id); return; }  // the host's page: it stays hidden here
    session.remove(id);
    letGo(id);
    setOrder(o => o.filter(x => x !== id));
    setShots(m => without(m, id));
    setSrcs(m => without(m, id));
    setChosen(m => without(m, id));
    setLooked(m => without(m, id));
    setHidden(m => without(m, id));
  }, [session, letGo]);

  React.useEffect(() => {
    let alive = true;
    const offs = [
      session.on('status', s => {
        putBusy(SHOT_WORK.has(s.key));
        if (PAUSING.has(s.key)) putPaused(true);
        else if (LIVE.has(s.key)) { putPaused(false); clearPreview(); }
      }),
      session.on('preview', p => { now.current.preview = true; setPreview(p); putPaused(true); }),
      session.on('page', p => {
        setShots(m => ({ ...m, [p.id]: p }));
        setOrder(o => (o.includes(p.id) ? o : [...o, p.id]));
        if (madeFrom.current.get(p.id) === p.canvas) return;
        madeFrom.current.set(p.id, p.canvas);
        jpeg(p.canvas).then(b => {
          if (!alive || madeFrom.current.get(p.id) !== p.canvas) return;  // cut again (or deleted) meanwhile
          const url = URL.createObjectURL(b), old = urls.current.get(p.id);
          urls.current.set(p.id, url);
          if (old) URL.revokeObjectURL(old);
          setSrcs(m => ({ ...m, [p.id]: url }));
        }).catch(() => { /* a picture that cannot be made shows its type alone */ });
      }),
    ];
    return () => {
      alive = false;
      offs.forEach(off => off());
      // no Undo outlives the screen: the delete it offered is made now
      if (pendingDeletes.current.size) finishUndo('commit');
      for (const u of urls.current.values()) URL.revokeObjectURL(u);
      urls.current.clear();
      madeFrom.current.clear();
    };
  }, [session, putBusy, putPaused, clearPreview]);

  const pages = React.useMemo(() => {
    const before = (kept || []).filter(k => !hidden[k.id]).map((k): UiPage => (
      { id: k.id, src: k.src, model: k.kind, conf: null, reading: false, chosen: chosen[k.id] || null, looked: true, shot: null, kept: true }));
    const mine = order.filter(id => !hidden[id] && shots[id]).map((id): UiPage => {
      const shot = shots[id], d = shot.readouts?.doctype || null, t = typing ? typing[id] : undefined;
      const page: UiPage = { id, src: srcs[id] || '', model: d ? d.doctype : null, conf: d ? d.conf : null, reading: !shot.readouts || (!!typing && (!t || t.pending)),
        chosen: chosen[id] || null, looked: !!looked[id], shot, kept: false };
      if (typing) page.typed = t && !t.pending ? t.kind : null;
      return page;
    });
    return [...before, ...mine];
  }, [kept, order, hidden, shots, srcs, chosen, looked, typing]);
  const pagesNow = React.useRef(pages);
  pagesNow.current = pages;

  const wake = React.useCallback(() => {
    putPaused(false);
    clearPreview();
    session.wake(video.current || undefined);
  }, [session, video, putPaused, clearPreview]);

  const working = busy || picking > 0;

  return {
    pages, preview, auto, paused, busy, picking: picking > 0,
    setAuto: on => { session.setAuto(on); setAutoState(on); },
    shutter: () => {
      if (working) return;  // the shot finishes first (its other documents), the pick too
      if (paused) wake(); else void session.snap();
    },
    pick: files => {
      if (!files.length) return;
      setPicking(n => n + 1);
      const settled = () => setPicking(n => Math.max(0, n - 1));
      session.pick(files).then(settled, settled);
    },
    choose: (id, kind) => { setChosen(m => ({ ...m, [id]: kind })); onChoose.current?.(id, kind); },
    keep: id => {
      if (keptIds.current.has(id)) return;
      session.keep(id);
      setLooked(m => ({ ...m, [id]: true }));
      if (paused && !working) wake();
    },
    remove: id => {
      pendingDeletes.current.add(id);
      setHidden(m => ({ ...m, [id]: true }));
      undoDelete(tr('Page deleted'), () => commitDelete(id), () => {
        pendingDeletes.current.delete(id);
        setHidden(m => without(m, id));
      });
    },
    fixable: id => (keptIds.current.has(id) ? null : session.fixable(id)),
    fix: (id, pts) => (keptIds.current.has(id) ? Promise.resolve(false) : session.fix(id, pts)),
    settle,
    current: () => pagesNow.current,
    end,
    done: () => { const shown = settle(); end(); return shown; },
  };

  function settle(): UiPage[] {
    // the snack ends with Done: its delete is made (no Undo offered for a page already gone)
    if (pendingDeletes.current.size) finishUndo('commit');
    for (const id of [...pendingDeletes.current]) commitDelete(id);
    return pages;
  }
  function end(): void {
    session.done();
    // the session let its pages go: so does the screen (it starts empty, nothing kept in memory)
    for (const id of [...urls.current.keys()]) letGo(id);
    madeFrom.current.clear();
    setOrder([]); setShots({}); setSrcs({}); setChosen({}); setLooked({}); setHidden({});
    clearPreview(); putBusy(false);
  }
}
