// The worker's documents (docs/contracts.md → Signing, D3): a card on the punch screen —
// Documents to sign, or My documents once signed — and their sheet: Form 101 and the contract
// filled with the worker's data, to scroll through, the signing date shown fixed, one signature
// (SignDocuments); after signing, the two signed documents to read and download.
import * as React from 'react';
import { IconAlertTriangle, IconBuildingSkyscraper, IconFileText, IconRefresh, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { SignDocuments } from '@/components/shared/sign-documents';
import type { PdfDoc } from '@/components/shared/pdf-pages';
import { set, usePunch } from './core';
import { buildSigned, buildTransfer, declineTransfer, openPdf, signDocs, signTransfer, viewBoth, viewTransfer, type Viewed } from './sign';
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
        : r.status === 'signing' ? (notSaved(r) ? tr('Your documents could not be saved') : tr('Saving your documents…')) : tr('Signed {0}', { 0: r.signDate || '' })}</span>
    </button>
  );
}

/** Nothing is saved yet and nothing is on its way: a recorded failure, a call that failed, or too long a wait. */
const notSaved = (r: { buildError?: string | null; stuck?: boolean; retry?: boolean }) => !!(r.buildError || r.stuck || r.retry);

/** A signature kept whose documents are not saved: what happened, and Try again (built only from what was signed). */
function NotSaved({ failed, text, retry }: { failed: boolean; text: string; retry: () => Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  if (!failed) return <p style={{ color: 'var(--text2)', fontSize: 14 }} data-testid="documents-saving">{tr('Saving your documents…')}</p>;
  return (
    <div className="grid gap-2" data-testid="documents-not-saved">
      <p style={{ color: 'var(--red)', fontSize: 14 }}><IconAlertTriangle className="ti" /> {text}</p>
      <button type="button" className="gbtn" disabled={busy} data-testid="documents-retry"
        onClick={() => { setBusy(true); void retry().finally(() => setBusy(false)); }}><IconRefresh className="ti" /> {tr('Try again')}</button>
    </div>
  );
}

export function DocumentsSheet({ hidden }: { hidden: boolean }) {
  const s = usePunch();
  const r = s.signReq;
  const [views, setViews] = React.useState<Viewed[] | null>(null);
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    if (hidden || !r || r.status === 'signing') return; // nothing to show yet: no signed document exists
    let live = true;
    setViews(null); setErr('');
    viewBoth().then(v => { if (live) setViews(v); }, e => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [hidden, r?.id, r?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs: PdfDoc[] = [
    { key: 'form101', title: tr('Form 101'), b64: views ? views[0].pdfBase64 : null, error: err ? tr(err) : undefined },
    { key: 'contract', title: r?.templateName || tr('Contract'), b64: views ? views[1].pdfBase64 : null, error: err ? tr(err) : undefined },
  ];
  return (
    <Sheet id="screenDocuments" hidden={hidden} icon={<IconSignature className="ti" />} title={r?.status === 'sent' ? tr('Documents to sign') : tr('My documents')}>
      <div id="documentsContent" data-testid="documents" data-state={r?.status || ''} style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
        {!r ? null : r.status === 'sent' ? (
          <SignDocuments docs={docs} signDate={views?.[0]?.signDate || r.signDate || '…'}
            onSign={async png => { try { await signDocs(png); setViews(null); } catch (e) { setErr(String((e as Error)?.message || e)); } }} />
        ) : r.status === 'signing' ? <NotSaved failed={notSaved(r)} retry={buildSigned}
          text={tr('Your signature is kept, but your documents could not be saved. The office can withdraw them and send them to you to sign again.')} /> : (
          <div className="grid gap-2" data-testid="documents-signed">
            <p style={{ color: 'var(--text2)', fontSize: 14 }}>{tr('Signed {0}', { 0: r.signDate || '' })}</p>
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
      <span className="pp-tile-v">{t.status === 'signing' ? (notSaved(t) ? tr('Your documents could not be saved') : tr('Saving your documents…')) : tr('Read its Form 101 and contract, then approve with your signature')}</span>
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
  const [busy, setBusy] = React.useState(false);
  // a retry that finished the move ends here too, with what it did, never an empty sheet
  const was = React.useRef(t);
  React.useEffect(() => {
    if (was.current?.status === 'signing' && !t && !busy) setDone(tr('Signed — your details were sent to {0}.', { 0: was.current.firm }));
    was.current = t;
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (hidden || !t || t.status === 'signing') return;
    let live = true;
    setViews(null); setErr('');
    viewTransfer().then(v => { if (live) setViews(v); }, e => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [hidden, t?.id, t?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const docs: PdfDoc[] = [
    { key: 'form101', title: tr('Form 101'), b64: views ? views[0].pdfBase64 : null, error: err ? tr(err) : undefined },
    { key: 'contract', title: tr('Contract'), b64: views ? views[1].pdfBase64 : null, error: err ? tr(err) : undefined },
  ];
  return (
    <Sheet id="screenTransfer" hidden={hidden} icon={<IconBuildingSkyscraper className="ti" />} title={t ? tr('{0} asks to take your details', { 0: t.firm }) : tr('Done')}>
      <div data-testid="transfer" data-state={done ? 'done' : t ? t.status : ''} style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
        {done ? <p style={{ color: 'var(--text2)', fontSize: 15 }} data-testid="transfer-done">{done}</p> : t && <>
          <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 12 }}>{tr('Your details are copied to {0} only if you sign. Nothing is copied if you decline.', { 0: t.firm })}</p>
          {t.status === 'signing' ? <NotSaved failed={notSaved(t)} retry={buildTransfer}
            text={tr('Your signature is kept, but your documents could not be saved. Try again, or decline: nothing has been copied, and the new firm can ask again.')} />
            : <SignDocuments docs={docs} signDate={views?.[0]?.signDate || '…'}
              onSign={async png => {
                const firm = t.firm;
                setBusy(true); setErr('');
                try { if (await signTransfer(png)) setDone(tr('Signed — your details were sent to {0}.', { 0: firm })); }
                catch (e) { setErr(String((e as Error)?.message || e)); }
                finally { setBusy(false); }
              }} />}
          {err && t.status === 'signing' && <p style={{ color: 'var(--red)', fontSize: 14 }} data-testid="transfer-error">{tr(err)}</p>}
          <button type="button" className="gbtn" data-testid="transfer-decline" style={{ marginTop: 12 }} disabled={busy}
            onClick={() => {
              setBusy(true); setErr('');
              void declineTransfer().then(() => setDone(tr('Declined — nothing was copied.')), e => setErr(String(e?.message || e))).finally(() => setBusy(false));
            }}>{tr('Decline')}</button>
        </>}
      </div>
    </Sheet>
  );
}
