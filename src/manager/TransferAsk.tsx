// Add a worker from another firm (docs/contracts.md → Moving to another firm, D6): the firm's admin
// types the worker's ID or passport number; the answer is always "Request sent" — the firm learns
// nothing until the worker approves in their own page, signing this firm's Form 101 and contract.
import * as React from 'react';
import { IconLoader2, IconSend } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Window } from '@/components/shared/window';
import { signCall } from './logic/signing';

export function TransferAskWindow({ onClose, toast }: { onClose: () => void; toast: (m: string, ms?: number) => void }) {
  const [no, setNo] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
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
          <div className="grid gap-1.5">
            <Label htmlFor="transferNo">{tr('ID or passport number')}</Label>
            <Input id="transferNo" value={no} inputMode="text" autoFocus onChange={e => setNo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send(); }} />
          </div>
          <p className="text-[11px] text-ink-3">{tr('Nothing is shown about the worker until they approve. A request not answered ends after 14 days.')}</p>
        </>}
      </div>
    </Window>
  );
}
