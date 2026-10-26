// Add a worker from another firm (docs/contracts.md → Moving to another firm, D6): the firm's admin
// types the worker's ID or passport number; the answer is always "Request sent" — the firm learns
// nothing until the worker approves in their own page, signing this firm's Form 101 and contract.
// A super-admin (who sees every firm anyway) picks the worker instead from a list with a search on
// top (by name or ID), five workers in view at a time, the rest by scrolling (owner, 2026-10-26); a
// firm's own admin never gets that list — another firm's workers stay hidden from it.
import * as React from 'react';
import { IconLoader2, IconSend } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Window } from '@/components/shared/window';
import { signCall } from './logic/signing';
import { fetchForTenant, loadFirmsCache } from './logic/admin';
import { API_URL } from './data/api';
import { fsTenantId, getSession, gsAuth } from './data/session';
import { workerDocId } from './worker';

/** The workers a super-admin may pick: every other firm's not-Inactive workers with an ID / passport number. */
export type TransferPick = ComboboxOption & { docNumber: string };
async function otherFirmsWorkers(): Promise<TransferPick[]> {
  const here = fsTenantId();
  let firms = loadFirmsCache();
  if (!firms) {
    const j = await (await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: 'listTenants', ...gsAuth() }) })).json();
    firms = (j && j.tenants) || [];
  }
  const others = (firms || []).filter(t => t && t.tenantId && t.tenantId !== here);
  const lists = await Promise.all(others.map(async t => {
    try {
      const d = await fetchForTenant('loadSchedule', t.tenantId);
      return ((d && d.workers) || []).filter((w: any) => w && w.status !== 'fired' && workerDocId(w)).map((w: any): TransferPick => {
        const docNumber = workerDocId(w);
        return { value: t.tenantId + '/' + w.id, label: String(w.name || docNumber), hint: [t.companyName || t.tenantId, docNumber].join(' · '), docNumber };
      });
    } catch { return []; }
  }));
  return lists.flat().sort((a, b) => a.label.localeCompare(b.label));
}

export function TransferAskWindow({ onClose, toast }: { onClose: () => void; toast: (m: string, ms?: number) => void }) {
  const superAdmin = getSession()?.role === 'superadmin';
  const [no, setNo] = React.useState('');
  const [pick, setPick] = React.useState('');
  const [picks, setPicks] = React.useState<TransferPick[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  React.useEffect(() => {
    if (!superAdmin) return;
    let live = true;
    otherFirmsWorkers().then(l => { if (live) setPicks(l); }, () => { if (live) setPicks([]); });
    return () => { live = false; };
  }, [superAdmin]);
  const choose = (v: string) => { setPick(v); setNo(picks?.find(p => p.value === v)?.docNumber || ''); };
  const send = async () => {
    if (!no.trim() || busy) return;
    setBusy(true);
    try { await signCall({ action: 'transferAsk', docNumber: no.trim() }); setSent(true); }
    catch (e: any) { toast(tr(String(e?.message || e)), 5000); }
    finally { setBusy(false); }
  };
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={tr('A worker from another firm')}
      footer={!sent && <Button variant="primary" data-testid="transfer-send" disabled={!no.trim() || busy} onClick={send}>
        {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconSend className="size-4" />}{tr('Send the request')}</Button>}>
      <div className="grid gap-3 px-1 pb-2" data-testid="transfer-ask" data-state={sent ? 'sent' : 'ready'}>
        {sent ? <p className="text-sm" data-testid="transfer-sent">{tr('Request sent. When the worker approves it in their own page and signs this firm\'s Form 101 and contract, they appear in the Workers list.')}</p> : <>
          {superAdmin && (
            <div className="grid gap-1.5" data-testid="transfer-pick">
              <Label htmlFor="transferPick">{tr('Worker')}</Label>
              <Combobox id="transferPick" rows={5} options={picks || []} value={pick} onChange={choose} disabled={!picks}
                placeholder={picks ? tr('Choose a worker') : tr('Loading…')} searchPlaceholder={tr('Search: name or ID / passport')} emptyText={tr('No workers found')} />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="transferNo">{tr('ID or passport number')}</Label>
            <Input id="transferNo" value={no} inputMode="text" autoFocus={!superAdmin} onChange={e => { setNo(e.target.value); setPick(''); }} onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
          </div>
          <p className="text-[11px] text-ink-3">{tr('Nothing is shown about the worker until they approve. A request not answered ends after 14 days.')}</p>
        </>}
      </div>
    </Window>
  );
}
