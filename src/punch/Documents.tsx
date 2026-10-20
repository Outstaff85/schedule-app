// The worker's documents (docs/contracts.md → Signing, D3): a card on the punch screen —
// Documents to sign, or My documents once signed — and their sheet: Form 101 and the contract
// filled with the worker's data, to scroll through, the signing date shown fixed, one signature
// (SignDocuments); after signing, the two signed documents to read and download.
import * as React from 'react';
import { IconFileText, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { SignDocuments } from '@/components/shared/sign-documents';
import type { PdfDoc } from '@/components/shared/pdf-pages';
import { set, usePunch } from './core';
import { openPdf, signDocs, viewBoth, type Viewed } from './sign';
import { Sheet } from './Sheets';

/** The card above the tiles: documents wait for a signature, or were signed. */
export function DocumentsCard() {
  const s = usePunch();
  const r = s.signReq;
  if (!r) return null;
  const sent = r.status === 'sent';
  return (
    <button type="button" className="gbtn pp-tile" data-testid="tile-documents" data-state={r.status}
      style={{ ['--c' as string]: sent ? 'var(--warn)' : 'var(--green)', width: '100%', maxWidth: 500, marginBottom: 12 }}
      onClick={() => set({ screen: 'documents' })}>
      <span className="pp-tile-h">{sent ? <IconSignature className="ti" /> : <IconFileText className="ti" />} <span>{sent ? tr('Documents to sign') : tr('My documents')}</span></span>
      <span className="pp-tile-v">{sent ? tr('Form 101 and {0} — tap to read and sign', { 0: r.templateName || tr('the contract') })
        : r.status === 'signing' ? tr('Signed — being saved…') : tr('Signed {0}', { 0: r.signDate || '' })}</span>
    </button>
  );
}

export function DocumentsSheet({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  const r = s.signReq;
  const [views, setViews] = React.useState<Viewed[] | null>(null);
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    if (hidden || !r) return;
    let live = true;
    setViews(null); setErr('');
    viewBoth().then(v => { if (live) setViews(v); }, e => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [hidden, r?.id, r?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs: PdfDoc[] = [
    { key: 'form101', title: tr('Form 101'), b64: views ? views[0].pdfBase64 : null, error: err || undefined },
    { key: 'contract', title: r?.templateName || tr('Contract'), b64: views ? views[1].pdfBase64 : null, error: err || undefined },
  ];
  return (
    <Sheet id="screenDocuments" hidden={hidden} icon={<IconSignature className="ti" />} title={r?.status === 'sent' ? tr('Documents to sign') : tr('My documents')}>
      <div id="documentsContent" data-testid="documents" data-state={r?.status || ''} style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
        {!r ? null : r.status === 'sent' ? (
          <SignDocuments docs={docs} signDate={views?.[0]?.signDate || r.signDate || '…'}
            onSign={async png => { await signDocs(png); setViews(null); }} />
        ) : (
          <div className="grid gap-2" data-testid="documents-signed">
            <p style={{ color: 'var(--text2)', fontSize: 14 }}>{r.status === 'signing' ? tr('Signed — being saved…') : tr('Signed {0}', { 0: r.signDate || '' })}</p>
            {views && views.map((v, i) => (
              <button key={i} type="button" className="gbtn pp-tile" data-testid="documents-open" style={{ ['--c' as string]: 'var(--green)' }}
                onClick={() => openPdf(v.pdfBase64, v.name || 'document.pdf')}>
                <span className="pp-tile-h"><IconFileText className="ti" /> <span>{i === 0 ? tr('Form 101') : r.templateName || tr('Contract')}</span></span>
                <span className="pp-tile-v">{tr('Open')}</span>
              </button>
            ))}
            {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
          </div>
        )}
      </div>
    </Sheet>
  );
}
