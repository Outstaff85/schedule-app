// The full-screen scanner (docs/scan-plan.md → S9): the live frame drawn over the camera — the session's frame
// event, every screen frame, straight onto a canvas (no React render): red while it is still searching, green
// once it has stuck (the sticky frame of steady.ts). The video fills the screen cropped (object-fit: cover), so
// the frame's points — shares of the camera's picture — are mapped the same way. With `still`, the frame of a
// picked picture shown whole (object-fit: contain) instead. The colours are the design system's (og.css --red,
// --green), read from the page, so the light theme's apply too.
import * as React from 'react';
import type { Quad } from '../engine/types';
import type { ScanSessionLike } from './useScanSession';

/** A token's colour from og.css. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Where a picture of w×h lands in a box of bw×bh: cover crops it to fill, contain shows it whole. */
export function fitBox(w: number, h: number, bw: number, bh: number, fit: 'cover' | 'contain'): { k: number; ox: number; oy: number } {
  const k = fit === 'cover' ? Math.max(bw / w, bh / h) : Math.min(bw / w, bh / h);
  return { k, ox: (bw - w * k) / 2, oy: (bh - h * k) / 2 };
}

/** The frame drawn on g (a box of bw×bh css px) for a picture of w×h. */
export function drawQuad(g: CanvasRenderingContext2D, quad: Quad, ok: boolean, w: number, h: number, bw: number, bh: number, fit: 'cover' | 'contain'): void {
  const { k, ox, oy } = fitBox(w, h, bw, bh, fit);
  const colour = token(ok ? '--green' : '--red');
  g.beginPath();
  quad.forEach(([x, y], i) => (i ? g.lineTo(ox + x * w * k, oy + y * h * k) : g.moveTo(ox + x * w * k, oy + y * h * k)));
  g.closePath();
  g.globalAlpha = 0.16;
  g.fillStyle = colour;
  g.fill();
  g.globalAlpha = 1;
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.strokeStyle = colour;
  g.stroke();
}

export function LiveOverlay({ session, video, still }: {
  session: ScanSessionLike;
  video: React.RefObject<HTMLVideoElement | null>;
  /** A picked picture's frame (its size in px): drawn whole instead of the live frame. */
  still?: { quad: Quad | null; w: number; h: number } | null;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  // the canvas's size follows its box (and the screen's pixel ratio)
  const sized = React.useCallback((): { g: CanvasRenderingContext2D; bw: number; bh: number } | null => {
    const cv = ref.current, g = cv && cv.getContext('2d');
    if (!cv || !g) return null;
    const bw = cv.clientWidth, bh = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(bw * dpr) || cv.height !== Math.round(bh * dpr)) { cv.width = Math.round(bw * dpr); cv.height = Math.round(bh * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, bw, bh);
    return { g, bw, bh };
  }, []);

  React.useEffect(() => {
    if (still) {
      const draw = () => { const c = sized(); if (c && still.quad) drawQuad(c.g, still.quad, true, still.w, still.h, c.bw, c.bh, 'contain'); };
      draw();
      window.addEventListener('resize', draw);
      return () => window.removeEventListener('resize', draw);
    }
    const off = session.on('frame', (quad, ok) => {
      const c = sized(), v = video.current;
      if (!c || !quad || !v || !v.videoWidth) return;
      drawQuad(c.g, quad, ok, v.videoWidth, v.videoHeight, c.bw, c.bh, 'cover');
    });
    return () => { off(); sized(); };
  }, [session, video, still, sized]);

  return <canvas ref={ref} aria-hidden data-testid="scan-overlay" className="pointer-events-none absolute inset-0 size-full" />;
}
