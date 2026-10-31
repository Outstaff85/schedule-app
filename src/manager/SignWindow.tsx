// Documents to sign (docs/contracts.md → Signing, D3): from the worker window's Contract section.
// The contract template (the worker's own pick, else its category's default), the signing date
// (only for a login with the right "Set the signing date"; else the day of signing), and one of
// two ways: Send to sign — the documents wait in the worker's own page (the punch link, offered
// for WhatsApp) — or Sign here, on this phone: both documents filled, one signature. The two
// signed PDFs are built on the server by two calls at once, in the background.
import * as React from 'react';
import { IconBrandWhatsapp, IconClipboardText, IconLoader2, IconSend, IconSignature } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { storedLanguage } from './logic/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FieldRow } from '@/components/ui/form';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Window } from '@/components/shared/window';
import { SignDocuments } from '@/components/shared/sign-documents';
import type { PdfDoc } from '@/components/shared/pdf-pages';
import type { ManagerBridge, SignContext } from './bridge';
import { defaultFor, listTemplates, type ContractTemplate } from './contracts';
import { rememberRequest, signCall, type SignRequest } from './logic/signing';
import { printHash } from './logic/contract-values';

// A notice's Sign (D4): the worker card opens with this window.
let pending: string | null = null;
export function askSign(workerId: string): void { pending = workerId; }
export function takeSign(workerId: string): boolean { if (pending !== workerId) return false; pending = null; return true; }

const ymdToDmy = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

/** Builds the two signed PDFs (two calls at once) and then lets the app take them onto the worker. */
export function buildSigned(id: string, api: { reloadSignRequests: () => Promise<void>; toast: (m: string, ms?: number) => void }): void {
  void Promise.all(['form101', 'contract'].map(which => signCall({ action: 'build', id, which })))
    .then(() => api.reloadSignRequests())
    .catch(e => { api.toast(tr('The signed documents could not be built: {0}', { 0: tr(String(e?.message || e)) }), 6000); void api.reloadSignRequests(); });
}

export function SignWindow({ workerId, api, onClose }: { workerId: string; api: ManagerBridge; onClose: () => void }) {
  const [ctx, setCtx] = React.useState<SignContext | null>(null);
  const [list, setList] = React.useState<ContractTemplate[] | null>(null);
  const [tid, setTid] = React.useState('');
  const [date, setDate] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState<SignRequest | null>(null);
  const [docs, setDocs] = React.useState<PdfDoc[] | null>(null);
  const [signDate, setSignDate] = React.useState('');
  // the language the documents were shown in is the language they are signed in: the attached ID sheet's, frozen at `sign`
  const viewLang = React.useRef('');
  React.useEffect(() => {
    let live = true;
    Promise.all([api.signContext(workerId), listTemplates(workerId)]).then(([c, l]) => {
      if (!live) return;
      setCtx(c); setList(l.templates);
      const w = c?.worker;
      const own = w?.contractTemplateId && l.templates.find(t => t.id === w.contractTemplateId);
      const def = own || defaultFor(l.templates, w?.contractCategory) || l.templates.find(t => !t.workerId) || null;
      setTid(def ? def.id : '');
    }, e => live && setErr(String(e?.message || e)));
    return () => { live = false; };
  }, [workerId, api]);

  const send = async (way: 'remote' | 'person') => {
    if (!ctx || !tid || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await signCall<{ id: string; request: SignRequest }>({ action: 'send', workerId, templateId: tid, way,
        values: ctx.values, form101: ctx.form101, ...(date ? { signDate: ymdToDmy(date) } : {}),
        printHash: printHash(ctx.form101, ctx.values, list?.find(t => t.id === tid)?.marks || null, ctx.canSeePay), printPay: ctx.canSeePay });
      rememberRequest({ ...r.request, id: r.id });
      if (way === 'remote') { setSent({ ...r.request, id: r.id }); return; }
      // in person: both documents filled, on this phone
      const name = list?.find(t => t.id === tid)?.name || tr('Contract');
      setDocs([{ key: 'form101', title: tr('Form 101'), b64: null }, { key: 'contract', title: name, b64: null }]);
      viewLang.current = storedLanguage();
      const views = await Promise.all(['form101', 'contract'].map(which => signCall<{ pdfBase64: string; signDate: string }>({ action: 'view', id: r.id, which, lang: viewLang.current })));
      setSignDate(views[0].signDate);
      setDocs([{ key: 'form101', title: tr('Form 101'), b64: views[0].pdfBase64 }, { key: 'contract', title: name, b64: views[1].pdfBase64 }]);
      setSent({ ...r.request, id: r.id });
    } catch (e: any) { setErr(String(e?.message || e)); setDocs(null); }
    finally { setBusy(false); }
  };
  const signHere = async (png: string) => {
    if (!sent) return;
    try {
      const r = await signCall<{ signDate?: string }>({ action: 'sign', id: sent.id, signaturePng: png, lang: viewLang.current || storedLanguage() });
      // signed now: the card says the documents are being saved (they are built in the background), Signed once they are
      rememberRequest({ ...sent, status: 'signing', signedAtIso: new Date().toISOString(), signDate: r.signDate || signDate || sent.signDate || null });
      api.toast(tr('Signed — the documents are being saved'));
      buildSigned(sent.id, api);
      onClose();
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  const firm = (list || []).filter(t => !t.workerId), own = (list || []).filter(t => t.workerId);
  const copy = () => { if (ctx?.punchLink) navigator.clipboard?.writeText(ctx.punchLink).then(() => api.toast(tr('Link copied!')), () => {}); };

  return (
    <Window open wide onOpenChange={o => { if (!o) onClose(); }} title={tr('Documents to sign')} description={ctx?.worker.name}>
      <div className="grid gap-3 px-1 pb-2" data-testid="sign-window" data-state={docs ? 'person' : sent ? 'sent' : ctx ? 'ready' : 'busy'}>
        {!ctx && !err && <p className="inline-flex items-center gap-2 text-sm text-ink-2"><IconLoader2 className="size-4 animate-spin" />{tr('Loading…')}</p>}
        {err && <p className="text-sm text-bad" data-testid="sign-error">{tr(err)}</p>}
        {ctx && !sent && !docs && <>
          <FieldRow>
            <div className="grid min-w-0 gap-1.5">
              <Label>{tr('Contract template')}</Label>
              <Select value={tid} onValueChange={setTid}>
                <SelectTrigger data-testid="sign-template"><SelectValue placeholder={tr('No contract templates yet')} /></SelectTrigger>
                <SelectContent>{[...own, ...firm].map(t => <SelectItem key={t.id} value={t.id}>{t.name + (t.isDefault ? ' · ' + tr('Default') : '')}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>{tr('Signing date')}</Label>
              {ctx.canSetDate ? <DatePicker value={date} onChange={v => setDate(v || '')} placeholder={tr('The day of signing')} id="signDate" />
                : <p className="py-2 text-sm text-ink-2" data-testid="sign-date-fixed">{tr('The day of signing')}</p>}
            </div>
          </FieldRow>
          {!ctx.canSeePay && <p className="text-[11px] text-ink-3">{tr('Pay is not filled in: this login does not see pay.')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" data-testid="sign-send" disabled={!tid || busy || !ctx.punchLink} onClick={() => send('remote')}>
              {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{tr('Send to sign')}</Button>
            <Button data-testid="sign-person" disabled={!tid || busy} onClick={() => send('person')}><IconSignature className="size-4" />{tr('Sign here')}</Button>
          </div>
          {!ctx.punchLink && <p className="text-[11px] text-warn">{tr('The worker has no punch link yet — create one in Access.')}</p>}
        </>}
        {sent && !docs && <div className="grid gap-2" data-testid="sign-sent">
          <p className="text-sm">{tr('Sent to sign. The documents are waiting in the worker\'s own page:')}</p>
          <code className="break-all rounded-[12px] bg-white/[.05] px-3 py-2 text-[11px] text-[var(--blue-text)]">{ctx?.punchLink}</code>
          <div className="flex flex-wrap gap-2">
            {ctx?.whatsapp && <Button asChild variant="primary"><a href={ctx.whatsapp} target="_blank" rel="noopener noreferrer" data-testid="sign-whatsapp"><IconBrandWhatsapp className="size-4" />{tr('Send on WhatsApp')}</a></Button>}
            <Button onClick={copy}><IconClipboardText className="size-4" />{tr('Copy')}</Button>
          </div>
        </div>}
        {docs && <SignDocuments docs={docs} signDate={signDate || '…'} onSign={signHere} />}
      </div>
    </Window>
  );
}
