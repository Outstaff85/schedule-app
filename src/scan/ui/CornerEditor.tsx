// The full-screen scanner (docs/scan-plan.md → S9): the corner editor — the lab's cornerEditor (its former
// plain page, S8-3) in React, a step inside the scanner screen (not a window of its own). The page's whole photo
// fitted to the screen with the four corners the model found, the photo outside them dimmed and a 3×3 grid inside
// them to line the document's text up with (the owner's template pair 6, 2026-10-26). A corner (an L-bracket) is
// dragged alone to the document's corner; a whole side moves along its normal — both its corners — by its middle
// bar or by its line itself (a press within 24 px of it). The picking and the moves are src/scan/ui/quad-edit.ts:
// a press within 48 px of a corner or a middle bar picks the nearest up, the pointer captured until it is let go;
// everything stays on the photo. Apply gives the corners rounded to 5 decimals (session.fix cuts the page again
// from them and sends them with its training attempt as the right answer), Cancel gives nothing. The colours are
// the design system's (og.css --uline-2, the lab's cyan, --ink and --glass-sheet), read from the page.
import * as React from 'react';
import { IconCheck } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import type { Pt, Quad } from '../engine/types';
import { fitBox, token } from './LiveOverlay';
import { gridLines, moveCorner, moveSide, pickHandle, roundCorners, sideMid, type Grab } from './quad-edit';

export { PICK_RADIUS, LINE_RADIUS, pickCorner, pickHandle, roundCorners } from './quad-edit';

/** The length (px) of a corner's bracket arms and of a side's middle bar. */
const ARM = 22, BAR = 34;

export function CornerEditor({ frame, start, onApply, onCancel }: {
  frame: CanvasImageSource & { width: number; height: number };
  start: Quad;
  onApply: (pts: Quad) => void;
  onCancel: () => void;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const cv = React.useRef<HTMLCanvasElement>(null);
  const pts = React.useRef<Quad>(start.map(p => p.slice() as Pt) as Quad);
  // what the press holds, with the corners and the pointer (shares) as they were when it was pressed
  const drag = React.useRef<{ grab: Grab; from: Quad; x: number; y: number }>({ grab: null, from: pts.current, x: 0, y: 0 });
  const fit = React.useRef({ ox: 0, oy: 0, iw: 1, ih: 1 });

  const draw = React.useCallback(() => {
    const c = cv.current, w = wrap.current, g = c && c.getContext('2d');
    if (!c || !w || !g) return;
    const r = w.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const { k, ox, oy } = fitBox(frame.width, frame.height, r.width, r.height, 'contain');
    const iw = frame.width * k, ih = frame.height * k;
    fit.current = { ox, oy, iw, ih };
    const line = token('--uline-2'), ink = token('--ink'), dim = token('--glass-sheet');
    const S = ([x, y]: Pt): Pt => [ox + x * iw, oy + y * ih];
    const q = pts.current, held = drag.current.grab;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    g.drawImage(frame, ox, oy, iw, ih);
    // the photo outside the quad dimmed
    g.beginPath(); g.rect(ox, oy, iw, ih);
    q.forEach((p, i) => (i ? g.lineTo(...S(p)) : g.moveTo(...S(p))));
    g.closePath(); g.fillStyle = dim; g.fill('evenodd');
    // the 3×3 grid
    g.strokeStyle = line; g.lineWidth = 1; g.globalAlpha = 0.6;
    g.beginPath();
    for (const [a, b] of gridLines(q)) { g.moveTo(...S(a)); g.lineTo(...S(b)); }
    g.stroke(); g.globalAlpha = 1;
    // the quad
    g.strokeStyle = line; g.lineWidth = 2.5;
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(...S(p)) : g.moveTo(...S(p))));
    g.closePath(); g.stroke();
    // the handles: a dark rim under a light stroke, the held one in the lab's cyan
    g.lineCap = 'round'; g.lineJoin = 'round';
    const along = (from: Pt, to: Pt, len: number): Pt => {
      const dx = to[0] - from[0], dy = to[1] - from[1], l = Math.hypot(dx, dy) || 1;
      return [from[0] + dx / l * Math.min(len, l / 2), from[1] + dy / l * Math.min(len, l / 2)];
    };
    const handle = (path: () => void, on: boolean) => {
      g.beginPath(); path(); g.strokeStyle = dim; g.lineWidth = 9; g.stroke();
      g.beginPath(); path(); g.strokeStyle = on ? line : ink; g.lineWidth = 5; g.stroke();
    };
    for (let i = 0; i < 4; i++) {  // a side's middle bar, along the side
      const a = S(q[i]), b = S(q[(i + 1) % 4]), m = S(sideMid(q, i));
      const p0 = along(m, a, BAR / 2), p1 = along(m, b, BAR / 2);
      handle(() => { g.moveTo(...p0); g.lineTo(...p1); }, held?.kind === 'side' && held.i === i);
    }
    for (let i = 0; i < 4; i++) {  // a corner's L-bracket, along its two sides
      const p = S(q[i]), n = along(p, S(q[(i + 1) % 4]), ARM), b = along(p, S(q[(i + 3) % 4]), ARM);
      handle(() => { g.moveTo(...n); g.lineTo(...p); g.lineTo(...b); }, held?.kind === 'corner' && held.i === i);
    }
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    c.dataset.pts = JSON.stringify(q);
    c.dataset.fit = [ox, oy, iw, ih].map(v => v.toFixed(2)).join(',');
    c.dataset.grab = held ? held.kind + held.i : '';
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
    const grab = pickHandle(pts.current, x, y, fit.current.iw, fit.current.ih);
    drag.current = { grab, from: pts.current.map(p => p.slice() as Pt) as Quad, x, y };
    if (!grab) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no live pointer (a test's event) */ }
    draw();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d.grab) return;
    const [x, y] = at(e);
    pts.current = d.grab.kind === 'corner'
      ? moveCorner(pts.current, d.grab.i, x, y)
      : moveSide(d.from, d.grab.i, x - d.x, y - d.y, fit.current.iw, fit.current.ih);
    draw();
  };
  const up = () => {
    if (!drag.current.grab) return;
    drag.current = { ...drag.current, grab: null };
    draw();
  };

  return (
    <div data-testid="corner-editor" className="absolute inset-0 z-30 flex flex-col gap-3 bg-background px-3.5 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-[calc(28px+env(safe-area-inset-top,0px))]">
      <div className="og-glass-menu self-center !rounded-full px-4 py-2 text-center text-[14px] font-semibold">{tr("Drag a corner or a side to the document's edge")}</div>
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
