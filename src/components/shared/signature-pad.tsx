// SignaturePad: a glass box to sign in with a finger (or a mouse). The ink is
// the page's text colour on screen; `image()` gives the signature as a PNG
// (dark ink on a clear background, ready for a white page); `clear()` wipes
// it. `onInk(has)` tells the caller whether anything is drawn. `initial` (a PNG
// data URL) is a signature drawn before — the manager's worker window keeps it
// across a rescan; it counts as ink until cleared. Inside a
// Window on a phone the box does not drag the sheet (data-vaul-no-drag).
import * as React from 'react';
import { IconEraser } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface SignaturePadHandle {
  /** the signature as a PNG data URL, dark ink on a clear background; null when empty */
  image: () => string | null;
  clear: () => void;
}

type Pt = { x: number; y: number };

export const SignaturePad = React.forwardRef<SignaturePadHandle, { onInk?: (has: boolean) => void; className?: string; initial?: string | null }>(
  function SignaturePad({ onInk, className, initial }, ref) {
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const strokes = React.useRef<Pt[][]>([]);
    const base = React.useRef<HTMLImageElement | null>(null);
    const [has, setHas] = React.useState(!!initial);

    const draw = React.useCallback((c: HTMLCanvasElement, color: string, scale: number) => {
      const g = c.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, c.width, c.height);
      if (base.current && base.current.complete) g.drawImage(base.current, 0, 0, c.width, c.height);
      g.strokeStyle = color; g.lineWidth = 2.4 * scale; g.lineCap = 'round'; g.lineJoin = 'round';
      strokes.current.forEach(s => {
        g.beginPath();
        s.forEach((p, i) => (i ? g.lineTo(p.x * scale, p.y * scale) : g.moveTo(p.x * scale, p.y * scale)));
        if (s.length === 1) g.lineTo(s[0].x * scale + 0.1, s[0].y * scale);
        g.stroke();
      });
    }, []);
    const redraw = React.useCallback(() => {
      const c = canvas.current;
      if (!c) return;
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      draw(c, getComputedStyle(c).color, dpr);
    }, [draw]);
    React.useEffect(() => {
      if (!initial) return;
      const im = new Image();
      im.onload = () => redraw();
      im.src = initial;
      base.current = im;
    }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => {
      redraw();
      const ro = new ResizeObserver(redraw);
      if (canvas.current) ro.observe(canvas.current);
      return () => ro.disconnect();
    }, [redraw]);

    const mark = (v: boolean) => { if (v !== has) { setHas(v); onInk?.(v); } };
    const at = (e: React.PointerEvent): Pt => {
      const r = canvas.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: React.PointerEvent) => {
      e.preventDefault();
      canvas.current!.setPointerCapture(e.pointerId);
      strokes.current.push([at(e)]);
      redraw(); mark(true);
    };
    const move = (e: React.PointerEvent) => {
      const s = strokes.current[strokes.current.length - 1];
      if (!s || !canvas.current!.hasPointerCapture(e.pointerId)) return;
      s.push(at(e)); redraw();
    };
    const clear = () => { strokes.current = []; base.current = null; redraw(); mark(false); };

    React.useImperativeHandle(ref, () => ({
      clear,
      image: () => {
        const c = canvas.current;
        if (!c || (!strokes.current.length && !base.current)) return null;
        const r = c.getBoundingClientRect(), out = document.createElement('canvas');
        out.width = Math.round(r.width * 2); out.height = Math.round(r.height * 2);
        draw(out, '#10213a', 2);
        return out.toDataURL('image/png');
      },
    }));

    return (
      <div className={cn('grid gap-1.5', className)}>
        <canvas
          ref={canvas}
          data-testid="signature-pad"
          data-vaul-no-drag=""
          data-ink={has ? '1' : '0'}
          aria-label={tr('Sign here')}
          className="h-40 w-full cursor-crosshair touch-none rounded-lg border border-dashed border-border bg-white/[.04] text-foreground"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={e => canvas.current?.releasePointerCapture(e.pointerId)}
        />
        <div className="flex items-center justify-between text-[11px] text-faint">
          <span>{has ? '' : tr('Sign here with your finger')}</span>
          <Button size="sm" variant="ghost" disabled={!has} onClick={clear} data-testid="signature-clear"><IconEraser className="size-4" />{tr('Clear')}</Button>
        </div>
      </div>
    );
  },
);
