// The worker card (docs/workers.md → Worker card), drawn in React into the
// page's #workerCardModal: one page that only reads (owner's mock, 2026-10-26)
// — the head with every notice chip and the Active ↔ Inactive switch at the
// top right, Rescan and Documents to sign, the facts in pairs (every box the
// same width), the documents box across both columns with + Add, and a bottom
// bar — "Saved: <date>" on the left, Edit and ⋮ on the right — that stays put
// while the middle scrolls. A double click (computer) or a long press (phone)
// anywhere but a control opens the edit form, like Edit. The page opens and
// closes the overlay (backdrop, swipe, back to the card from a window opened
// from it — `__reopen`).
import * as React from 'react';
import {
  IconAlertTriangle, IconCash, IconChevronDown, IconDotsVertical, IconDownload, IconFile, IconFileCertificate,
  IconFileDownload, IconFileExport, IconFileUpload, IconIdBadge2, IconLink, IconLoader2, IconPencil, IconPlus, IconScan, IconSearch, IconSend, IconSignature,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { NewBadge } from '@/components/shared/new-badge';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { CardSnapshot, ManagerBridge, SignRequestView, WorkerDoc } from './bridge';
import { SignWindow, takeSign } from './SignWindow';
import { contractDocDate, statusFromSwitch, statusSwitchOn } from './logic/workers';
import { WORKER_DOCS_FN_URL, warmCloudFunctions } from './logic/functions';
import { DownloadData } from './DownloadData';
import { HOURS_STATUS, NoticeChipsAll, WorkerHeadLine } from './worker-head';
import { INCOME_LABELS, OTHER_INCOME_LABELS, WORKER_DOC_TYPES, fmtDMY, missingScanKeys, recordScanValues, scanLabel, workerAddress, workerDocId, workerHasScan } from './worker';

// Documents deleted here and still inside their Undo time.
const hiddenDocs = new Set<string>();
const LONG_PRESS_MS = 550;

// The switch's word: a stored vacation shows on, named as it is until the switch is flipped.
const STATUS_WORD: Record<string, [string, string]> = { active: ['Active', 'text-ok'], vacation: ['On vacation', 'text-warn'], fired: ['Inactive', 'text-bad'] };

const NONE = <span className="text-faint">—</span>;

/** A fact of the card: a small caption over its value (a second line under it when given); `wide` across both columns.
 * Every box takes its column's width — a pair is two equal boxes, never one stretched. */
function Kv({ label, children, sub, wide, testid }: { label: string; children: React.ReactNode; sub?: React.ReactNode; wide?: boolean; testid?: string }) {
  return (
    <div className={cn('min-w-0 rounded-[14px] bg-white/[.04] px-3 py-2 min-[701px]:px-3.5 min-[701px]:py-2.5', wide && 'col-span-2')} data-testid="card-kv" data-kv={testid}>
      <small className="block text-[11px] text-ink-2 min-[701px]:text-xs">{label}</small>
      <div className="mt-0.5 break-words text-sm text-ink min-[701px]:text-[15px]">{children == null || children === '' || children === false ? NONE : children}</div>
      {sub != null && sub !== '' && sub !== false && <div className="break-words text-xs text-ink-2 min-[701px]:text-[13px]">{sub}</div>}
    </div>
  );
}

/** One amber row per scan field the worker lacks; with a saved scan a tap searches it (and saves what it finds). */
function MissingScanRows({ snap, api }: { snap: CardSnapshot; api: ManagerBridge }) {
  const w = snap.w;
  const keys = missingScanKeys(recordScanValues(w), w.docType);
  const [all, setAll] = React.useState(false);
  const [state, setState] = React.useState<Record<string, 'busy' | 'none'>>({});
  if (!keys.length) return null;
  const can = workerHasScan(w);
  const SHOW = 3, more = keys.length - SHOW;
  // A long list shows its first 3 rows; the rest open with "Show N more".
  const open = all || more <= 1;
  const find = async (key: string) => {
    if (!can || state[key]) return;
    setState(s => ({ ...s, [key]: 'busy' }));
    let r = null;
    try { const res = await api.findScanFields(w.id, [key], w.docType || 'israeli_id'); r = res && res[key]; }
    catch (e) {
      // the search failed or did not answer: the row can be tapped again, the reason in a note
      console.error(e);
      setState(s => { const n = { ...s }; delete n[key]; return n; });
      api.toast(tr('The scan search failed: {0} — tap the field to try again', { 0: String((e as Error)?.message || e) }), 6000);
      return;
    }
    if (!r || !r.value) { setState(s => ({ ...s, [key]: 'none' })); return; }
    api.setScanField(w.id, key, r.value);
    api.toast(scanLabel(key, w.docType) + ': ' + r.value + (r.unsure ? ' — ' + tr('check it') : ''), r.unsure ? 5000 : undefined);
    api.regenerateDoc(w.id).then(ok => api.toast(ok ? tr('Form 101 updated') : tr('Form 101 update failed')));
  };
  return (
    <div className="col-span-2 flex flex-col gap-1.5" data-testid="card-missing">
      {keys.map((k, i) => {
        const st = state[k];
        return (
          <div key={k} id={'cardMiss_' + k} data-key={k} hidden={!open && i >= SHOW} role={can && !st ? 'button' : undefined} onClick={() => find(k)}
            className={cn('flex items-center gap-2 rounded-lg border border-dashed border-warn px-2.5 py-1.5 text-xs text-warn [&[hidden]]:hidden', can && !st && 'cursor-pointer')}>
            {st === 'busy' ? <IconLoader2 className="size-4 animate-spin" /> : can && !st ? <IconSearch className="size-4" /> : <IconAlertTriangle className="size-4" />}
            <b dir="rtl">{scanLabel(k, w.docType)}</b>
            <span>— {st === 'busy' ? tr('searching the scan…')
              : st === 'none' ? <>{tr('not found in the scan')} · <a href="#" className="underline" onClick={e => { e.preventDefault(); e.stopPropagation(); api.rescanFromCard(w.id); }}>{tr('photograph it again')}</a></>
              : tr('not scanned') + (can ? ' · ' + tr('tap to search the scan') : '')}</span>
          </div>
        );
      })}
      {!all && more > 1 && (
        <Button size="sm" className="self-start !text-warn" onClick={e => { e.stopPropagation(); setAll(true); }}>
          <IconChevronDown className="size-4" />{tr('Show {0} more missing fields', { 0: more })}
        </Button>
      )}
    </div>
  );
}

/** The worker's uploaded documents, in one box across both columns: + Add, Select, the plates (paged by 10). */
function DocsBox({ snap, api }: { snap: CardSnapshot; api: ManagerBridge }) {
  const w = snap.w, can = snap.canEdit;
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const docs = React.useMemo(() => [...(w.docs || [])].filter(d => !hiddenDocs.has(String(d.id)))
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))), [w.docs, hiddenDocs.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = React.useMemo(() => docs.map(d => String(d.id)), [docs]);
  const sel = useSelection(ids);
  const remove = (which: string[]) => {
    // a signed document is never removed (docs/contracts.md → Signed files are kept)
    const picked = docs.filter(d => which.includes(String(d.id)));
    const gone = picked.filter(d => !d.signed);
    if (gone.length < picked.length) api.toast(tr('Signed documents are kept'));
    if (!gone.length) return;
    gone.forEach(d => hiddenDocs.add(String(d.id))); redraw();
    const one = gone.length === 1 ? gone[0] : null;
    undoDelete(one ? one.name || tr(WORKER_DOC_TYPES[one.type] || 'Document') : tr('{0} documents', { 0: gone.length }),
      () => { gone.forEach(d => hiddenDocs.delete(String(d.id))); api.removeDocs(w.id, gone.map(d => String(d.id))); },
      () => { gone.forEach(d => hiddenDocs.delete(String(d.id))); redraw(); });
  };
  const open = (d: WorkerDoc) => { if (d.url) window.open(d.url, '_blank', 'noopener'); };
  const plate = (d: WorkerDoc) => {
    const x = snap.docExpiry[String(d.id)];
    const c = x ? (x.level === 'error' ? 'var(--red)' : 'var(--amber)') : 'var(--green)';
    // a contract has no expiry: its date is the day the contract term counts from (workerExpiryStatus)
    const cd = d.type === 'contract' ? contractDocDate(w, d) : null;
    const exText = d.type === 'contract' ? (cd ? tr('Contract date {0}', { 0: cd.toLocaleDateString('en-GB') }) : '')
      : d.expiry ? (x && x.level === 'error' ? tr('Expired {0}', { 0: fmtDMY(d.expiry) }) : tr('Expires {0}', { 0: fmtDMY(d.expiry) })) : tr('No expiry date');
    const Icon = d.type === 'contract' ? IconFileCertificate : d.type === 'other' ? IconFile : IconIdBadge2;
    return (
      <Plate key={d.id} data-testid="worker-doc" data-doc={d.id} className="mb-1.5" size="sm" color={c} icon={<Icon />}
        title={tr(WORKER_DOC_TYPES[d.type] || 'Document')}
        sub={<>{d.name || 'file'} · <span style={{ color: x ? c : undefined }}>{exText}</span></>}
        actions={[{ label: tr('Open'), icon: <IconDownload />, onSelect: () => open(d) }]}
        onOpen={() => open(d)}
        onDelete={can && !d.signed ? () => remove([String(d.id)]) : undefined}
        selecting={sel.on} selected={sel.picked.has(String(d.id))} onToggle={() => sel.toggle(String(d.id))} />
    );
  };
  return (
    <div className="col-span-2 min-w-0 rounded-[14px] bg-white/[.04] px-3 py-2 min-[701px]:px-3.5 min-[701px]:py-2.5" data-testid="card-docs">
      <div className="flex items-center justify-between gap-2.5">
        <div className="min-w-0">
          <small className="block text-[11px] text-ink-2 min-[701px]:text-xs">{tr('Uploaded documents')}</small>
          {!docs.length && <div className="mt-0.5 text-[13px] text-ink-2 min-[701px]:text-sm">{tr('No documents yet — contract, visa, work permit…')}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {can && docs.length > 0 && <SelectHead sel={sel} />}
          {can && <Button size="sm" data-testid="card-docs-add" onClick={() => api.openDocUpload(w.id)}><IconPlus className="size-4" />{tr('Add')}</Button>}
        </div>
      </div>
      {docs.length > 0 && <div className="mt-2" data-testid="worker-docs"><PagedList items={docs} render={plate} /></div>}
      <SelectBar sel={sel} onDelete={can ? remove : undefined} />
    </div>
  );
}

/** Sent to sign (waiting for the worker) / Signed with its date — the latest signing's, also while its documents are
 * still being built ('signing') / Needs sending again (the template was deleted). */
function SignChip({ req, signDate }: { req: SignRequestView | null; signDate?: string }) {
  if (req && req.status === 'sent') return <Badge variant="info" data-testid="card-sign-state" data-state="sent"><IconSend />{tr('Sent to sign')}</Badge>;
  if (req && req.status === 'withdrawn') return <Badge variant="warn" data-testid="card-sign-state" data-state="withdrawn"><IconAlertTriangle />{tr('Needs sending again')}</Badge>;
  const d = (req && (req.status === 'signed' || req.status === 'signing') && req.signDate) || signDate;
  return d ? <Badge variant="ok" data-testid="card-sign-state" data-state="signed"><IconSignature />{tr('Signed {0}', { 0: d })}</Badge> : null;
}

/** The one Active ↔ Inactive switch at the top right (read-only without the right to edit workers). */
function StatusSwitch({ snap, api }: { snap: CardSnapshot; api: ManagerBridge }) {
  const w = snap.w, status = w.status || 'active';
  const on = statusSwitchOn(status);
  const [word, color] = STATUS_WORD[status] || STATUS_WORD.active;
  const label = <span className={cn('text-[11px] font-semibold min-[701px]:text-[13px]', color)} data-testid="card-status-word">{tr(word)}</span>;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1" data-testid="card-status" data-status={status}>
      <label className={cn('flex flex-col-reverse items-end gap-1 min-[701px]:flex-row min-[701px]:items-center min-[701px]:gap-2.5', snap.canEdit && 'cursor-pointer')}>
        {label}
        <Switch checked={on} disabled={!snap.canEdit} aria-label={tr('Active')} data-testid="card-status-switch"
          onCheckedChange={v => api.setWorkerStatus(w.id, statusFromSwitch(v))} />
      </label>
      <span className="hidden text-[11px] text-faint min-[701px]:block">{tr('Active')} · {tr('Inactive')}</span>
    </div>
  );
}

export function WorkerCard({ snap, api }: { snap: CardSnapshot; api: ManagerBridge }) {
  const w = snap.w, can = snap.canEdit;
  const press = React.useRef(0);
  const [signing, setSigning] = React.useState(() => takeSign(w.id));
  const [downloading, setDownloading] = React.useState(false);
  // Download data's function is woken while the card is read (a cold start costs seconds)
  React.useEffect(() => { warmCloudFunctions([WORKER_DOCS_FN_URL]); }, [w.id]);
  const req = api.signRequest(w.id);

  const docId = workerDocId(w);
  const street = [workerAddress(w), w.houseNumber].filter(Boolean).join(' ');
  const edit = () => api.editFromCard(w.id);
  const control = (t: EventTarget) => !!(t as HTMLElement).closest?.('button, a, input, select, textarea, label, [role="button"], [role="radio"], [role="switch"], [data-slot="plate"]');
  const more = [
    ...(snap.canPay ? [{ icon: <IconCash />, label: tr('Pay'), run: () => api.payFromCard(w.id) }] : []),
    ...(w.docUrl ? [{ icon: <IconDownload />, label: tr('Download document'), run: () => window.open(w.docUrl, '_blank', 'noopener') }] : []),
    { icon: <IconFileDownload />, label: tr('Download data'), run: () => setDownloading(true) },
    ...(can ? [{ icon: <IconFileUpload />, label: tr('Upload hours'), run: () => api.openHoursImport(w.id) }] : []),
    ...(can && snap.canExport ? [{ icon: <IconFileExport />, label: tr('Export hours'), run: () => api.openHoursExport(w.id) }] : []),
    ...(can ? [{ icon: <IconLink />, label: tr('Punch link'), run: () => api.copyLink(w.id) }] : []),
  ];
  const hb = snap.hoursBatch, hs = hb ? (HOURS_STATUS[hb.status] || HOURS_STATUS.pending) : null;
  const hsColor = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' };

  return (
    <div data-testid="worker-card" data-wid={w.id}
      className="flex min-h-0 shrink select-text flex-col"
      onDoubleClick={e => { if (can && !control(e.target)) edit(); }}
      onPointerDown={e => {
        if (!can || control(e.target)) return;
        const x = e.clientX, y = e.clientY;
        press.current = window.setTimeout(edit, LONG_PRESS_MS);
        const stop = (ev: PointerEvent) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x, ev.clientY - y) > 8) { window.clearTimeout(press.current); off(); } };
        const off = () => ['pointermove', 'pointerup', 'pointercancel'].forEach(t => window.removeEventListener(t, stop as EventListener));
        ['pointermove', 'pointerup', 'pointercancel'].forEach(t => window.addEventListener(t, stop as EventListener));
      }}>
      {/* the middle scrolls; the bottom bar stays at the bottom of the sheet */}
      <div className="min-h-0 shrink overflow-y-auto" data-testid="card-body">
        <WorkerHeadLine head={snap} right={<StatusSwitch snap={snap} api={api} />} />
        <div className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden" data-testid="card-chips">
          <NoticeChipsAll notices={snap.notices} onOpen={() => { api.closeModal('workerCardOverlay'); api.openNotices(w.id); }} />
          <NewBadge createdAt={w.createdAt} />
          <SignChip req={req} signDate={w.signDate as string | undefined} />
          {!!w.movedToOtherFirm && <Badge variant="warn" data-testid="card-moved">{tr('Moved to another firm')}</Badge>}
        </div>
        {signing && <SignWindow workerId={w.id} api={api} onClose={() => setSigning(false)} />}
        {downloading && <DownloadData w={w} api={api} onClose={() => setDownloading(false)} />}
        {can && (
          <div className="mb-3 grid grid-cols-2 gap-2 min-[701px]:flex min-[701px]:justify-end min-[701px]:gap-2.5" data-testid="card-tools">
            <Button data-testid="card-scan" className="justify-center" onClick={() => api.rescanFromCard(w.id)}><IconScan className="size-[18px]" />{tr(w.docUrl ? 'Rescan' : 'Scan document')}</Button>
            <Button data-testid="card-sign" className="justify-center" onClick={() => setSigning(true)}><IconSignature className="size-[18px]" />
              <span className="min-[701px]:hidden">{tr('To sign')}</span><span className="hidden min-[701px]:inline">{tr('Documents to sign')}</span>
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 min-[701px]:gap-2.5" data-testid="card-info">
          <Kv label={tr('ID / Passport')} testid="id">{docId && <span className="font-mono">{docId}</span>}</Kv>
          <Kv label={tr('Clients')} testid="clients">{snap.clients.length ? snap.clients.map((o, i) => <React.Fragment key={o.id}>{i > 0 && ', '}<span style={{ color: o.color }}>{o.name}</span></React.Fragment>) : <span className="text-ink-2">{tr('Not assigned to any object')}</span>}</Kv>
          <Kv label={tr('HR')} testid="hr">{snap.hr && (snap.hr.name
            ? <span style={{ color: snap.hr.color }}>{snap.hr.name}</span>
            // an HR is set but its name is not known to this login (only the owner / super-admin loads the HR logins)
            : <span className="text-ink-2">{tr('Assigned')}</span>)}</Kv>
          <Kv label={tr('Supplier')} testid="supplier">{snap.supplier && <span style={{ color: snap.supplier.color }}>{snap.supplier.name}</span>}</Kv>
          <Kv label={tr('Start date')} testid="start">{w.startDate && <span className="font-mono">{fmtDMY(w.startDate)}</span>}</Kv>
          <Kv label={tr('Shift today')} testid="shift">{snap.shiftToday ? <span className="font-mono text-fig">{snap.shiftToday.start}–{snap.shiftToday.end}</span> : <span className="text-warn">{tr('Day off')}</span>}</Kv>
          {/* the city on the first line, the street under it; without a city the street takes the first line */}
          <Kv label={tr('Address')} testid="address" sub={w.city && street && <span dir="rtl">{street}</span>}>{(w.city || street) && <span dir="rtl">{w.city || street}</span>}</Kv>
          <Kv label={tr('Income')} testid="income">{w.incomeType && INCOME_LABELS[w.incomeType] && <span dir="rtl">{INCOME_LABELS[w.incomeType]}</span>}</Kv>
          <Kv label={tr('Documents')} testid="docs-status">
            {snap.docLevel === 'ok'
              ? <span className="text-ok">{tr('Complete')}</span>
              : <span className={snap.docLevel === 'error' ? 'text-bad' : 'text-warn'}>{snap.docLines.map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</span>}
          </Kv>
          <Kv label={tr('Hours sent')} testid="hours-sent" sub={hb && hb.when && <span className="font-mono">{new Date(hb.when).toLocaleDateString('en-GB')}</span>}>
            {hb && hs && <span className={hsColor[hs[1]]} data-testid="card-hours-status" data-status={hb.status}>{tr(hs[0])}</span>}
          </Kv>
          {/* the facts the mock leaves out stay, in the same pairs, only when the worker has them */}
          {w.phone && <Kv label={tr('Phone')} testid="phone">{w.phone}</Kv>}
          {snap.contract && <Kv label={tr('Contract')} testid="contract"><span className={snap.contract.overdue ? 'text-bad' : 'text-warn'}>{snap.contract.overdue ? tr('Expired') : tr('Expiring soon')} — {snap.contract.deadline}</span></Kv>}
          {w.otherIncomeType && w.otherIncomeType !== 'none' && OTHER_INCOME_LABELS[w.otherIncomeType] && <Kv label={tr('Other income')} testid="other-income"><span dir="rtl">{OTHER_INCOME_LABELS[w.otherIncomeType]}</span></Kv>}
          {w.notes && <div className="col-span-2 whitespace-pre-wrap rounded-[14px] bg-white/[.04] px-3 py-2 text-[13px] text-ink-2" data-testid="card-notes">{w.notes}</div>}
          {can && <MissingScanRows snap={snap} api={api} />}
          <DocsBox snap={snap} api={api} />
        </div>
      </div>

      <div className="mt-3 flex shrink-0 items-end justify-between gap-2 border-t border-white/10 pt-3" data-testid="card-actions">
        <span className="pb-1 font-mono text-[11px] text-faint min-[701px]:text-xs" data-testid="card-saved">
          {tr('Saved: {0}', { 0: w.docSavedAt ? new Date(w.docSavedAt).toLocaleDateString('en-GB') : '—' })}
        </span>
        <div className="flex items-center gap-2">
          {can && <Button variant="primary" id="workerCardEdit" data-testid="card-edit" onClick={edit}><IconPencil className="size-[18px]" />{tr('Edit')}</Button>}
          {more.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" aria-label={tr('More')} data-testid="card-more"><IconDotsVertical className="size-[18px]" /></Button>
              </DropdownMenuTrigger>
              {/* its items open other windows: the focus does not go back to ⋮ in the card behind them once the menu
                  has closed — it closed a date picker opened meanwhile in a window opened from the card (a focus outside it) */}
              <DropdownMenuContent onCloseAutoFocus={e => e.preventDefault()}>
                {more.map(m => <DropdownMenuItem key={m.label} onSelect={m.run}>{m.icon}{m.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}
