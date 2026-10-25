// Download data (docs/workers.md → Download data; docs/documents-plan.md → S2): opened from the worker card's ⋮.
// The parts of the worker's data to put into one PDF, as tiles — Form 101, the contract, the ID and scans (one A4
// sheet: the ID card or the passport with the ספח, then the other pages), the other documents; the summary page is
// always first and has no tick. A tile with nothing behind it is greyed out. The default ticks: Form 101 and the ID
// sheet; the last choice is kept on this device. The PDF is put together by `worker_docs` and opened.
import * as React from 'react';
import { IconFileDownload, IconLoader2 } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import { Window } from '@/components/shared/window';
import type { ManagerBridge, WorkerRecord } from './bridge';
import { DOWNLOAD_PARTS, storeInclude, storedInclude, type DownloadInclude, type DownloadPart } from './logic/workerdocs';

const LABELS: Record<DownloadPart, string> = { form101: 'Form 101', contract: 'Contract', scans: 'ID and scans', docs: 'Other documents' };

/** What stands behind each tile for this worker. */
export function downloadAvailable(w: WorkerRecord): Record<DownloadPart, boolean> {
  const docs = (w.docs || []).filter(d => d && d.fileId);
  const contracts = docs.filter(d => d.type === 'contract');
  return {
    form101: true,
    contract: contracts.length > 0,
    scans: (w.scanPages || []).length > 0 || !!w.assetsFileId,
    docs: docs.some(d => d.type !== 'contract') || contracts.length > 1,
  };
}

export function DownloadData({ w, api, onClose }: { w: WorkerRecord; api: ManagerBridge; onClose: () => void }) {
  const [picks, setPicks] = React.useState<DownloadInclude>(() => storedInclude());
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const has = downloadAvailable(w);
  const signed = !!w.signedAt;
  const include = Object.fromEntries(DOWNLOAD_PARTS.map(k => [k, !!picks[k] && has[k]])) as DownloadInclude;
  const hint: Record<DownloadPart, string> = {
    form101: signed ? tr('The signed copy, as stored') : tr('A preview, marked as not signed'),
    contract: !has.contract ? tr('Nothing to add') : !api.seesPay() ? tr('Left out for this login: it may hold pay') : tr('The signed one first'),
    scans: !has.scans ? tr('Nothing to add') : signed && include.form101 ? tr('Already inside the signed Form 101') : tr('The ID card or passport with its appendix (ספח) on one page'),
    docs: has.docs ? tr('Visa, work permit, older contracts…') : tr('Nothing to add'),
  };
  const set = (k: DownloadPart, on: boolean) => { const next = { ...picks, [k]: on }; setPicks(next); storeInclude(next); };
  const download = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api.downloadData(w.id, include);
      api.toast(tr('Download data: {0} pages', { 0: r.pages }) + (r.withheld.includes('contract') ? ' — ' + tr('the contract was left out: it may hold pay') : '')
        + (r.dropped ? ' — ' + tr('{0} files could not be added', { 0: r.dropped }) : ''), r.withheld.length || r.dropped ? 6000 : undefined);
      onClose();
    } catch (e: any) { setErr(tr('Download failed: {0}', { 0: String(e?.message || e) })); }
    finally { setBusy(false); }
  };
  return (
    <Window open onOpenChange={o => { if (!o) onClose(); }} title={tr('Download data')} description={w.name}
      footer={<Button variant="primary" data-testid="download-go" disabled={busy} onClick={download}>
        {busy ? <IconLoader2 className="size-4 animate-spin" /> : <IconFileDownload className="size-4" />}{busy ? tr('Putting the documents together…') : tr('Download')}</Button>}>
      <div className="grid gap-3 px-1 pb-2" data-testid="download-window">
        <p className="text-[13px] text-ink-2">{tr('One PDF: a summary page first, then the parts ticked below.')}</p>
        <CheckGrid>
          {DOWNLOAD_PARTS.map(k => (
            <CheckTile key={k} wide data-testid={'download-' + k} data-part={k} label={tr(LABELS[k])} hint={hint[k]}
              disabled={!has[k] || busy} checked={include[k]} onCheckedChange={v => set(k, v === true)} />
          ))}
        </CheckGrid>
        {err && <p className="text-sm text-bad" data-testid="download-error">{err}</p>}
      </div>
    </Window>
  );
}
