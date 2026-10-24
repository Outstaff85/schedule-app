// The full-screen scanner (docs/scan-plan.md → S9): the lab's figures (ms per frame, camera frames/s,
// confidence, the follow…) for the lab's tools. The session sends them on every camera frame and every model
// answer; they are drawn at most `perSecond` times a second, and only while `on` (the tools drawer open) —
// so neither the screen nor the site pays for them.
import * as React from 'react';
import type { Figures } from '../engine/live';
import type { ScanSessionLike } from './useScanSession';

export function useFigures(session: ScanSessionLike, on: boolean, perSecond = 4): Figures | null {
  const [figures, setFigures] = React.useState<Figures | null>(null);
  React.useEffect(() => {
    if (!on) return;
    let latest: Figures | null = null, drawn: Figures | null = null;
    const off = session.on('figures', f => { latest = f; });
    const timer = window.setInterval(() => { if (latest !== drawn) { drawn = latest; setFigures(latest); } }, Math.round(1000 / perSecond));
    return () => { off(); window.clearInterval(timer); };
  }, [session, on, perSecond]);
  return figures;
}
