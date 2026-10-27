// The full-screen scanner (docs/scan-plan.md → S9): one screen for the site and the lab, to the owner's template
// "6 · Camera — selected photo grows" (2026-10-26). The camera fills the screen with the live frame
// (LiveOverlay); the status line at the top centre (StatusPill: the state, led by the type and % of the page a
// shot is working on), Auto at the top right; the hint for the person under the camera's frame (HintPill:
// "A little closer", "Keep the two lines at the bottom in the frame" …); at the bottom, above the bar, the strip
// of the photos taken, each with the model's % under it (Thumbs) — a tap makes one grow in place with its type
// and % on top (a tap there opens the page large: PageView, its type chips, Looks good), a round Edit corners
// button on its left (CornerEditor) and a round red Delete on its right (the Undo snack); a tap on it again or on
// another shrinks it; the bottom bar — Photos/PDF, the big shutter, Done (CaptureBar; the lab: Show what the
// models read — Models read on the button —, mode 'lab'). There is no Next: after a shot the live frame goes on by itself, and Auto does not
// take the same document again (the session's rule, src/scan/engine/session.ts). While a page is opened large or
// its corners are being fixed the live frame is paused under it (session.hold / resume: no follow, no Auto shot
// behind it). A picked picture is shown in place of the camera the moment it is being worked on, with the frame
// of each document found on it. The shutter is off while a shot is still in work (refining, looking for more
// documents) or a pick is.
//
// It fills the box it is put in (a full Window — Window full — in the app; a phone frame in the /next gallery)
// and drives a ScanSessionLike (useScanSession.ts): the camera starts when the screen is shown (camera: false
// leaves it off) and the session sleeps when it goes (the models stay). The site's host gives the pages it keeps
// already (`kept`: its batches on the phone, the pages from before Scan again): they come first in the strip,
// count in Done and go with it; it may type the pages itself (`typing`, the site: Haiku's or the model's type as
// Admin → Scanner says) and add a line under a thumbnail (`thumbNote`). Done counts the pages that will be saved
// (not the ones typed Other). When the host's onDone gives a promise (the site reads the pages first), Done waits
// for it — busy, the bar and the pages closed meanwhile (no new page, no change it would miss) — and the scan
// ends (session.done, the screen emptied) only when it says true; false leaves the pages and the scan as they
// are (the read failed: the host says why). A type picked by hand is told to the host (onChoose). Escape inside
// it closes the step on top (the corner editor, then the page opened large) before the window.
import * as React from 'react';
import { IconBolt, IconCheck, IconEye } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { DOCTYPE_LABELS, type Doctype } from '../engine/doctypes';
import type { Quad } from '../engine/types';
import { BAR_SIDE, CaptureBar } from './CaptureBar';
import { CornerEditor } from './CornerEditor';
import { HintPill } from './HintPill';
import { LiveOverlay } from './LiveOverlay';
import { PageView, percent } from './PageView';
import { StatusPill } from './StatusPill';
import { Thumbs } from './Thumbs';
import { kindOf, useScanSession, type Fixable, type KeptPage, type PageTyping, type ScanSessionLike, type UiPage } from './useScanSession';

export type ScannerMode = 'site' | 'lab';

const cannotFix = (): string => tr('This page can no longer be fixed — delete it and take it again');

export function ScannerScreen({ mode, session, onDone, onChoose, camera = true, statusText, initial, kept, onRemoveKept, typing, thumbNote, kindTick, children }: {
  mode: ScannerMode;
  session: ScanSessionLike;
  /** Done (the site) / Show what the models read (the lab): the pages shown at that moment, in order (the kept
   *  ones first, `kept: true`), and `current` — the pages as they are later (a host that waits reads them again);
   *  the site's may give a promise — the scan ends once it resolves true */
  onDone?: (pages: UiPage[], current: () => UiPage[]) => void | Promise<boolean>;
  /** a type picked by hand on a page */
  onChoose?: (id: string, kind: Doctype) => void;
  /** start the camera when shown (default) */
  camera?: boolean;
  /** a status of the screen's own (the models loading) in place of the session's */
  statusText?: string;
  /** the step to open with (the /next gallery's still screens): a page opened large, its corner editor, or the
   *  photo grown in the strip */
  initial?: { page: string; fix?: boolean; grow?: boolean };
  /** the pages the host keeps already (the site: its batches on the phone, the pages from before Scan again) */
  kept?: KeptPage[];
  /** a kept page deleted (once its Undo is over) */
  onRemoveKept?: (id: string) => void;
  /** the host's types of this session's pages (the site), by page id */
  typing?: Record<string, PageTyping>;
  /** a line of the host's under a thumbnail */
  thumbNote?: (p: UiPage) => React.ReactNode;
  /** the lab's document type collection (src/scan/lab/kinds.ts): a page the model answered gets a tick beside its
   *  type chips, which sends the type shown */
  kindTick?: { offered: (id: string) => boolean; sent: (id: string) => boolean; sending?: (id: string) => boolean; onTick: (id: string, kind: Doctype | null) => void };
  /** drawn over the screen (the lab's tools drawer) */
  children?: React.ReactNode;
}) {
  const video = React.useRef<HTMLVideoElement>(null);
  const s = useScanSession(session, { kept, onRemoveKept, typing, onChoose });
  const [finishing, setFinishing] = React.useState(false);
  // the pages that will be saved: not the ones typed Other
  const saved = s.pages.filter(p => kindOf(p) !== 'other').length;
  const finish = async () => {
    if (finishing) return;
    const shown = s.settle();
    const r = onDone?.(shown, s.current);
    if (!r || typeof r.then !== 'function') { s.end(); return; }
    setFinishing(true);
    setOpen(null); setFixing(null); setSelected(null);
    let ok = false;
    try { ok = await r; } catch { ok = false; }
    setFinishing(false);
    if (ok) s.end();
  };
  const [open, setOpen] = React.useState<string | null>(null);
  const [fixing, setFixing] = React.useState<{ id: string; data: Fixable } | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  // the picked picture's size once its image has loaded, by its url (an image that loads before the screen has
  // caught up is not lost: no reset to race with its load)
  const [still, setStill] = React.useState<{ url: string; w: number; h: number } | null>(null);

  // the camera on while the screen is shown; the session put to sleep when it goes (its models kept)
  React.useEffect(() => {
    if (!camera || !video.current) return;
    void session.startCamera(video.current);
    return () => session.sleep();
  }, [session, camera]);

  // a page opened large, or its corners being fixed: the live frame paused under it, going on when it closes
  const isOpen = open != null || fixing != null;
  React.useEffect(() => {
    if (!isOpen) return;
    session.hold();
    return () => session.resume();
  }, [isOpen, session]);

  const page = open ? s.pages.find(p => p.id === open) || null : null;
  const index = page ? s.pages.indexOf(page) + 1 : 0;
  // a page deleted (or gone with its shot) closes its view and its corner editor, and shrinks
  const fixingGone = !!fixing && !s.pages.some(p => p.id === fixing.id);
  const selectedGone = !!selected && !s.pages.some(p => p.id === selected);
  React.useEffect(() => { if (open && !page) { setOpen(null); setFixing(null); } }, [open, page]);
  React.useEffect(() => { if (fixingGone) setFixing(null); }, [fixingGone]);
  React.useEffect(() => { if (selectedGone) setSelected(null); }, [selectedGone]);
  React.useEffect(() => { setNote(null); }, [open, selected]);

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
    if (initial.grow) { setSelected(initial.page); return; }
    setOpen(initial.page);
    if (initial.fix) startFix(initial.page);
  }, [initial, s.pages, startFix]);

  // Escape inside the screen: the step on top first (before the window it is in)
  const root = React.useRef<HTMLDivElement>(null);
  // where the top ends (the status line may take two or three lines): --scan-top on the screen, under it
  const top = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = top.current, box = root.current;
    if (!el || !box || typeof ResizeObserver === 'undefined') return;
    const put = () => { box.style.setProperty('--scan-top', Math.round(el.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 8) + 'px'); };
    const ro = new ResizeObserver(put);
    ro.observe(el);
    put();
    return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    if (!open && !fixing) return;
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
  const remove = (id: string) => { setSelected(null); s.remove(id); };

  const preview = s.preview;
  const size = preview && still && still.url === preview.url ? still : null;
  // the picked picture's frames: the same object while nothing in them changes (its overlay is not redrawn)
  const stillFrame = React.useMemo(() => (preview && size ? { quads: preview.quads, w: size.w, h: size.h } : null), [preview?.quads, size?.w, size?.h]);

  // the newest page of this scan (not one the host kept): its type and % lead the status line while its shot is
  // in work, and a passport whose zone was not found asks for its two lines in the frame
  const newest = [...s.pages].reverse().find(p => !p.kept) || null;
  const newestKind = newest ? kindOf(newest) : null;
  const lead = s.busy && newest && newestKind && !newest.reading
    ? tr(DOCTYPE_LABELS[newestKind]) + (newestKind === newest.model && newest.conf != null ? ' ' + percent(newest.conf) : '') : null;
  const mrz = newest?.shot?.readouts?.mrz;
  const mrzMissing = !!newest && newestKind === 'passport' && !!mrz && !mrz.found;

  const done = mode === 'site'
    ? <Button variant="primary" size="sm" disabled={!saved || finishing} data-testid="scan-done" data-busy={finishing || undefined} onClick={() => { void finish(); }}>
        {finishing ? <Spinner className="size-[18px]" /> : <IconCheck className="size-[18px]" />}{saved ? tr('Done · {n}', { n: saved }) : tr('Done')}
      </Button>
    : <Button variant="primary" size="sm" disabled={!s.pages.length} data-testid="scan-done" onClick={() => onDone?.(s.pages, s.current)} className={BAR_SIDE}
        aria-label={tr('Show what the models read')} title={tr('Show what the models read')}>
        <IconEye className="size-[18px]" />{tr('Models read')}
      </Button>;

  return (
    <div ref={root} data-testid="scanner" data-mode={mode} className="relative isolate size-full overflow-hidden bg-background text-ink">
      {/* the camera, cropped to fill the screen, and its live frame */}
      <video ref={video} muted playsInline autoPlay data-testid="scan-video" className="absolute inset-0 size-full object-cover" />
      {!preview && <LiveOverlay session={session} video={video} />}
      {/* a picked picture, shown whole the moment it is being worked on */}
      {preview && (
        <div data-testid="scan-preview" data-stage={preview.stage} data-frames={preview.quads.length} className="absolute inset-0 bg-background">
          <img src={preview.url} alt="" draggable={false} className="absolute inset-0 size-full object-contain"
            onLoad={e => { const im = e.currentTarget; setStill({ url: im.getAttribute('src') || '', w: im.naturalWidth, h: im.naturalHeight }); }} />
          {stillFrame && <LiveOverlay session={session} video={video} still={stillFrame} />}
        </div>
      )}

      {/* the top: the status line in the middle, Auto at the right; a long status takes the width left of Auto too
          and wraps onto more lines rather than being cut (owner, 2026-10-27: "A corner is ou…" on a phone of 390 px);
          what lies under the top (the lab's Lab tools, the site's errors) is put under it by --scan-top */}
      <div ref={top} data-testid="scan-top" className="absolute inset-x-0 top-0 z-10 flex items-start gap-2 px-4 pt-[calc(28px+env(safe-area-inset-top,0px))]">
        {/* as wide as Auto, so a short status sits in the screen's middle; it gives its width up first to a long one */}
        <div aria-hidden className="invisible flex min-w-0 shrink-[100000] overflow-hidden">
          <Button size="sm" tabIndex={-1}><IconBolt className="size-[18px]" />{tr('Auto')}</Button>
        </div>
        <div className="flex min-w-0 flex-[1_1_auto] justify-center">
          <StatusPill session={session} text={statusText} lead={lead} className="max-w-full" />
        </div>
        <Button size="sm" on={s.auto} aria-pressed={s.auto} disabled={finishing} onClick={() => s.setAuto(!s.auto)} data-testid="scan-auto"
          className={cn('shrink-0', !s.auto && 'opacity-70')}><IconBolt className="size-[18px]" />{tr('Auto')}</Button>
      </div>

      {/* the hint for the person, under the camera's frame */}
      <HintPill session={session} video={video} mrzMissing={mrzMissing} hidden={!!preview || isOpen} />

      {/* the bottom: the photos taken, and the bar */}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background/85 to-transparent pt-6">
        {note && !page && <p data-testid="scan-note" role="alert" className="mx-4 mb-1 text-center text-[13px] text-[var(--amber-text)]">{note}</p>}
        <Thumbs pages={s.pages} selected={selected} onSelect={setSelected} locked={finishing} note={thumbNote}
          onOpen={id => { if (!finishing) setOpen(id); }}
          onFix={id => { if (!finishing) startFix(id); }}
          onDelete={remove} />
        <CaptureBar disabled={s.busy || s.picking} locked={finishing} onShutter={s.shutter} onPick={s.pick} done={done} />
      </div>

      {page && (
        <PageView page={page} index={index} note={note}
          onChoose={k => s.choose(page.id, k)}
          onFix={() => startFix(page.id)}
          onDelete={() => { setOpen(null); remove(page.id); }}
          onKeep={() => { setOpen(null); s.keep(page.id); }}
          onClose={() => setOpen(null)}
          onTick={kindTick && !page.kept && kindTick.offered(page.id) ? () => kindTick.onTick(page.id, kindOf(page)) : undefined}
          tickSent={kindTick ? kindTick.sent(page.id) : undefined} tickSending={kindTick?.sending ? kindTick.sending(page.id) : undefined} />
      )}
      {fixing && <CornerEditor key={fixing.id} frame={fixing.data.frame} start={fixing.data.pts} onApply={apply} onCancel={() => setFixing(null)} />}
      {children}
    </div>
  );
}
