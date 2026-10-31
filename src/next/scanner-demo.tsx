// /next — the full-screen scanner (docs/scan-plan.md → S9, src/scan/ui/) on a fake session (no camera, no
// models): the screens at a phone's size (390×844), the owner's template "6 · Camera — selected photo grows" —
// the camera with the status line on top, Auto at the top right, the hint under the frame, the photos' strip with
// their % and the bar (Photos/PDF, the shutter, Done); a photo grown in the strip (its type and %, Edit corners,
// Delete); a page opened large with its type chips; the corner editor — and the scanner in a full Window (with a
// page its host kept from before, first in the strip). The first screen plays: the status changes, the shutter
// takes a page, a tap grows a photo, its type opens it, Fix corners / Delete / Looks good work; what it asked the
// session for is listed under it, and a button under it plays Auto turning itself off. The full window's "models"
// take a moment after its camera shows, with the shutter off meanwhile.
import * as React from 'react';
import { toast } from 'sonner';
import { IconScan } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Window } from '@/components/shared/window';
import { ScannerScreen } from '@/scan/ui/ScannerScreen';
import { FakeScanSession } from '@/scan/ui/fake-session';
import { token } from '@/scan/ui/LiveOverlay';
import type { KeptPage } from '@/scan/ui/useScanSession';

function PhoneFrame({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <figure className="grid w-[min(390px,100%)] gap-2" data-testid={id}>
      <figcaption className="og-label">{label}</figcaption>
      <div className="relative h-[844px] w-full overflow-hidden rounded-[28px] border border-white/15 shadow-[var(--shadow-pop)]">{children}</div>
    </figure>
  );
}

/** A page the host keeps already (the site's batches on the phone until read): drawn once, as a data URL. */
function keptPicture(): string {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  if (!g) return '';
  c.width = 300; c.height = 420;
  g.fillStyle = token('--ink'); g.fillRect(0, 0, 300, 420);
  g.fillStyle = token('--uline-1'); g.fillRect(0, 0, 300, 60);
  return c.toDataURL('image/png');
}

export function ScannerDemo() {
  const live = React.useMemo(() => new FakeScanSession(3), []);
  const pageSession = React.useMemo(() => new FakeScanSession(3), []);
  const fixSession = React.useMemo(() => new FakeScanSession(3), []);
  const growSession = React.useMemo(() => new FakeScanSession(3), []);
  const [full, setFull] = React.useState(false);
  const fullSession = React.useMemo(() => (full ? new FakeScanSession(2, 1200) : null), [full]);
  // the full window's host keeps a page from before (a contract on the phone): first in the strip, counted in Done
  const [kept, setKept] = React.useState<KeptPage[]>([]);
  React.useEffect(() => { if (full) setKept([{ id: 'kept1', src: keptPicture(), kind: 'contract' }]); }, [full]);
  const [calls, setCalls] = React.useState<string[]>([]);
  React.useEffect(() => { live.onCall = () => setCalls([...live.calls]); return () => { live.onCall = null; }; }, [live]);
  const done = (n: number) => toast(tr('{n} pages done', { n }));
  return (
    <section data-testid="demo-scanner" className="grid gap-4">
      <p className="text-[13px] text-muted-foreground">{tr('The scanner on a fake session: no camera and no models. The first screen plays — the shutter takes a page, a tap on a photo makes it grow, its type opens it.')}</p>
      <div className="flex flex-wrap gap-5">
        <PhoneFrame id="scanner-camera" label={tr('Camera')}>
          <ScannerScreen back={false} mode="site" session={live} onDone={p => { done(p.length); }} />
        </PhoneFrame>
        <PhoneFrame id="scanner-grow" label={tr('A photo grown in the strip')}>
          <ScannerScreen back={false} mode="site" session={growSession} camera={false} initial={{ page: 'p1', grow: true }} />
        </PhoneFrame>
        <PhoneFrame id="scanner-page" label={tr('A page opened large')}>
          <ScannerScreen back={false} mode="site" session={pageSession} camera={false} initial={{ page: 'p1' }} />
        </PhoneFrame>
        <PhoneFrame id="scanner-fix" label={tr('Fix corners')}>
          <ScannerScreen back={false} mode="site" session={fixSession} camera={false} initial={{ page: 'p2', fix: true }} />
        </PhoneFrame>
      </div>
      <p data-testid="scanner-calls" className="font-mono text-[12px] text-ink-2">{calls.length ? calls.join(' · ') : tr('Nothing asked yet')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setFull(true)} data-testid="open-scanner"><IconScan className="size-[18px]" />{tr('Open the scanner full screen')}</Button>
        <Button onClick={() => live.autoStop()} data-testid="scanner-auto-stop">{tr('Auto stops itself')}</Button>
      </div>
      <Window full open={full} onOpenChange={setFull} title={tr('Scanner')}>
        {fullSession && <ScannerScreen back={false} mode="site" session={fullSession} kept={kept} onRemoveKept={id => setKept(k => k.filter(x => x.id !== id))}
          onDone={p => { setFull(false); done(p.length); }} />}
      </Window>
    </section>
  );
}
