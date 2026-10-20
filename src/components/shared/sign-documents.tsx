// SignDocuments (docs/components.md; docs/contracts.md → Signing): Form 101 and the contract one
// under the other (PdfPages), to scroll through; the signing date shown fixed — the signer never
// changes it; one signature (SignaturePad) that opens only after the end of both was seen; Sign.
// The worker's punch page and the manager's sign window (in person) draw the same.
import * as React from 'react';
import { IconLoader2, IconLock, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { PdfPages, type PdfDoc } from './pdf-pages';
import { SignaturePad, type SignaturePadHandle } from './signature-pad';

export function SignDocuments({ docs, signDate, onSign, className }: {
  docs: PdfDoc[]; signDate: string; onSign: (png: string) => Promise<void>; className?: string;
}) {
  const [seen, setSeen] = React.useState(false);
  const [ink, setInk] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const pad = React.useRef<SignaturePadHandle>(null);
  const onEnd = React.useCallback(() => setSeen(true), []);
  const sign = async () => {
    const png = pad.current?.image();
    if (!png || busy) return;
    setBusy(true);
    try { await onSign(png); } finally { setBusy(false); }
  };
  return (
    <div className={cn('grid gap-4', className)} data-testid="sign-documents" data-seen={seen ? '1' : '0'}>
      <PdfPages docs={docs} onEnd={onEnd} />
      <div className="grid gap-2 rounded-[12px] border border-white/12 p-3">
        <p className="text-sm" data-testid="sign-date">{tr('Signing date: {0}', { 0: signDate })}</p>
        {!seen ? <p className="inline-flex items-center gap-1.5 text-sm text-ink-2" data-testid="sign-locked"><IconLock className="size-4" />{tr('Scroll to the end of both documents to sign')}</p> : <>
          <p className="text-[11px] text-ink-2">{tr('One signature for both documents')}</p>
          <SignaturePad ref={pad} onInk={setInk} className="max-w-[420px]" />
          <Button variant="primary" className="justify-self-start" data-testid="sign-button" disabled={!ink || busy} onClick={sign}>
            {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconSignature className="size-4" />}{tr('Sign')}
          </Button>
        </>}
      </div>
    </div>
  );
}
