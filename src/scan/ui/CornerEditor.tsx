// The full-screen scanner (docs/scan-plan.md → S9): the corner editor — the lab's cornerEditor (scan-lab/
// index.html, S8-3) in React, a step inside the scanner screen (not a window of its own). The page's whole photo
// fitted to the screen with the four corners the model found; each is dragged to the document's real corner (a
// press within 48 px of a corner picks it up, the pointer captured until it is let go; a corner stays on the
// photo); Apply gives the corners rounded to 5 decimals (session.fix cuts the page again from them and sends
// them with its training attempt as the right answer), Cancel gives nothing. The colours are the design
// system's (og.css --uline-2, the lab's cyan, and --ink), read from the page.
import * as React from 'react';
import { IconCheck } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import type { Pt, Quad } from '../engine/types';
import { fitBox, token } from './LiveOverlay';

/** The pick radius (px on the screen) of a corner. */
export const PICK_RADIUS = 48;

/** The corners as Apply gives them: rounded to 5 decimals. */
export const roundCorners = (pts: Quad): Quad => pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)] as Pt);

/** The corner within PICK_RADIUS px of (x, y) — the nearest —, -1 when none (x, y and the corners in shares of a
 *  photo drawn iw×ih px). */
export function pickCorner(pts: Quad, x: number, y: number, iw: number, ih: number): number {
  let best = 1e9, at = -1;
  pts.forEach(([px, py], i) => { const d = Math.hypot((px - x) * iw, (py - y) * ih); if (d < best && d < PICK_RADIUS) { best = d; at = i; } });
  return at;
}

export function CornerEditor({ frame, start, onApply, onCancel }: {
  frame: CanvasImageSource & { width: number; height: number };
  start: Quad;
  onApply: (pts: Quad) => void;
  onCancel: () => void;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const cv = React.useRef<HTMLCanvasElement>(null);
  const pts = React.useRef<Quad>(start.map(p => p.slice() as Pt));
  const drag = React.useRef(-1);
  const fit = React.useRef({ ox: 0, oy: 0, iw: 1, ih: 1 });

  const draw = React.useCallback(() => {
    const c = cv.current, w = wrap.current, g = c && c.getContext('2d');
    if (!c || !w || !g) return;
    const r = w.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const { k, ox, oy } = fitBox(frame.width, frame.height, r.width, r.height, 'contain');
    const iw = frame.width * k, ih = frame.height * k;
    fit.current = { ox, oy, iw, ih };
    const line = token('--uline-2'), ring = token('--ink');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    g.drawImage(frame, ox, oy, iw, ih);
    g.strokeStyle = line; g.lineWidth = 2.5;
    g.beginPath();
    pts.current.forEach(([x, y], i) => (i ? g.lineTo(ox + x * iw, oy + y * ih) : g.moveTo(ox + x * iw, oy + y * ih)));
    g.closePath(); g.stroke();
    for (const [x, y] of pts.current) {
      g.beginPath(); g.arc(ox + x * iw, oy + y * ih, 14, 0, 7);
      g.globalAlpha = 0.25; g.fillStyle = line; g.fill(); g.globalAlpha = 1;
      g.strokeStyle = ring; g.lineWidth = 3; g.stroke();
    }
    c.dataset.pts = JSON.stringify(pts.current);
    c.dataset.fit = [ox, oy, iw, ih].map(v => v.toFixed(2)).join(',');
  }, [frame]);

  React.useEffect(() => {
    draw();
    const ro = new ResizeObserver(draw);
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [draw]);

  const at = (e: React.PointerEvent): [number, number] => {
    const b = cv.current!.getBoundingClientRect(), { ox, oy, iw, ih } = fit.current;
    return [(e.clientX - b.left - ox) / iw, (e.clientY - b.top - oy) / ih];
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = at(e);
    drag.current = pickCorner(pts.current, x, y, fit.current.iw, fit.current.ih);
    if (drag.current >= 0) try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no live pointer (a test's event) */ }
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current < 0) return;
    const [x, y] = at(e);
    pts.current[drag.current] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    draw();
  };
  const up = () => { drag.current = -1; };

  return (
    <div data-testid="corner-editor" className="absolute inset-0 z-30 flex flex-col gap-3 bg-background px-3.5 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-[calc(28px+env(safe-area-inset-top,0px))]">
      <div className="og-glass-menu self-center !rounded-full px-4 py-2 text-[14px] font-semibold">{tr("Drag each corner to the document's corner")}</div>
      <div ref={wrap} className="relative min-h-0 flex-1">
        <canvas ref={cv} data-testid="corner-canvas" className="absolute inset-0 size-full touch-none"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <div className="flex gap-2 [&>*]:flex-1">
        <Button onClick={onCancel} data-testid="corner-cancel">{tr('Cancel')}</Button>
        <Button variant="primary" onClick={() => onApply(roundCorners(pts.current))} data-testid="corner-apply"><IconCheck className="size-[18px]" />{tr('Apply')}</Button>
      </div>
    </div>
  );
}
