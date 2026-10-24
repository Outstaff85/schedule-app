// The full-screen scanner (docs/scan-plan.md → S9): the screen's state over a scan session. The screen draws
// only what this hook gives — the status line, the pages (as thumbnails with their document type), the picked
// picture being worked on — and runs the session's actions through it. The live frame itself is drawn by
// LiveOverlay straight from the session's frame events (every screen frame, no React render).
//
// ScanSessionLike is what the screen takes of a session: ScanSession (src/scan/engine/session.ts) is one, and
// the /next gallery's fake (fake-session.ts) another, so the screen can be looked at without a camera.
//
// The pages: each one the moment it is cut (the session's page event), again under its id when it is refined
// or read; its picture made a JPEG object URL for the thumbnail (the old one let go). Delete hides a page at
// once and offers Undo (the Undo snack); the session is told when the snack ends (or at Done) — a page
// brought back by Undo was never deleted. The document type picked by hand is kept here (the session keeps the
// model's answer only); Looks good marks that one page (session.keep).
//
// After a shot or a pick the live frame waits (the session's rule: Auto does not take the same document
// twice): `paused` is on, the shutter then starts the live frame again (session.wake), and so does Looks good.
import * as React from 'react';
import { undoDelete } from '@/components/shared/undo';
import { tr } from '@/lib/i18n';
import type { VideoLike } from '../engine/camera';
import type { Doctype } from '../engine/doctypes';
import type { PickFile } from '../engine/files';
import type { Figures } from '../engine/live';
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
  pick(files: PickFile[]): Promise<number>;
  keep(pageId: string): void;
  remove(pageId: string): void;
  fixable(pageId: string): Fixable | null;
  fix(pageId: string, pts: Quad): Promise<boolean>;
  done(): void;
  discard(): void;
}

/** A page as the screen shows it. */
export interface UiPage {
  id: string;
  /** Its picture (a JPEG object URL), '' until made. */
  src: string;
  /** The model's document type and how sure it is (0..1), null before it is read or with no model. */
  model: Doctype | null;
  conf: number | null;
  /** Still being read (its readouts not there yet). */
  reading: boolean;
  /** The type picked by hand, null when the model's stands. */
  chosen: Doctype | null;
  /** Looks good was tapped on it. */
  looked: boolean;
  /** The session's page (its record, corners, readouts). */
  shot: ShotPage;
}

/** The type a page goes with: the one picked by hand, else the model's. */
export const kindOf = (p: UiPage): Doctype | null => p.chosen || p.model;

/** The statuses after which the live frame waits for wake() (a shot taken, a pick in work or over). */
const PAUSING = new Set<SessionStatus['key']>(['captured', 'picture_finding', 'picture_cutting', 'picked', 'pick_failed', 'pick_open_failed']);
/** The statuses of a live frame running again. */
const LIVE = new Set<SessionStatus['key']>(['finding', 'corners_out', 'edges_unclear', 'hold', 'shot_failed', 'camera_failed', 'stopped']);

export interface ScanScreenState {
  status: SessionStatus | null;
  pages: UiPage[];
  /** The picked picture being worked on (shown in place of the camera), null on the camera. */
  preview: PreviewEvent | null;
  figures: Figures | null;
  auto: boolean;
  paused: boolean;
  setAuto(on: boolean): void;
  /** The shutter: the shot — or, while the live frame waits after one, the live frame again. */
  shutter(): void;
  pick(files: PickFile[]): void;
  choose(id: string, kind: Doctype): void;
  keep(id: string): void;
  /** Delete with the Undo snack. */
  remove(id: string): void;
  fixable(id: string): Fixable | null;
  fix(id: string, pts: Quad): Promise<boolean>;
  /** Done: the pending deletes made, the session's done(); the pages shown at that moment. */
  done(): UiPage[];
}

/** A page's picture as a JPEG blob. */
async function jpeg(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

export function useScanSession(session: ScanSessionLike, video: React.RefObject<HTMLVideoElement | null>): ScanScreenState {
  const [status, setStatus] = React.useState<SessionStatus | null>(null);
  const [order, setOrder] = React.useState<string[]>([]);
  const [shots, setShots] = React.useState<Record<string, ShotPage>>({});
  const [srcs, setSrcs] = React.useState<Record<string, string>>({});
  const [chosen, setChosen] = React.useState<Record<string, Doctype>>({});
  const [looked, setLooked] = React.useState<Record<string, true>>({});
  const [hidden, setHidden] = React.useState<Record<string, true>>({});
  const [preview, setPreview] = React.useState<PreviewEvent | null>(null);
  const [figures, setFigures] = React.useState<Figures | null>(null);
  const [auto, setAutoState] = React.useState(session.auto);
  const [paused, setPaused] = React.useState(false);
  // the pages deleted whose Undo is still offered (told to the session when the snack ends, or at Done)
  const pendingDeletes = React.useRef(new Set<string>());
  // each page's canvas its URL was made from, and the URLs to let go
  const madeFrom = React.useRef(new Map<string, OffscreenCanvas>());
  const urls = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    let alive = true;
    const offs = [
      session.on('status', s => {
        setStatus(s);
        if (PAUSING.has(s.key)) setPaused(true);
        else if (LIVE.has(s.key)) { setPaused(false); setPreview(null); }
      }),
      session.on('figures', f => setFigures(f)),
      session.on('preview', p => { setPreview(p); setPaused(true); }),
      session.on('page', p => {
        setShots(m => ({ ...m, [p.id]: p }));
        setOrder(o => (o.includes(p.id) ? o : [...o, p.id]));
        if (madeFrom.current.get(p.id) === p.canvas) return;
        madeFrom.current.set(p.id, p.canvas);
        jpeg(p.canvas).then(b => {
          if (!alive || madeFrom.current.get(p.id) !== p.canvas) return;  // cut again meanwhile: that one's URL wins
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
      for (const u of urls.current.values()) URL.revokeObjectURL(u);
      urls.current.clear();
      madeFrom.current.clear();
    };
  }, [session]);

  const pages = React.useMemo(() => order.filter(id => !hidden[id] && shots[id]).map((id): UiPage => {
    const shot = shots[id], d = shot.readouts?.doctype || null;
    return { id, src: srcs[id] || '', model: d ? d.doctype : null, conf: d ? d.conf : null, reading: !shot.readouts, chosen: chosen[id] || null, looked: !!looked[id], shot };
  }), [order, hidden, shots, srcs, chosen, looked]);

  const wake = React.useCallback(() => {
    setPaused(false);
    setPreview(null);
    session.wake(video.current || undefined);
  }, [session, video]);

  const commitDelete = React.useCallback((id: string) => {
    if (!pendingDeletes.current.delete(id)) return;
    session.remove(id);
  }, [session]);

  return {
    status, pages, preview, figures, auto, paused,
    setAuto: on => { session.setAuto(on); setAutoState(on); },
    shutter: () => { if (paused) wake(); else void session.snap(); },
    pick: files => { if (files.length) void session.pick(files); },
    choose: (id, kind) => setChosen(m => ({ ...m, [id]: kind })),
    keep: id => {
      session.keep(id);
      setLooked(m => ({ ...m, [id]: true }));
      if (paused) wake();
    },
    remove: id => {
      pendingDeletes.current.add(id);
      setHidden(m => ({ ...m, [id]: true }));
      undoDelete(tr('Page deleted'), () => commitDelete(id), () => {
        pendingDeletes.current.delete(id);
        setHidden(m => { const n = { ...m }; delete n[id]; return n; });
      });
    },
    fixable: id => session.fixable(id),
    fix: (id, pts) => session.fix(id, pts),
    done: () => {
      for (const id of [...pendingDeletes.current]) commitDelete(id);
      const shown = pages;
      session.done();
      return shown;
    },
  };
}
