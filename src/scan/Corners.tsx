// The corner editor of the scan window (docs/scan.md → The scan window → Corners):
// the photo with the document's frame as the model found it; each corner is dragged
// with a finger or the mouse, a loupe above the finger shows the edge up close.
// Apply hands back the corners (0..1 of the photo); the scan window has the page cut
// by them on the server and keeps the correction as a training example (S6).
import * as React from 'react';
import { IconCheck, IconLoader2 } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { tr } from '@/lib/i18n';
import type { Pt } from './core';

const LOUPE = 112, ZOOM = 2.5;

export function Corners({ src, quad, busy, onApply }: { src: string; quad: Pt[]; busy: boolean; onApply: (q: Pt[]) => void }) {
  const [pts, setPts] = React.useState<Pt[]>(quad);
  const [drag, setDrag] = React.useState<number | null>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const img = React.useRef<HTMLImageElement>(null);
  const loupe = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => setPts(quad), [quad]);

  const at = (e: React.PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const drawLoupe = (p: Pt) => {
    const c = loupe.current, im = img.current;
    if (!c || !im || !im.naturalWidth) return;
    const dpr = window.devicePixelRatio || 1, n = Math.round(LOUPE * dpr);
    if (c.width !== n) { c.width = n; c.height = n; }
    const g = c.getContext('2d')!, sw = im.naturalWidth * (LOUPE / ZOOM) / box.current!.getBoundingClientRect().width;
    g.clearRect(0, 0, n, n);
    g.drawImage(im, p[0] * im.naturalWidth - sw / 2, p[1] * im.naturalHeight - sw / 2, sw, sw, 0, 0, n, n);
    const css = getComputedStyle(c);
    g.strokeStyle = css.getPropertyValue('--ok').trim() || '#4ade80'; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.moveTo(n / 2, 0); g.lineTo(n / 2, n); g.moveTo(0, n / 2); g.lineTo(n, n / 2); g.stroke();
  };
  const down = (k: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag(k); drawLoupe(pts[k]);
  };
  const move = (e: React.PointerEvent) => {
    if (drag === null) return;
    const p = at(e);
    setPts(ps => ps.map((q, i) => (i === drag ? p : q)));
    drawLoupe(p);
  };
  const up = () => setDrag(null);

  const poly = pts.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
  const lp = drag !== null ? pts[drag] : null;
  return (
    <div className="flex flex-col gap-3" data-testid="scan-corners">
      <div ref={box} className="relative touch-none select-none overflow-hidden rounded-lg bg-black" data-vaul-no-drag
        onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <img ref={img} src={src} alt="" draggable={false} className="block h-auto w-full" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
          <polygon points={poly} fill="none" stroke="var(--ok)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        </svg>
        {pts.map(([x, y], k) => (
          <button key={k} type="button" aria-label={tr('Corner {0}', { 0: k + 1 })} data-testid="scan-corner"
            className="absolute -ml-[22px] -mt-[22px] size-11 rounded-full" style={{ left: x * 100 + '%', top: y * 100 + '%' }}
            onPointerDown={down(k)}>
            <span className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ok bg-background/40" />
          </button>
        ))}
        <canvas ref={loupe} hidden={!lp} className="pointer-events-none absolute rounded-full border-2 border-ok shadow-lg"
          style={lp ? { width: LOUPE, height: LOUPE, left: `calc(${lp[0] * 100}% - ${LOUPE / 2}px)`, top: `calc(${lp[1] * 100}% - ${LOUPE + 40}px)` } : undefined} />
      </div>
      <div className="flex justify-end">
        <Button variant="primary" data-testid="scan-corners-apply" disabled={busy} onClick={() => onApply(pts)}>
          {busy ? <IconLoader2 className="size-[18px] animate-spin" /> : <IconCheck className="size-[18px]" />}{tr('Apply')}
        </Button>
      </div>
    </div>
  );
}
