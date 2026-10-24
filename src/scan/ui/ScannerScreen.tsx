// The full-screen scanner (docs/scan-plan.md → S9): one screen for the site and the lab. The camera fills the
// screen with the live frame (LiveOverlay); the status line is always over it (StatusPill); a fixed bottom bar —
// Photos/PDF, the big shutter, Auto (CaptureBar) — with the strip of the pages found above it (Thumbs); one Done
// button always in the same place, at the top right (the lab: Show what the models read, mode 'lab'). A tap on
// a thumbnail opens the page large (PageView): its type as chips, Fix corners (CornerEditor), Delete (the Undo
// snack), Looks good; while it is open the live frame is paused under it (session.hold / resume: no follow, no
// Auto shot behind it). A picked picture is shown in place of the camera the moment it is being worked on, with
// the frame of each document found on it. The shutter is off while a shot is still in work (refining, looking
// for more documents) or a pick is.
//
// It fills the box it is put in (a full Window — Window full — in the app; a phone frame in the /next gallery)
// and drives a ScanSessionLike (useScanSession.ts): the camera starts when the screen is shown (camera: false
// leaves it off) and the session sleeps when it goes (the models stay). The site's host gives the pages it keeps
// already (`kept`: its batches on the phone, the pages from before Scan again): they come first in the strip,
// count in Done and go with it; it may type the pages itself (`typing`, the site: Haiku's or the model's type as
// Admin → Scanner says) and add a line under a thumbnail (`thumbNote`). Done counts the pages that will be saved
// (not the ones typed Other). When the host's onDone gives a promise (the site reads the pages first), Done waits
// for it — busy — and the scan ends (session.done, the screen emptied) only when it says true; false leaves the
// pages and the scan as they are (the read failed: the host says why). Escape inside it closes the step on top
// (the corner editor, then the page opened large) before the window.
import * as React from 'react';
import { IconCheck, IconEye } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import type { Quad } from '../engine/types';
import { CaptureBar } from './CaptureBar';
import { CornerEditor } from './CornerEditor';
import { LiveOverlay } from './LiveOverlay';
import { PageView } from './PageView';
import { StatusPill } from './StatusPill';
import { Thumbs } from './Thumbs';
import { Spinner } from '@/components/ui/spinner';
import { kindOf, useScanSession, type Fixable, type KeptPage, type PageTyping, type ScanSessionLike, type UiPage } from './useScanSession';

export type ScannerMode = 'site' | 'lab';

const cannotFix = (): string => tr('This page can no longer be fixed — delete it and take it again');

export function ScannerScreen({ mode, session, onDone, camera = true, statusText, initial, kept, onRemoveKept, typing, thumbNote, children }: {
  mode: ScannerMode;
  session: ScanSessionLike;
  /** Done (the site) / Show what the models read (the lab): the pages shown at that moment, in order (the kept
   *  ones first, `kept: true`); the site's may give a promise — the scan ends once it resolves true */
  onDone?: (pages: UiPage[]) => void | Promise<boolean>;
  /** start the camera when shown (default) */
  camera?: boolean;
  /** a status of the screen's own (the models loading) in place of the session's */
  statusText?: string;
  /** the step to open with (the /next gallery's still screens): a page opened large, or its corner editor */
  initial?: { page: string; fix?: boolean };
  /** the pages the host keeps already (the site: its batches on the phone, the pages from before Scan again) */
  kept?: KeptPage[];
  /** a kept page deleted (once its Undo is over) */
  onRemoveKept?: (id: string) => void;
  /** the host's types of this session's pages (the site), by page id */
  typing?: Record<string, PageTyping>;
  /** a line of the host's under a thumbnail */
  thumbNote?: (p: UiPage) => React.ReactNode;
  /** drawn over the screen (the lab's tools drawer) */
  children?: React.ReactNode;
}) {
  const video = React.useRef<HTMLVideoElement>(null);
  const s = useScanSession(session, video, { kept, onRemoveKept, typing });
  const [finishing, setFinishing] = React.useState(false);
  // the pages that will be saved: not the ones typed Other
  const saved = s.pages.filter(p => kindOf(p) !== 'other').length;
  const finish = async () => {
    if (finishing) return;
    const shown = s.settle();
    const r = onDone?.(shown);
    if (!r || typeof r.then !== 'function') { s.end(); return; }
    setFinishing(true);
    let ok = false;
    try { ok = await r; } catch { ok = false; }
    setFinishing(false);
    if (ok) s.end();
  };
  const [open, setOpen] = React.useState<string | null>(null);
  const [fixing, setFixing] = React.useState<{ id: string; data: Fixable } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [still, setStill] = React.useState<{ w: number; h: number } | null>(null);

  // the camera on while the screen is shown; the session put to sleep when it goes (its models kept)
  React.useEffect(() => {
    if (!camera || !video.current) return;
    void session.startCamera(video.current);
    return () => session.sleep();
  }, [session, camera]);

  // a page opened large: the live frame paused under it, started again when it closes (unless Looks good
  // already woke it, or it waits after a shot anyway)
  const isOpen = open != null;
  React.useEffect(() => {
    if (!isOpen) return;
    session.hold();
    return () => session.resume();
  }, [isOpen, session]);

  const page = open ? s.pages.find(p => p.id === open) || null : null;
  const index = page ? s.pages.indexOf(page) + 1 : 0;
  // a page deleted (or gone with its shot) closes its view
  React.useEffect(() => { if (open && !page) { setOpen(null); setFixing(null); } }, [open, page]);
  React.useEffect(() => { setNote(null); }, [open]);

  const startFix = React.useCallback((id: string) => {
    const data = s.fixable(id);
    if (!data) { setNote(cannotFix()); return; }
    setFixing({ id, data });
  }, [s]);

  // the gallery's still screens open on a step
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!initial || opened.current || !s.pages.some(p => p.id === initial.page)) return;
    opened.current = true;
    setOpen(initial.page);
    if (initial.fix) startFix(initial.page);
  }, [initial, s.pages, startFix]);

  // Escape inside the screen: the step on top first (before the window it is in)
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !root.current || !root.current.contains(e.target as Node)) return;
      e.stopPropagation();
      if (fixing) setFixing(null); else setOpen(null);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, fixing]);

  const apply = (pts: Quad) => {
    const id = fixing?.id;
    setFixing(null);
    if (id) void s.fix(id, pts).then(ok => { if (!ok) setNote(cannotFix()); });
  };

  const preview = s.preview;
  React.useEffect(() => { setStill(null); }, [preview?.url]);
  // the picked picture's frame: the same object while nothing in it changes (its overlay is not redrawn)
  const stillFrame = React.useMemo(() => (preview && still ? { quad: preview.quad, w: still.w, h: still.h } : null), [preview?.quad, still?.w, still?.h]);

  return (
    <div ref={root} data-testid="scanner" data-mode={mode} className="relative isolate size-full overflow-hidden bg-background text-ink">
      {/* the camera, cropped to fill the screen, and its live frame */}
      <video ref={video} muted playsInline autoPlay data-testid="scan-video" className="absolute inset-0 size-full object-cover" />
      {!preview && <LiveOverlay session={session} video={video} />}
      {/* a picked picture, shown whole the moment it is being worked on */}
      {preview && (
        <div data-testid="scan-preview" data-stage={preview.stage} className="absolute inset-0 bg-background">
          <img src={preview.url} alt="" draggable={false} className="absolute inset-0 size-full object-contain"
            onLoad={e => setStill({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {stillFrame && <LiveOverlay session={session} video={video} still={stillFrame} />}
        </div>
      )}

      {/* the top: the status line, and Done always in the same place */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-start gap-2 px-4 pt-[calc(28px+env(safe-area-inset-top,0px))]">
        <StatusPill session={session} text={statusText} className="mr-auto" />
        {mode === 'site'
          ? <Button variant="primary" size="sm" disabled={!saved || finishing} data-testid="scan-done" data-busy={finishing || undefined} onClick={() => { void finish(); }}>
              {finishing ? <Spinner className="size-[18px]" /> : <IconCheck className="size-[18px]" />}{saved ? tr('Done · {n}', { n: saved }) : tr('Done')}
            </Button>
          : <Button variant="primary" size="sm" disabled={!s.pages.length} data-testid="scan-done" onClick={() => onDone?.(s.pages)}>
              <IconEye className="size-[18px]" />{tr('Show what the models read')}
            </Button>}
      </div>

      {/* the bottom: the pages found, and the bar */}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background/85 to-transparent pt-6">
        <Thumbs pages={s.pages} open={open} onOpen={setOpen} note={thumbNote} />
        <CaptureBar auto={s.auto} paused={s.paused} disabled={s.busy || s.picking} onAuto={s.setAuto} onShutter={s.shutter} onPick={s.pick} />
      </div>

      {page && (
        <PageView page={page} index={index} note={note}
          onChoose={k => s.choose(page.id, k)}
          onFix={() => startFix(page.id)}
          onDelete={() => { setOpen(null); s.remove(page.id); }}
          onKeep={() => { setOpen(null); s.keep(page.id); }}
          onClose={() => setOpen(null)} />
      )}
      {fixing && <CornerEditor key={fixing.id} frame={fixing.data.frame} start={fixing.data.pts} onApply={apply} onCancel={() => setFixing(null)} />}
      {children}
    </div>
  );
}
