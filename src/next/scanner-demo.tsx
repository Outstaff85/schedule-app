// /next — the full-screen scanner (docs/scan-plan.md → S9, src/scan/ui/) on a fake session (no camera, no
// models): the three screens at a phone's size (390×844) — the camera with the status line, the pages' strip,
// the bar and Done; a page opened large with its type chips; the corner editor — and the scanner in a full
// Window. The first screen plays: the status changes, the shutter takes a page, a thumbnail opens it, Fix
// corners / Delete / Looks good work; what it asked the session for is listed under it.
import * as React from 'react';
import { toast } from 'sonner';
import { IconScan } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Window } from '@/components/shared/window';
import { ScannerScreen } from '@/scan/ui/ScannerScreen';
import { FakeScanSession } from '@/scan/ui/fake-session';

function PhoneFrame({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <figure className="grid w-[min(390px,100%)] gap-2" data-testid={id}>
      <figcaption className="og-label">{label}</figcaption>
      <div className="relative h-[844px] w-full overflow-hidden rounded-[28px] border border-white/15 shadow-[var(--shadow-pop)]">{children}</div>
    </figure>
  );
}

export function ScannerDemo() {
  const live = React.useMemo(() => new FakeScanSession(3), []);
  const pageSession = React.useMemo(() => new FakeScanSession(3), []);
  const fixSession = React.useMemo(() => new FakeScanSession(3), []);
  const [full, setFull] = React.useState(false);
  const fullSession = React.useMemo(() => (full ? new FakeScanSession(2) : null), [full]);
  const [calls, setCalls] = React.useState<string[]>([]);
  React.useEffect(() => { live.onCall = () => setCalls([...live.calls]); return () => { live.onCall = null; }; }, [live]);
  const done = (n: number) => toast(tr('{n} pages done', { n }));
  return (
    <section data-testid="demo-scanner" className="grid gap-4">
      <p className="text-[13px] text-muted-foreground">{tr('The scanner on a fake session: no camera and no models. The first screen plays — the shutter takes a page, a thumbnail opens it.')}</p>
      <div className="flex flex-wrap gap-5">
        <PhoneFrame id="scanner-camera" label={tr('Camera')}>
          <ScannerScreen mode="site" session={live} onDone={p => done(p.length)} />
        </PhoneFrame>
        <PhoneFrame id="scanner-page" label={tr('A page opened large')}>
          <ScannerScreen mode="site" session={pageSession} camera={false} initial={{ page: 'p1' }} />
        </PhoneFrame>
        <PhoneFrame id="scanner-fix" label={tr('Fix corners')}>
          <ScannerScreen mode="site" session={fixSession} camera={false} initial={{ page: 'p2', fix: true }} />
        </PhoneFrame>
      </div>
      <p data-testid="scanner-calls" className="font-mono text-[12px] text-ink-2">{calls.length ? calls.join(' · ') : tr('Nothing asked yet')}</p>
      <div><Button variant="primary" onClick={() => setFull(true)} data-testid="open-scanner"><IconScan className="size-[18px]" />{tr('Open the scanner full screen')}</Button></div>
      <Window full open={full} onOpenChange={setFull} title={tr('Scanner')}>
        {fullSession && <ScannerScreen mode="site" session={fullSession} onDone={p => { setFull(false); done(p.length); }} />}
      </Window>
    </section>
  );
}
