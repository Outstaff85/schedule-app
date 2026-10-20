// The worker's documents (docs/contracts.md → Signing, D3): a card on the punch screen —
// Documents to sign, or My documents once signed — and their sheet: Form 101 and the contract
// filled with the worker's data, to scroll through, the signing date shown fixed, one signature
// (SignDocuments); after signing, the two signed documents to read and download.
import * as React from 'react';
import { IconBuildingSkyscraper, IconFileText, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { SignDocuments } from '@/components/shared/sign-documents';
import type { PdfDoc } from '@/components/shared/pdf-pages';
import { set, usePunch } from './core';
import { declineTransfer, openPdf, signDocs, signTransfer, viewBoth, viewTransfer, type Viewed } from './sign';
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

/** Another firm asks to take the worker's details (D6): the card on the punch screen. */
export function TransferCard() {
  const s = usePunch();
  const t = s.transfer;
  if (!t) return null;
  return (
    <button type="button" className="gbtn pp-tile" data-testid="tile-transfer" style={{ ['--c' as string]: 'var(--accent)', width: '100%', maxWidth: 500, marginBottom: 12 }}
      onClick={() => set({ screen: 'transfer' })}>
      <span className="pp-tile-h"><IconBuildingSkyscraper className="ti" /> <span>{tr('{0} asks to take your details', { 0: t.firm })}</span></span>
      <span className="pp-tile-v">{tr('Read its Form 101 and contract, then approve with your signature')}</span>
    </button>
  );
}

/** Its sheet: the new firm's Form 101 and contract filled with the worker's data, one signature (the consent and the signing), or Decline. */
export function TransferSheet({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  const t = s.transfer;
  const [views, setViews] = React.useState<Viewed[] | null>(null);
  const [err, setErr] = React.useState('');
  const [done, setDone] = React.useState('');
  React.useEffect(() => {
    if (hidden || !t) return;
    let live = true;
    setViews(null); setErr('');
    viewTransfer().then(v => { if (live) setViews(v); }, e => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [hidden, t?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs: PdfDoc[] = [
    { key: 'form101', title: tr('Form 101'), b64: views ? views[0].pdfBase64 : null, error: err || undefined },
    { key: 'contract', title: tr('Contract'), b64: views ? views[1].pdfBase64 : null, error: err || undefined },
  ];
  return (
    <Sheet id="screenTransfer" hidden={hidden} icon={<IconBuildingSkyscraper className="ti" />} title={t ? tr('{0} asks to take your details', { 0: t.firm }) : tr('Done')}>
      <div data-testid="transfer" data-state={done ? 'done' : t ? t.status : ''} style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
        {done ? <p style={{ color: 'var(--text2)', fontSize: 15 }} data-testid="transfer-done">{done}</p> : t && <>
          <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 12 }}>{tr('Your details are copied to {0} only if you sign. Nothing is copied if you decline.', { 0: t.firm })}</p>
          <SignDocuments docs={docs} signDate={views?.[0]?.signDate || '…'}
            onSign={async png => { const firm = t.firm; await signTransfer(png); setDone(tr('Signed — your details were sent to {0}.', { 0: firm })); }} />
          <button type="button" className="gbtn" data-testid="transfer-decline" style={{ marginTop: 12 }}
            onClick={() => { void declineTransfer().then(() => setDone(tr('Declined — nothing was copied.'))); }}>{tr('Decline')}</button>
        </>}
      </div>
    </Sheet>
  );
}
