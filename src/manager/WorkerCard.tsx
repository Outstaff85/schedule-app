// The worker card (docs/workers.md → Worker card), drawn in React into the
// page's #workerCardModal (stage 6c-2): a sheet that only reads — the head,
// every notice chip, the status pills, "saved" and the scan button, an Info /
// Docs / Hours switch, one primary Edit and a ⋮ with the rest. A double click
// (computer) or a long press (phone) anywhere but a control opens the edit
// form, like Edit. The page opens and closes the overlay (backdrop, swipe,
// back to the card from a window opened from it — `__reopen`).
import * as React from 'react';
import {
  IconAlertTriangle, IconCash, IconChevronDown, IconCircleCheck, IconDotsVertical, IconDownload, IconFile, IconFileCertificate,
  IconFileDownload, IconFileExport, IconFileUpload, IconFiles, IconFolder, IconIdBadge2, IconLink, IconLoader2, IconPencil, IconScan, IconSearch, IconSend, IconSignature, IconUpload,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { NewBadge } from '@/components/shared/new-badge';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import type { CardSnapshot, ManagerBridge, SignRequestView, WorkerDoc } from './bridge';
import { SignWindow, takeSign } from './SignWindow';
import { contractDocDate } from './logic/workers';
import { WORKER_DOCS_FN_URL, warmCloudFunctions } from './logic/functions';
import { DownloadData } from './DownloadData';
import { HoursStatusChip, NoticeChipsAll, WorkerHeadLine } from './worker-head';
import { INCOME_LABELS, OTHER_INCOME_LABELS, WORKER_DOC_TYPES, fmtDMY, missingScanKeys, recordScanValues, scanLabel, workerAddress, workerDocId, workerHasScan } from './worker';
import { hoursShort } from './today';

type Pane = 'info' | 'docs' | 'hours';
// The open pane is kept while the card is opened again for the same worker.
let lastPane: { wid: string; pane: Pane } | null = null;
// Documents deleted here and still inside their Undo time.
const hiddenDocs = new Set<string>();
const LONG_PRESS_MS = 550;

const STATUS: [string, string, string][] = [['active', 'Active', 'var(--green)'], ['vacation', 'Vacation', 'var(--amber)'], ['fired', 'Inactive', 'var(--red)']];
const STATUS_BADGE: Record<string, ['ok' | 'warn' | 'bad', string]> = { active: ['ok', 'Active'], vacation: ['warn', 'On vacation'], fired: ['bad', 'Inactive'] };

/** A fact of the Info / Hours panes: a small caption over its value; `wide` across both columns. */
function Kv({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <div className={cn('min-w-0 rounded-[12px] bg-white/[.04] px-3 py-2', wide && 'col-span-2')} data-testid="card-kv">
      <small className="block text-[11px] text-ink-3">{label}</small>
      <div className="break-words text-sm text-ink">{children}</div>
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
    <div className="mb-3 flex flex-col gap-1.5" data-testid="card-missing">
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

function DocsPane({ snap, api, active }: { snap: CardSnapshot; api: ManagerBridge; active: boolean }) {
  const w = snap.w, can = snap.canEdit;
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const docs = React.useMemo(() => [...(w.docs || [])].filter(d => !hiddenDocs.has(String(d.id)))
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))), [w.docs, hiddenDocs.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = React.useMemo(() => docs.map(d => String(d.id)), [docs]);
  const sel = useSelection(ids);
  // Another pane clears the ticks.
  const { end } = sel;
  React.useEffect(() => { if (!active) end(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = (which: string[]) => {
    // a person's own delete: a signed document goes too (docs/contracts.md → Signed files are kept)
    const gone = docs.filter(d => which.includes(String(d.id)));
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
        onDelete={can ? () => remove([String(d.id)]) : undefined}
        selecting={sel.on} selected={sel.picked.has(String(d.id))} onToggle={() => sel.toggle(String(d.id))} />
    );
  };
  return (
    <div data-testid="card-docs">
      <div className="mb-2.5 flex items-start gap-2 text-[13px] text-ink-2" data-testid="card-docs-status">
        <IconFiles className="mt-0.5 size-4 shrink-0" />
        <span>{tr('Documents:')}{' '}
          {snap.docLevel === 'ok'
            ? <span className="text-ok"><IconCircleCheck className="inline size-3.5 align-[-2px]" /> {tr('Complete')}</span>
            : <span className={snap.docLevel === 'error' ? 'text-bad' : 'text-warn'}>{snap.docLines.map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</span>}
        </span>
      </div>
      {can && <MissingScanRows snap={snap} api={api} />}
      <div className="mb-1 flex items-center justify-between gap-2">
        <b className="flex items-center gap-1.5 text-[13px]"><IconFolder className="size-4" />{tr('Documents')}</b>
        {can && docs.length > 0 && <SelectHead sel={sel} />}
      </div>
      {docs.length
        ? <div data-testid="worker-docs"><PagedList items={docs} render={plate} /></div>
        : <div className="text-xs text-ink-3">{tr('No documents yet — contract, visa, work permit…')}</div>}
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

export function WorkerCard({ snap, api }: { snap: CardSnapshot; api: ManagerBridge }) {
  const w = snap.w, can = snap.canEdit;
  const [pane, setPaneState] = React.useState<Pane>(() => (lastPane && lastPane.wid === w.id ? lastPane.pane : 'info'));
  const setPane = (p: Pane) => { lastPane = { wid: w.id, pane: p }; setPaneState(p); };
  React.useEffect(() => { lastPane = { wid: w.id, pane }; }, [w.id, pane]);
  const press = React.useRef(0);
  const [signing, setSigning] = React.useState(() => takeSign(w.id));
  const [downloading, setDownloading] = React.useState(false);
  // Download data's function is woken while the card is read (a cold start costs seconds)
  React.useEffect(() => { warmCloudFunctions([WORKER_DOCS_FN_URL]); }, [w.id]);
  const req = api.signRequest(w.id);

  const status = w.status || 'active';
  const docId = workerDocId(w);
  const addr = [[workerAddress(w), w.houseNumber].filter(Boolean).join(' '), w.city].filter(Boolean).join(', ');
  const edit = () => api.editFromCard(w.id);
  const control = (t: EventTarget) => !!(t as HTMLElement).closest?.('button, a, input, select, textarea, [role="button"], [role="radio"], [data-slot="plate"]');
  const more = [
    ...(snap.canPay ? [{ icon: <IconCash />, label: tr('Pay'), run: () => api.payFromCard(w.id) }] : []),
    ...(can ? [{ icon: <IconUpload />, label: tr('Add document'), run: () => api.openDocUpload(w.id) }] : []),
    ...(w.docUrl ? [{ icon: <IconDownload />, label: tr('Download document'), run: () => window.open(w.docUrl, '_blank', 'noopener') }] : []),
    { icon: <IconFileDownload />, label: tr('Download data'), run: () => setDownloading(true) },
    ...(can ? [{ icon: <IconFileUpload />, label: tr('Upload hours'), run: () => api.openHoursImport(w.id) }] : []),
    ...(can && snap.canExport ? [{ icon: <IconFileExport />, label: tr('Export hours'), run: () => api.openHoursExport(w.id) }] : []),
    ...(can ? [{ icon: <IconLink />, label: tr('Punch link'), run: () => api.copyLink(w.id) }] : []),
  ];

  return (
    <div data-testid="worker-card" data-wid={w.id} className="select-text"
      onDoubleClick={e => { if (can && !control(e.target)) edit(); }}
      onPointerDown={e => {
        if (!can || control(e.target)) return;
        const x = e.clientX, y = e.clientY;
        press.current = window.setTimeout(edit, LONG_PRESS_MS);
        const stop = (ev: PointerEvent) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x, ev.clientY - y) > 8) { window.clearTimeout(press.current); off(); } };
        const off = () => ['pointermove', 'pointerup', 'pointercancel'].forEach(t => window.removeEventListener(t, stop as EventListener));
        ['pointermove', 'pointerup', 'pointercancel'].forEach(t => window.addEventListener(t, stop as EventListener));
      }}>
      <WorkerHeadLine head={snap} />
      <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="card-chips">
        <NoticeChipsAll notices={snap.notices} onOpen={() => { api.closeModal('workerCardOverlay'); api.openNotices(w.id); }} />
        {!can && <Badge variant={STATUS_BADGE[status]?.[0] || 'ok'}>{tr(STATUS_BADGE[status]?.[1] || 'Active')}</Badge>}
        <NewBadge createdAt={w.createdAt} />
        <SignChip req={req} signDate={w.signDate as string | undefined} />
        {!!w.movedToOtherFirm && <Badge variant="warn" data-testid="card-moved">{tr('Moved to another firm')}</Badge>}
      </div>
      {signing && <SignWindow workerId={w.id} api={api} onClose={() => setSigning(false)} />}
      {downloading && <DownloadData w={w} api={api} onClose={() => setDownloading(false)} />}
      {(can || w.docSavedAt) && (
        <div className="mb-2.5 flex flex-wrap items-center justify-end gap-2" data-testid="card-tools">
          {can && (
            <div role="radiogroup" aria-label={tr('Status')} className="flex gap-1" data-testid="status-pills">
              {STATUS.map(([v, l, c]) => (
                <button key={v} type="button" role="radio" aria-checked={status === v} data-st={v} title={tr('Set status: {0}', { 0: tr(l) })}
                  onClick={() => api.setWorkerStatus(w.id, v)}
                  className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border border-white/12 px-2.5 text-xs font-semibold text-ink-2', status === v && 'on text-ink')}
                  style={status === v ? { background: `color-mix(in srgb, ${c} 22%, transparent)`, borderColor: c } : undefined}>
                  <i className="size-2 rounded-full" style={{ background: c }} />{tr(l)}
                </button>
              ))}
            </div>
          )}
          {w.docSavedAt && <span className="text-[11px] text-ink-3">{tr('Saved: {0}', { 0: new Date(w.docSavedAt).toLocaleDateString('en-GB') })}</span>}
          {can && <Button size="sm" data-testid="card-scan" onClick={() => api.rescanFromCard(w.id)}><IconScan className="size-4" />{tr(w.docUrl ? 'Rescan' : 'Scan document')}</Button>}
          {can && <Button size="sm" data-testid="card-sign" onClick={() => setSigning(true)}><IconSignature className="size-4" />{tr('Documents to sign')}</Button>}
        </div>
      )}
      <ToggleGroup type="single" value={pane} onValueChange={v => { if (v) setPane(v as Pane); }} className="mb-3" data-testid="card-panes">
        <ToggleGroupItem value="info" data-p="info">{tr('Info')}</ToggleGroupItem>
        <ToggleGroupItem value="docs" data-p="docs">{tr('Docs')}</ToggleGroupItem>
        <ToggleGroupItem value="hours" data-p="hours">{tr('Hours')}</ToggleGroupItem>
      </ToggleGroup>

      {/* every pane stays in the card, the others hidden (as the old card had them) */}
      <div data-testid="card-info" data-p="info" hidden={pane !== 'info'}>
          <div className="grid grid-cols-2 gap-2">
            <Kv label={tr('Phone')}>{w.phone}</Kv>
            <Kv label={tr('ID / Passport')}>{docId && <span className="font-mono">{docId}</span>}</Kv>
            <Kv label={tr('Clients')}>{snap.clients.length ? snap.clients.map((o, i) => <React.Fragment key={o.id}>{i > 0 && ', '}<span style={{ color: o.color }}>{o.name}</span></React.Fragment>) : <span className="text-ink-3">{tr('Not assigned to any object')}</span>}</Kv>
            <Kv label={tr('Supplier')}>{snap.supplier && <span style={{ color: snap.supplier.color }}>{snap.supplier.name}</span>}</Kv>
            {snap.isFirmAdmin && <Kv label={tr('HR')}>{snap.hr ? <span style={{ color: snap.hr.color }}>{snap.hr.name || '—'}</span> : <span className="text-ink-3">{tr('none')}</span>}</Kv>}
            <Kv label={tr('Shift today')}>{snap.shiftToday ? <span className="font-mono text-fig">{snap.shiftToday.start}–{snap.shiftToday.end}</span> : <span className="text-warn">{tr('Day off')}</span>}</Kv>
            <Kv label={tr('Start date')}>{w.startDate && fmtDMY(w.startDate)}</Kv>
            {snap.contract && <Kv label={tr('Contract')}><span className={snap.contract.overdue ? 'text-bad' : 'text-warn'}>{snap.contract.overdue ? tr('Expired') : tr('Expiring soon')} — {snap.contract.deadline}</span></Kv>}
            <Kv label={tr('Address')} wide>{addr}</Kv>
            {w.incomeType && INCOME_LABELS[w.incomeType] && <Kv label={tr('Income')}><span dir="rtl">{INCOME_LABELS[w.incomeType]}</span></Kv>}
            {w.otherIncomeType && w.otherIncomeType !== 'none' && OTHER_INCOME_LABELS[w.otherIncomeType] && <Kv label={tr('Other income')}><span dir="rtl">{OTHER_INCOME_LABELS[w.otherIncomeType]}</span></Kv>}
          </div>
          {w.notes && <div className="mt-2 whitespace-pre-wrap rounded-[12px] bg-white/[.04] px-3 py-2 text-[13px] text-ink-2" data-testid="card-notes">{w.notes}</div>}
      </div>
      <div data-p="docs" hidden={pane !== 'docs'}><DocsPane snap={snap} api={api} active={pane === 'docs'} /></div>
      <div data-testid="card-hours" data-p="hours" hidden={pane !== 'hours'}>
          <div className="grid grid-cols-2 gap-2">
            <Kv label={tr('This month')}><span className="font-mono text-lg font-bold text-fig">{hoursShort(snap.monthHours)}</span></Kv>
            <Kv label={tr('Scheduled')}>{tr('{0}h scheduled / week', { 0: snap.weekHours.toFixed(1) })}</Kv>
          </div>
          {snap.hoursBatch && (
            <div className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-2" data-testid="card-hours-status">
              <IconFileUpload className="size-4" />{tr('Hours sent:')} <HoursStatusChip b={snap.hoursBatch} />
            </div>
          )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2" data-testid="card-actions">
        {can && <Button variant="primary" id="workerCardEdit" data-testid="card-edit" onClick={edit}><IconPencil className="size-[18px]" />{tr('Edit')}</Button>}
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" aria-label={tr('More')} data-testid="card-more"><IconDotsVertical className="size-[18px]" /></Button>
            </DropdownMenuTrigger>
            {/* its items open other windows: the focus does not go back to ⋮ in the card behind them once the menu
                has closed — it closed a date picker opened meanwhile in Add document (a focus outside it) */}
            <DropdownMenuContent onCloseAutoFocus={e => e.preventDefault()}>
              {more.map(m => <DropdownMenuItem key={m.label} onSelect={m.run}>{m.icon}{m.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
