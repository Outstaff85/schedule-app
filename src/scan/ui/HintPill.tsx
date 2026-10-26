// The full-screen scanner (docs/scan-plan.md → S9, the owner's template "6 · Camera — selected photo grows",
// 2026-10-26): the hint for the person, under the camera's frame — what to do now ("Put the document in the
// frame", "Move the phone back a little", "A little closer", "Keep the two lines at the bottom in the frame" …),
// picked from the session's status and the live frame (status-text.ts sessionHint). It follows the live frame:
// drawn just under the document's lowest corner (straight on its element, no React render per camera frame),
// in the middle of the screen while there is no frame; it is drawn again only when its words change.
import * as React from 'react';
import { cn } from '@/lib/utils';
import { hintText, sessionHint, SMALL_DOC, type ScanHint } from '../status-text';
import type { SessionStatus } from '../engine/status';
import type { Quad } from '../engine/types';
import { fitBox } from './LiveOverlay';
import type { ScanSessionLike } from './useScanSession';

/** A frame's area as a share of the picture (its corners are shares of the picture). */
export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % 4]; a += x0 * y1 - x1 * y0; }
  return Math.abs(a) / 2;
}

export function HintPill({ session, video, mrzMissing, hidden }: {
  session: ScanSessionLike;
  video: React.RefObject<HTMLVideoElement | null>;
  /** the newest page taken is a passport whose two lines at the bottom were not found */
  mrzMissing: boolean;
  /** not shown (a picked picture on the screen, a page opened large) */
  hidden?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [hint, setHint] = React.useState<ScanHint | null>(null);
  const state = React.useRef<{ status: SessionStatus | null; small: boolean; mrz: boolean }>({ status: null, small: false, mrz: mrzMissing });
  const pick = React.useCallback(() => {
    const st = state.current;
    const h = sessionHint(st.status, { small: st.small, mrzMissing: st.mrz });
    setHint(prev => (prev === h ? prev : h));
  }, []);
  React.useEffect(() => { state.current.mrz = mrzMissing; pick(); }, [mrzMissing, pick]);

  React.useEffect(() => {
    state.current.status = null; state.current.small = false;
    const offStatus = session.on('status', s => { state.current.status = s; pick(); });
    const offFrame = session.on('frame', quad => {
      const small = !!quad && quadArea(quad) < SMALL_DOC;
      if (small !== state.current.small) { state.current.small = small; pick(); }
      // under the frame's lowest corner, kept clear of the top line and the strip
      const el = ref.current, box = el && el.parentElement, v = video.current;
      if (!el || !box) return;
      const bh = box.clientHeight;
      let top = bh * 0.5;
      if (quad && v && v.videoWidth) {
        const { k, oy } = fitBox(v.videoWidth, v.videoHeight, box.clientWidth, bh, 'cover');
        top = oy + Math.max(...quad.map(p => p[1])) * v.videoHeight * k + 14;
      }
      el.style.top = Math.round(Math.max(84, Math.min(bh - 300, top))) + 'px';
    });
    return () => { offStatus(); offFrame(); };
  }, [session, video, pick]);

  return (
    <div ref={ref} aria-live="polite" data-testid="scan-tip" data-hint={hint || undefined}
      className={cn('pointer-events-none absolute inset-x-0 top-1/2 z-10 justify-center px-6', hidden || !hint ? 'hidden' : 'flex')}>
      {hint && <span className="og-glass-menu max-w-full !rounded-full px-3.5 py-1.5 text-center text-[13px] text-ink">{hintText(hint)}</span>}
    </div>
  );
}
