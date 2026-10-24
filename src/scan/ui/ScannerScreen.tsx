// The full-screen scanner (docs/scan-plan.md → S9): one screen for the site and the lab. The camera fills the
// screen with the live frame (LiveOverlay); the status line is always over it (StatusPill); a fixed bottom bar —
// Photos/PDF, the big shutter, Auto (CaptureBar) — with the strip of the pages found above it (Thumbs); one Done
// button always in the same place, at the top right (the lab: Show what the models read, mode 'lab'). A tap on
// a thumbnail opens the page large (PageView): its type as chips, Fix corners (CornerEditor), Delete (the Undo
// snack), Looks good. A picked picture is shown in place of the camera the moment it is being worked on, with
// the frame of each document found on it.
//
// It fills the box it is put in (a full Window — Window full — in the app; a phone frame in the /next gallery)
// and drives a ScanSessionLike (useScanSession.ts): the camera starts when the screen is shown (camera: false
// leaves it off) and the session sleeps when it goes (the models stay). Escape inside it closes the step on top (the
// corner editor, then the page opened large) before the window.
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
import { useScanSession, type Fixable, type ScanSessionLike, type UiPage } from './useScanSession';

export type ScannerMode = 'site' | 'lab';

export function ScannerScreen({ mode, session, onDone, camera = true, statusText, initial, children }: {
  mode: ScannerMode;
  session: ScanSessionLike;
  /** Done (the site) / Show what the models read (the lab): the pages shown at that moment, in order */
  onDone?: (pages: UiPage[]) => void;
  /** start the camera when shown (default) */
  camera?: boolean;
  /** a status of the screen's own (the models loading) in place of the session's */
  statusText?: string;
  /** the step to open with (the /next gallery's still screens): a page opened large, or its corner editor */
  initial?: { page: string; fix?: boolean };
  /** drawn over the screen (the lab's tools drawer) */
  children?: React.ReactNode;
}) {
  const video = React.useRef<HTMLVideoElement>(null);
  const s = useScanSession(session, video);
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

  const page = open ? s.pages.find(p => p.id === open) || null : null;
  const index = page ? s.pages.indexOf(page) + 1 : 0;
  // a page deleted (or gone with its shot) closes its view
  React.useEffect(() => { if (open && !page) { setOpen(null); setFixing(null); } }, [open, page]);
  React.useEffect(() => { setNote(null); }, [open]);

  const startFix = React.useCallback((id: string) => {
    const data = s.fixable(id);
    if (!data) { setNote(tr('This page can no longer be fixed — retake it')); return; }
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
    if (id) void s.fix(id, pts).then(ok => { if (!ok) setNote(tr('This page can no longer be fixed — retake it')); });
  };

  const preview = s.preview;
  React.useEffect(() => { setStill(null); }, [preview?.url]);

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
          {still && <LiveOverlay session={session} video={video} still={{ quad: preview.quad, w: still.w, h: still.h }} />}
        </div>
      )}

      {/* the top: the status line, and Done always in the same place */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-start gap-2 px-4 pt-[calc(28px+env(safe-area-inset-top,0px))]">
        <StatusPill status={s.status} text={statusText} className="mr-auto" />
        {mode === 'site'
          ? <Button variant="primary" size="sm" disabled={!s.pages.length} data-testid="scan-done" onClick={() => onDone?.(s.done())}>
              <IconCheck className="size-[18px]" />{s.pages.length ? tr('Done · {n}', { n: s.pages.length }) : tr('Done')}
            </Button>
          : <Button variant="primary" size="sm" disabled={!s.pages.length} data-testid="scan-done" onClick={() => onDone?.(s.pages)}>
              <IconEye className="size-[18px]" />{tr('Show what the models read')}
            </Button>}
      </div>

      {/* the bottom: the pages found, and the bar */}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background/85 to-transparent pt-6">
        <Thumbs pages={s.pages} open={open} onOpen={setOpen} />
        <CaptureBar auto={s.auto} paused={s.paused} onAuto={s.setAuto} onShutter={s.shutter} onPick={s.pick} />
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
