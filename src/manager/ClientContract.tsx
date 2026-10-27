// The client window's Contract section (docs/clients.md → Client window; docs/contracts.md → Client contracts):
// the client's contract template (its own first, then the firm's client templates; empty = the firm's default
// client template), "A contract for this client only" (the upload window with the client), the status of its
// latest send (Sent to sign / Signed <date> / Needs sending again) and, for a login that may send client contracts
// (canFirmSign): Send to sign — the link with Send on WhatsApp (to the client's contact phone) and Copy — and Sign
// here (the client signs in this window: ClientSignFlow), and the firm's signature and stamp. The values come from
// the window's live form (clientContractValues): what the client pays only for a login that sees client billing.
// The signed contracts are listed (a tap opens the PDF); a signing's details fill the client's EMPTY contact fields
// (never what the firm typed), then the request is marked taken on (clientApplied).
import * as React from 'react';
import { IconBrandWhatsapp, IconClipboardText, IconFileCheck, IconLoader2, IconRubberStamp, IconSend, IconSignature, IconUpload } from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Window } from '@/components/shared/window';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { ClientSignFlow, type ClientSignCall } from '@/client-sign/ClientSignFlow';
import type { ClientRecord, ManagerBridge } from './bridge';
import { TEMPLATE_ACCEPT, defaultFor, listTemplates, type ContractTemplate } from './contracts';
import { UploadWindow } from './ContractTemplates';
import { FirmSealWindow } from './FirmSeal';
import { canFirmSign, canSeeBilling } from './logic/access';
import { clientContractValues } from './logic/contract-values';
import {
  clientCall, clientWhatsapp, detailsOf, latestRequest, takeOnPatch, toTakeOn, type ClientDetails, type ClientSignRequest,
} from './logic/client-contract';
import { loadFirestoreBackend } from './data/api';

const DEFAULT = '-';
const dateText = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(uiLocale()) : '');

/** The status line of the client's latest send. */
export function clientContractStatus(r: ClientSignRequest | null): { text: string; state: string } {
  if (!r) return { text: '', state: 'none' };
  if (r.status === 'signed' || r.status === 'signing') return { text: tr('Signed {0}', { 0: r.signDate || dateText(r.signedAtIso) }), state: 'signed' };
  if (r.status === 'sent') return { text: tr('Sent to sign {0}', { 0: dateText(r.sentAt) }), state: 'sent' };
  return { text: tr('Needs sending again'), state: 'withdrawn' };
}

export function ClientContractSection({ clientId, record, contractTemplateId, setTemplate, takeOn, api, opened }: {
  clientId: string | null;
  /** the client as the window has it now (the live form and billing) */
  record: () => ClientRecord;
  contractTemplateId: string;
  setTemplate: (id: string) => void;
  /** a signing's details onto the client's empty contact fields */
  takeOn: (patch: Partial<ClientDetails>) => void;
  api: ManagerBridge;
  opened: boolean;
}) {
  const [list, setList] = React.useState<ContractTemplate[] | null>(null);
  const [reqs, setReqs] = React.useState<ClientSignRequest[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [sent, setSent] = React.useState<{ link: string; wa: string } | null>(null);
  const [here, setHere] = React.useState<{ id: string; details: Required<ClientDetails>; title: string } | null>(null);
  const [upload, setUpload] = React.useState<File | null>(null);
  const [seal, setSeal] = React.useState(false);
  const pick = React.useRef<HTMLInputElement>(null);
  const may = canFirmSign();

  const loadTemplates = React.useCallback(() => {
    if (!clientId) return;
    listTemplates(undefined, { clientId, kind: 'client' }).then(r => setList(r.templates), () => setList([]));
  }, [clientId]);
  const loadReqs = React.useCallback(() => {
    if (!clientId) return;
    clientCall<{ requests: ClientSignRequest[] }>({ action: 'clientList', clientId }).then(r => setReqs(r.requests || []), () => setReqs([]));
  }, [clientId]);
  React.useEffect(() => { if (opened && list === null) loadTemplates(); }, [opened, list, loadTemplates]);
  React.useEffect(() => { if (opened && reqs === null) loadReqs(); }, [opened, reqs, loadReqs]);
  // a signing's details: the client's empty contact fields filled from them, once
  React.useEffect(() => {
    for (const r of toTakeOn(reqs || [])) {
      const patch = takeOnPatch(record() as Record<string, unknown>, r.clientDetails);
      if (Object.keys(patch).length) takeOn(patch);
      r.appliedAt = new Date().toISOString();
      void clientCall({ action: 'clientApplied', id: r.id }).catch(() => {});
    }
  }, [reqs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!clientId) return <p className="text-sm text-ink-2" data-testid="client-contract" data-state="new">{tr('Save the client first')}</p>;

  const own = (list || []).filter(t => t.clientId === clientId);
  const firm = (list || []).filter(t => !t.clientId);
  const def = defaultFor(list || [], '', 'client') || firm.find(t => t.isDefault) || firm[0] || null;
  const chosen = (list || []).find(t => t.id === contractTemplateId);
  const tpl = chosen || def;
  const latest = latestRequest(reqs || []);
  const status = clientContractStatus(latest);
  const signed = (reqs || []).filter(r => r.part);

  const send = async (way: 'remote' | 'person') => {
    if (!tpl || busy) return;
    setBusy(true); setErr('');
    try {
      const rec = record();
      const values = clientContractValues(rec, { profile: await api.firmProfile(), seeBilling: canSeeBilling() });
      const details = detailsOf(rec);
      const r = await clientCall<{ id: string; request: ClientSignRequest; link?: string }>({ action: 'clientSend', clientId, templateId: tpl.id, way,
        values, details, origin: location.origin });
      setReqs(cur => [r.request, ...(cur || []).map(x => (x.status === 'sent' ? { ...x, status: 'replaced' as const } : x))]);
      if (way === 'remote' && r.link) {
        setSent({ link: r.link, wa: clientWhatsapp(rec.contactPhone, String(rec.name || ''), r.link,
          tr('You have a contract to sign. Open the link, check your details, read the contract and sign at the bottom.')) });
      } else setHere({ id: r.id, details, title: tpl.name });
    } catch (e: any) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const call = (id: string): ClientSignCall => (action, body) =>
    clientCall({ action: 'client' + action[0].toUpperCase() + action.slice(1), id, ...body }) as any;
  const copy = () => { if (sent) navigator.clipboard?.writeText(sent.link).then(() => api.toast(tr('Link copied!')), () => {}); };
  const openSigned = async (r: ClientSignRequest) => {
    try { window.open(await (await loadFirestoreBackend()).storageUrl(r.part!.path), '_blank', 'noopener'); }
    catch (e: any) { api.toast(tr(String(e?.message || e))); }
  };
  const label = (t: ContractTemplate) => t.name + (t.clientId ? ' · ' + tr('this client only') : '');

  return (
    <div className="grid gap-2.5" data-testid="client-contract" data-state={status.state}>
      <div className="grid min-w-0 gap-1.5">
        <Label>{tr('Contract template')}</Label>
        <Select value={contractTemplateId || DEFAULT} onValueChange={v => setTemplate(v === DEFAULT ? '' : v)}>
          <SelectTrigger id="cContractTemplate" data-testid="client-contract-template"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>{def ? tr('The default: {0}', { 0: def.name }) : tr('The default client template')}</SelectItem>
            {[...own, ...firm].map(t => <SelectItem key={t.id} value={t.id}>{label(t)}</SelectItem>)}
            {contractTemplateId && !chosen && list && <SelectItem value={contractTemplateId}>{tr('A deleted template')}</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      {list && !tpl && <p className="text-[11px] text-warn" data-testid="client-contract-none">{tr('No client contract template yet — add one in Admin → Contract templates (For clients), or a contract for this client only.')}</p>}
      {status.text && <p className="text-sm" data-testid="client-contract-status" data-state={status.state}>{status.text}</p>}
      {err && <p className="text-sm text-bad" data-testid="client-contract-error">{tr(err)}</p>}
      {may && <>
        {!canSeeBilling() && <p className="text-[11px] text-ink-3" data-testid="client-contract-nobill">{tr('Billing is not filled in: this login does not see client billing.')}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" data-testid="client-contract-send" disabled={!tpl || busy} onClick={() => send('remote')}>
            {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{tr('Send to sign')}</Button>
          <Button size="sm" data-testid="client-contract-here" disabled={!tpl || busy} onClick={() => send('person')}><IconSignature className="size-4" />{tr('Sign here')}</Button>
        </div>
        {sent && <div className="grid gap-2" data-testid="client-contract-sent">
          <p className="text-sm">{tr('Sent to sign. Send the client this link:')}</p>
          <code className="break-all rounded-[12px] bg-white/[.05] px-3 py-2 text-[11px] text-[var(--blue-text)]" data-testid="client-contract-link">{sent.link}</code>
          <div className="flex flex-wrap gap-2">
            {sent.wa ? <Button asChild variant="primary" size="sm"><a href={sent.wa} target="_blank" rel="noopener noreferrer" data-testid="client-contract-whatsapp"><IconBrandWhatsapp className="size-4" />{tr('Send on WhatsApp')}</a></Button>
              : <span className="text-[11px] text-warn">{tr('No contact phone — add it above to send on WhatsApp.')}</span>}
            <Button size="sm" data-testid="client-contract-copy" onClick={copy}><IconClipboardText className="size-4" />{tr('Copy')}</Button>
          </div>
        </div>}
      </>}
      {signed.length > 0 && <>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">{tr('Signed contracts')}</p>
        <PagedList items={signed} render={r => (
          <Plate key={r.id} data-testid="client-contract-signed" data-id={r.id} className="mb-1.5" color="var(--ok)" icon={<IconFileCheck />}
            title={r.part!.name} sub={tr('Signed {0}', { 0: r.signDate || dateText(r.signedAtIso) })} onOpen={() => void openSigned(r)} />
        )} />
      </>}
      <div className="flex flex-wrap gap-2">
        {may && <>
          <input ref={pick} type="file" accept={TEMPLATE_ACCEPT} className="hidden" data-testid="client-contract-file"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setUpload(f); }} />
          <Button size="sm" data-testid="client-contract-upload" onClick={() => pick.current?.click()}><IconUpload className="size-4" />{tr('A contract for this client only')}</Button>
          <Button size="sm" data-testid="client-contract-seal" onClick={() => setSeal(true)}><IconRubberStamp className="size-4" />{tr("Firm's signature and stamp")}</Button>
        </>}
      </div>
      {seal && <FirmSealWindow toast={api.toast} onClose={() => setSeal(false)} />}
      {upload && <UploadWindow file={upload} categories={[]} api={{ toast: api.toast }} clientId={clientId} kind="client"
        onClose={() => setUpload(null)} onSaved={t => { setUpload(null); setTemplate(t.id); loadTemplates(); }} />}
      {here && <Window open wide onOpenChange={o => { if (!o) { setHere(null); loadReqs(); } }} title={tr('Contract to sign')} description={String(record().name || '')}>
        <div className="px-1 pb-2" data-testid="client-contract-here-window">
          <ClientSignFlow call={call(here.id)} details={here.details} title={here.title}
            onSigned={() => { api.toast(tr('Signed — the contract is saved on the client')); setHere(null); loadReqs(); }} />
        </div>
      </Window>}
    </div>
  );
}
