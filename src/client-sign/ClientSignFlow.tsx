// A client signs its contract (docs/contracts.md → Client contracts): its details first — prefilled with what
// the firm has, editable —, then the contract filled with them and the firm's signature and stamp (SignDocuments
// with one document: the signature opens once its end was seen), then one signature: the server keeps it and
// builds the signed PDF once; "Download the contract" opens it. The client's own page (/client-sign, the link's
// token) and Sign here in the client window (the manager's phone) draw the same; `call` reaches the server:
// view / sign / build with the details, nothing else.
import * as React from 'react';
import { IconArrowLeft, IconCircleCheck, IconDownload, IconFileText, IconLoader2 } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldRow } from '@/components/ui/form';
import { SignDocuments } from '@/components/shared/sign-documents';
import type { PdfDoc } from '@/components/shared/pdf-pages';

export type ClientSignDetails = {
  name: string; companyNumber: string; address: string; contactPhone: string; email: string; signerName: string; signerRole: string;
};
/** The server's view / sign / build for this one request. */
export type ClientSignCall = <T = Record<string, unknown>>(action: 'view' | 'sign' | 'build', body: Record<string, unknown>) => Promise<T>;
type Viewed = { pdfBase64: string; name: string; signDate?: string; signed?: boolean };

const EMPTY: ClientSignDetails = { name: '', companyNumber: '', address: '', contactPhone: '', email: '', signerName: '', signerRole: '' };

/** A PDF in base64 opened in a new tab (or saved, when the browser blocks the tab). */
export function openPdfB64(b64: string, name: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'application/pdf' }));
  const win = window.open(url, '_blank', 'noopener');
  if (!win) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function Field({ id, label, value, onChange, type, dir }: { id: string; label: string; value: string; onChange: (v: string) => void; type?: string; dir?: string }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} dir={dir || 'auto'} maxLength={120} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

export function ClientSignFlow({ call, details, title, signed, onSigned }: {
  call: ClientSignCall;
  /** the prefill: what the firm has (or, once signed, the details as signed) */
  details: Partial<ClientSignDetails>;
  /** the contract's name, above it */
  title: string;
  /** already signed: only the download */
  signed?: boolean;
  /** after the signed PDF was built */
  onSigned?: () => void;
}) {
  const [d, setD] = React.useState<ClientSignDetails>(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(details).map(([k, v]) => [k, String(v ?? '')])) }));
  const [step, setStep] = React.useState<'details' | 'read' | 'done'>(signed ? 'done' : 'details');
  const [docs, setDocs] = React.useState<PdfDoc[] | null>(null);
  const [signDate, setSignDate] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof ClientSignDetails) => (v: string) => setD(cur => ({ ...cur, [k]: v }));

  const show = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    setDocs([{ key: 'contract', title, b64: null }]); setStep('read');
    try {
      const v = await call<Viewed>('view', { details: d });
      setSignDate(v.signDate || '');
      setDocs([{ key: 'contract', title, b64: v.pdfBase64 }]);
    } catch (e: any) { setErr(String(e?.message || e)); setStep('details'); setDocs(null); }
    finally { setBusy(false); }
  };
  const sign = async (png: string) => {
    setErr('');
    try {
      await call('sign', { signaturePng: png, details: d });
      await call('build', {});
      setStep('done');
      onSigned?.();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  const download = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try { const v = await call<Viewed>('view', {}); openPdfB64(v.pdfBase64, v.name || title + '.pdf'); }
    catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid gap-3" data-testid="client-sign-flow" data-step={step}>
      {err && <p className="text-sm text-bad" data-testid="client-sign-error">{tr(err)}</p>}
      {step === 'details' && <div className="grid gap-2.5" data-testid="client-sign-details">
        <p className="og-label">{tr('Your details')}</p>
        <p className="text-[13px] text-ink-2">{tr('Check your details: they are printed in the contract.')}</p>
        <FieldRow>
          <Field id="csName" label={tr('Name')} value={d.name} onChange={set('name')} />
          <Field id="csCompanyNo" label={tr('Company no.')} value={d.companyNumber} onChange={set('companyNumber')} dir="ltr" />
        </FieldRow>
        <Field id="csAddress" label={tr('Address')} value={d.address} onChange={set('address')} />
        <FieldRow>
          <Field id="csPhone" label={tr('Phone')} value={d.contactPhone} onChange={set('contactPhone')} type="tel" dir="ltr" />
          <Field id="csEmail" label={tr('Email')} value={d.email} onChange={set('email')} type="email" dir="ltr" />
        </FieldRow>
        <FieldRow>
          <Field id="csSigner" label={tr("Signer's name")} value={d.signerName} onChange={set('signerName')} />
          <Field id="csSignerRole" label={tr("Signer's role")} value={d.signerRole} onChange={set('signerRole')} />
        </FieldRow>
        <Button variant="primary" className="justify-self-start" data-testid="client-sign-show" disabled={busy} onClick={show}>
          {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconFileText className="size-4" />}{tr('Show the contract')}</Button>
      </div>}
      {step === 'read' && docs && <>
        <Button size="sm" className="justify-self-start" data-testid="client-sign-back" onClick={() => { setStep('details'); setDocs(null); }}>
          <IconArrowLeft className="size-4" />{tr('Back to the details')}</Button>
        <SignDocuments docs={docs} signDate={signDate || '…'} onSign={sign} />
      </>}
      {step === 'done' && <div className="grid gap-2" data-testid="client-sign-done">
        <p className="inline-flex items-center gap-2 text-sm text-ok"><IconCircleCheck className="size-5" />{tr('Signed. Download the contract')}</p>
        <Button variant="primary" className="justify-self-start" data-testid="client-sign-download" disabled={busy} onClick={download}>
          {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconDownload className="size-4" />}{tr('Download the contract')}</Button>
      </div>}
    </div>
  );
}
