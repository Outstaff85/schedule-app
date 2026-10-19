// The worker window (docs/workers.md → Worker modal), drawn in React into the
// page's #workerModal (stage 6c-2): one form for add, edit and the review after
// a scan, as section plates in the owner's fixed order — Person, Address,
// Work, Documents, Form 101, Access. Form 101 labels and values are Hebrew; a
// foreign passport's names stay Latin. No Save button: the page's overlay
// saves it when closed by a tap outside (`__onUserClose` → saveWorker, here
// `save`). The scan fields a scan left empty are framed; a tap searches the
// worker's scan for that field, a "check" field reads it again (the page's
// findScanFields over the bridge). The fields stay mounted while their
// section is closed, so every save reads them all.
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import {
  IconAlertCircle, IconAlertTriangle, IconBriefcase, IconCalendar, IconChevronDown, IconChevronUp, IconClipboardText, IconDeviceFloppy,
  IconFileCertificate, IconFileText, IconFiles, IconHeart, IconHome, IconId, IconIdBadge2, IconKey, IconLink, IconLoader2, IconMapPin,
  IconMoodKid, IconPlus, IconRefresh, IconScan, IconTrash, IconTruckDelivery, IconUpload, IconUser, IconUserShield, IconUsers, IconX,
} from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DatePicker } from '@/components/ui/date-picker';
import { Combobox } from '@/components/ui/combobox';
import { FieldRow } from '@/components/ui/form';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SignaturePad, type SignaturePadHandle } from '@/components/shared/signature-pad';
import type { Child, DayShift, EditorInfo, ManagerBridge, ScanHit, WorkerRecord } from './bridge';
import { NoticeChipsAll, initials } from './worker-head';
import { Line, TodayPin } from './pieces';
import { hoursShort } from './today';
import {
  DAYS_EN, DAYS_HE, HEALTH_FUND_LABELS, INCOME_LABELS, MARITAL_LABELS, OTHER_INCOME_LABELS, SCAN_FIELDS, SEX_LABELS, SPOUSE_INCOME_LABELS,
  WORKER_DOC_TYPES, fmtDMY, formOf, type FormKey, type WorkerForm,
} from './worker';
import { saveWorker, type EditorState } from './worker-save';

/** A scan field's mark: empty and searchable, searching, not found, "check" (two reads differ), found (green for a moment). */
type Mark = { k: 'missing' | 'busy' | 'none' | 'check' | 'found'; msg?: React.ReactNode; rechecked?: boolean; prev?: string };
const NONE = '-';
const INPUT_ID: Record<string, string> = {
  docGiven: 'wGiven', docSurname: 'wSurname', docId: 'wDocId', docExpiry: 'wDocExpiry', docSex: 'wSex', maritalStatus: 'wMaritalStatus',
  healthFund: 'wHealthFund', docDob: 'wDob', phone: 'wPhone', address: 'wAddress', houseNumber: 'wHouseNumber', city: 'wCity',
  supplierId: 'wSupplierId', hrId: 'wHrId', startDate: 'wStartDate', expiryMonths: 'wExpiryMonths', expiryWarnMonths: 'wExpiryWarnMonths',
  notes: 'wNotes', incomeType: 'wIncomeType', otherIncomeType: 'wOtherIncomeType', spouseSurname: 'wSpouseSurname', spouseGiven: 'wSpouseGiven',
  spouseId: 'wSpouseId', spouseDob: 'wSpouseDob', spouseIncome: 'wSpouseIncome',
};
const norm = (x: unknown) => String(x || '').replace(/[\s./-]/g, '').toUpperCase();

/** What the page hands over to open the window. */
export type EditorProps = { w: WorkerRecord; editId: string | null; seq: number };
/** The open window's handle, for the page's saveWorker / applyWorkerDraft / autoFindMissingScanFields. */
export type EditorHandle = {
  seq: number;
  save: (opts: { auto?: boolean }) => Promise<void>;
  draft: () => Draft;
  applyDraft: (d: Draft) => void;
  findMissing: () => Promise<void>;
  progress: (label: string, pct: number) => void;
};
export type Draft = { vals: Partial<WorkerForm>; children: Child[]; clientIds: string[]; sig: string | null };
export const editor: { current: EditorHandle | null } = { current: null };

function Field({ label, children, className, hint }: { label: React.ReactNode; children: React.ReactNode; className?: string; hint?: React.ReactNode }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <Label>{label}</Label>
      {children}
      {hint}
    </div>
  );
}

function Hint({ children, tone = 'warn' }: { children: React.ReactNode; tone?: 'warn' | 'bad' | 'ok' | 'muted' }) {
  return <div className={cn('text-[11px]', tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : tone === 'ok' ? 'text-ok' : 'text-ink-3')}>{children}</div>;
}

/** A select with "— not chosen —" as its empty choice (Radix has no '' item). */
function Choice({ id, value, onChange, opts, empty, className, onPointerDown, mark }: {
  id: string; value: string; onChange: (v: string) => void; opts: [string, string][]; empty?: string; className?: string;
  onPointerDown?: (e: React.PointerEvent) => void; mark?: string;
}) {
  return (
    <Select value={value || NONE} onValueChange={v => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} data-value={value} data-scan={mark} className={cn('w-full', className)} onPointerDown={onPointerDown}><SelectValue /></SelectTrigger>
      <SelectContent>
        {empty != null && <SelectItem value={NONE}>{empty}</SelectItem>}
        {opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** 2–4 choices as a segmented switch (the old select[data-seg]); a chosen value is not cleared by a second tap. */
function Seg({ id, value, onChange, opts, mark, onPointerDown }: { id: string; value: string; onChange: (v: string) => void; opts: [string, string][]; mark?: string; onPointerDown?: (e: React.PointerEvent) => void }) {
  return (
    <ToggleGroup id={id} type="single" value={value} onValueChange={v => { if (v) onChange(v); }} data-value={value} data-scan={mark} onPointerDownCapture={onPointerDown}
      className={cn('flex-wrap', mark && markClass(mark))}>
      {opts.map(([v, l]) => <ToggleGroupItem key={v} value={v} data-v={v} dir="rtl" className="h-auto min-h-[31px] py-1">{l}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

const markClass = (k?: string) => k === 'found' ? '!border-ok shadow-[0_0_0_2px_rgba(34,197,94,.3)]'
  : k === 'busy' ? '!border-warn opacity-60' : k ? '!border-warn !bg-[rgba(245,166,35,.06)] shadow-[0_0_0_1px_rgba(245,166,35,.35)]' : '';

export function WorkerEditor({ props, info, api }: { props: EditorProps; info: EditorInfo; api: ManagerBridge }) {
  const { w, editId } = props;
  const editing = editId !== null;
  const docType = w.docType || 'israeli_id';
  const defaults = React.useMemo(() => {
    const f = formOf(w);
    if (f.supplierId && !info.suppliers.some(s => s.id === f.supplierId)) f.supplierId = '';
    return f;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const form = useForm<WorkerForm>({ defaultValues: defaults });
  const v = useWatch({ control: form.control }) as WorkerForm;
  const [clientIds, setClientIds] = React.useState<string[]>(() => (w.clientIds || []).filter(id => info.clients.some(c => c.id === id)));
  const [children, setChildren] = React.useState<Child[]>(() => (Array.isArray(w.docChildren) ? w.docChildren.map(c => ({ ...c })) : []));
  const [rosterOpen, setRosterOpen] = React.useState(false);
  const [roster, setRoster] = React.useState<DayShift[]>(() => [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = (w.schedule || [])[i];
    return { type: d?.type === 'off' ? 'off' : 'work', start: d?.start || '09:00', end: d?.end || '17:00' };
  }));
  const [expiryOpen, setExpiryOpen] = React.useState(false);
  const [spouseOpen, setSpouseOpen] = React.useState(false);
  const [kidsOpen, setKidsOpen] = React.useState(false);
  const [marks, setMarks] = React.useState<Record<string, Mark>>({});
  const [progress, setProgress] = React.useState<{ label: string; pct: number } | null>(null);
  const [draftSig, setDraftSig] = React.useState<string | null>(null);
  const [token, setToken] = React.useState(w.token || '');
  const sig = React.useRef<SignaturePadHandle>(null);
  const [open, setOpen] = React.useState<string[]>(() => (w.__scanCheck?.length || !editing ? ['person'] : []));
  const hasScan = info.hasScan;
  // A closed section keeps its fields in the page (hidden), so every save and search reads them all.
  const body = (k: string) => ({ forceMount: true as const, hidden: !open.includes(k) });
  const markRef = React.useRef(marks); markRef.current = marks;

  const setMark = (key: string, m: Mark | null) => setMarks(cur => { const n = { ...cur }; if (m) n[key] = m; else delete n[key]; return n; });
  const flashFound = (key: string) => { setMark(key, { k: 'found' }); window.setTimeout(() => setMarks(cur => (cur[key]?.k === 'found' ? (({ [key]: _, ...rest }) => rest)(cur) : cur)), 2500); };
  const set = (key: FormKey, val: string) => form.setValue(key, val as never, { shouldDirty: true });

  // Every scan field still empty is framed when the worker has a scan to search.
  const markMissing = React.useCallback(() => {
    const isId = docType !== 'passport', vals = form.getValues() as unknown as Record<string, string>;
    setMarks(cur => {
      const n: Record<string, Mark> = {};
      for (const [k, m] of Object.entries(cur)) if (m.k === 'check' || m.k === 'found') n[k] = m;
      if (hasScan) for (const [key, f] of Object.entries(SCAN_FIELDS)) {
        if ((f.idOnly && !isId) || String(vals[key] || '').trim()) continue;
        n[key] = { k: 'missing' };
      }
      return n;
    });
  }, [docType, hasScan, form]);

  const checkMsg = (key: string) => (SCAN_FIELDS[key] && hasScan
    ? tr('Check — the two reads of the scan differ. Tap the field to read it again') : tr('Check — the two reads of the scan differ'));
  const markUncertain = (keys: string[] | undefined) => {
    const vals = form.getValues() as unknown as Record<string, string>;
    setMarks(cur => {
      const n = { ...cur };
      for (const k of keys || []) {
        if (!(k in SCAN_FIELDS) && k !== 'docExpiry') continue;
        if (!String(vals[k] || '').trim() || n[k]?.k === 'check') continue;
        n[k] = { k: 'check', msg: checkMsg(k) };
      }
      return n;
    });
  };

  React.useLayoutEffect(() => {
    markMissing(); markUncertain(w.__scanCheck);
    // A section with a scan field left empty opens by itself.
    if (!hasScan) return;
    const vals = form.getValues() as unknown as Record<string, string>, isId = docType !== 'passport', secs = new Set<string>();
    for (const [k, f] of Object.entries(SCAN_FIELDS)) if ((isId || !f.idOnly) && !String(vals[k] || '').trim()) secs.add(f.page === 'sefach' ? 'address' : 'person');
    if (secs.size) setOpen(o => [...new Set([...o, ...secs])]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A search of several empty fields in one request (`findScanFields`).
  const search = async (keys: string[]) => {
    const vals = form.getValues() as unknown as Record<string, string>;
    keys = keys.filter(k => {
      const m = markRef.current[k];
      if (!m || m.k !== 'missing') return false;
      if (String(vals[k] || '').trim()) { setMark(k, null); return false; }
      return true;
    });
    if (!keys.length) return;
    setMarks(cur => { const n = { ...cur }; keys.forEach(k => { n[k] = { k: 'busy' }; }); return n; });
    let res: Record<string, ScanHit> | null = null;
    try { res = await api.findScanFields(editId, keys, docType); } catch (e) { console.error(e); }
    if (editor.current?.seq !== props.seq) return; // the window was closed or opened again meanwhile
    for (const k of keys) {
      const r = res && res[k];
      if (r && r.value) {
        set(k as FormKey, r.value);
        if (r.unsure) setMark(k, { k: 'check', msg: checkMsg(k) }); else flashFound(k);
      } else setMark(k, { k: 'none' });
    }
  };
  // Reads one "check" field again: the same value → the frame goes; another → put in, with before / after and Restore.
  const recheck = async (key: string, force = false) => {
    const m = markRef.current[key];
    if (!m || m.k !== 'check' || (m.rechecked && !force) || !SCAN_FIELDS[key] || !hasScan) return;
    const prev = String((form.getValues() as unknown as Record<string, string>)[key] || '').trim();
    setMark(key, { k: 'check', rechecked: true, msg: tr('Reading the scan again…') });
    let r: ScanHit | null | undefined = null;
    try { const res = await api.findScanFields(editId, [key], docType); r = res && res[key]; } catch (e) { console.error(e); }
    if (editor.current?.seq !== props.seq) return;
    if (!r || !r.value) { setMark(key, { k: 'check', rechecked: true, msg: tr('Check — the second read did not find the field') }); return; }
    if (norm(r.value) === norm(prev)) { flashFound(key); return; }
    set(key as FormKey, r.value);
    setMark(key, { k: 'check', rechecked: true, prev, msg: 'before-after' });
  };
  const restore = (key: string) => {
    const m = markRef.current[key];
    if (!m || m.prev == null) return;
    set(key as FormKey, m.prev); setMark(key, null);
  };
  const shown = (key: string, val: string) => key === 'docSex' ? SEX_LABELS[val] || '' : val;

  // A scan field: its frame, a tap that searches / reads again, typing clears the mark.
  const scanProps = (key: string) => {
    const m = marks[key];
    return {
      'data-scan': m?.k,
      className: markClass(m?.k),
      onClick: () => { if (m?.k === 'missing') search([key]); else if (m?.k === 'check') recheck(key); },
    };
  };
  const typed = (key: string, val: string) => {
    const m = markRef.current[key];
    if (!m || m.k === 'busy') return;
    if (m.k === 'check' || m.k === 'found' || String(val || '').trim()) setMark(key, null);
  };
  const text = (key: FormKey, opts: { label: React.ReactNode; placeholder?: string; inputMode?: 'numeric'; className?: string; hint?: React.ReactNode } ) => {
    const m = marks[key], sp = key in SCAN_FIELDS || key === 'docExpiry' ? scanProps(key) : null;
    const reg = form.register(key, { onChange: e => typed(key, e.target.value) });
    const ph = m && (m.k === 'missing' || m.k === 'none') ? (m.k === 'missing' ? '🔍 ' + tr('Tap to search the scan') : opts.placeholder) : m?.k === 'busy' ? tr('Searching the scan…') : opts.placeholder;
    return (
      <Field label={opts.label} className={opts.className} hint={<>{opts.hint}<ScanHint k={key} m={m} /></>}>
        <Input id={INPUT_ID[key]} dir="auto" autoComplete="off" inputMode={opts.inputMode} placeholder={ph} readOnly={m?.k === 'busy'}
          {...reg} {...(sp || {})} className={cn(sp?.className)} />
      </Field>
    );
  };
  function ScanHint({ k, m }: { k: string; m?: Mark }) {
    if (!m || (m.k !== 'none' && m.k !== 'check')) return null;
    let body: React.ReactNode;
    if (m.k === 'none') body = <>{tr('Not found in the scan')} — <a href="#" className="underline" onClick={e => { e.preventDefault(); api.rescan(); }}>{tr('photograph the page again')}</a> {tr('or type it in')}</>;
    else if (m.msg === 'before-after') {
      body = <>{tr('Check — before: {0} · after: {1}', { 0: shown(k, m.prev || ''), 1: shown(k, String((form.getValues() as unknown as Record<string, string>)[k] || '')) })} · <a href="#" className="underline" onClick={e => { e.preventDefault(); restore(k); }}>{tr('Restore')}</a></>;
    } else {
      const again = SCAN_FIELDS[k] && hasScan;
      body = <>{m.msg}{again && <> · <a href="#" className="whitespace-nowrap underline" onClick={e => { e.preventDefault(); recheck(k, true); }}>🔍 {tr('Read it again from the scan')}</a></>}</>;
    }
    return <div data-testid="scan-hint" data-for={k} data-k={m.k}><Hint>{body}</Hint></div>;
  }
  const choiceMark = (key: string) => marks[key]?.k;
  const choicePointer = (key: string) => (e: React.PointerEvent) => {
    const m = markRef.current[key];
    if (m?.k === 'missing' && !String((form.getValues() as unknown as Record<string, string>)[key] || '').trim()) { e.preventDefault(); search([key]); }
    else if (m?.k === 'check' && !m.rechecked) { e.preventDefault(); recheck(key); }
  };
  const pick = (key: FormKey) => (val: string) => { set(key, val); typed(key, val); };

  // ── the handle the page drives (saveWorker, the rescan draft, the second pass after a scan, the upload progress) ──
  const state = (): EditorState => ({
    values: form.getValues(), clientIds, children, roster: rosterOpen ? roster : null, sig: sig.current?.image() || null,
  });
  const handle: EditorHandle = {
    seq: props.seq,
    save: opts => saveWorker(api, { w, editId, docType, state: state(), auto: !!opts.auto, focusName: () => document.getElementById('wGiven')?.focus(), progress: (label, pct) => setProgress({ label, pct }) }),
    draft: () => ({ vals: form.getValues(), children: children.map(c => ({ ...c })), clientIds: [...clientIds], sig: sig.current?.image() || null }),
    applyDraft: d => {
      for (const [k, val] of Object.entries(d.vals)) {
        if (typeof val === 'boolean') { form.setValue(k as FormKey, val as never); continue; }
        if (val !== '' && val != null) { set(k as FormKey, String(val)); setMarks(cur => (cur[k]?.k === 'check' ? (({ [k]: _, ...rest }) => rest)(cur) : cur)); }
      }
      if (d.children.length) setChildren(d.children);
      if (d.clientIds.length) setClientIds(d.clientIds.filter(id => info.clients.some(c => c.id === id)));
      if (d.sig) setDraftSig(d.sig);
      window.setTimeout(markMissing, 0);
    },
    findMissing: async () => {
      // Street / house number / city wait when the live scan has no page besides the front (no ספח to find them on).
      const keys = Object.entries(markRef.current).filter(([k, m]) => m.k === 'missing' && !(info.liveOthers === 0 && SCAN_FIELDS[k]?.page === 'sefach')).map(([k]) => k);
      await search(keys);
    },
    progress: (label, pct) => setProgress({ label, pct }),
  };
  editor.current = handle;
  React.useEffect(() => () => { if (editor.current?.seq === props.seq) editor.current = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (progress) {
    return (
      <div className="grid gap-3 px-4 py-8 text-center text-sm text-ink-2" data-testid="worker-uploading">
        <IconLoader2 className="mx-auto size-6 animate-spin" />
        <span>{progress.label} ({progress.pct}%)</span>
        <Progress value={progress.pct} />
      </div>
    );
  }

  // ── section summaries and colours (the old ogSecSummary) ──
  const summary = (vals: (string | undefined)[]) => vals.filter(Boolean).slice(0, 3).map(s => (s!.length > 32 ? s!.slice(0, 30) + '…' : s)).join(' · ') || tr('Not filled in');
  const missingIn = (keys: string[]) => keys.some(k => marks[k] && marks[k].k !== 'found');
  const colorOf = (keys: string[], vals: (string | undefined)[]) => missingIn(keys) ? 'var(--warn)' : vals.some(Boolean) ? 'var(--ok)' : 'var(--neutral)';
  const personVals = [v.docGiven, v.docSurname, v.docId, v.docExpiry, SEX_LABELS[v.docSex], MARITAL_LABELS[v.maritalStatus], HEALTH_FUND_LABELS[v.healthFund], v.docDob, v.phone];
  const addrVals = [v.address, v.houseNumber, v.city];
  const clientName = (id: string) => info.clients.find(c => c.id === id)?.name;
  const workVals = [...clientIds.map(clientName), info.suppliers.find(s => s.id === v.supplierId)?.name, fmtDMY(v.startDate), v.notes];
  const f101Vals = [INCOME_LABELS[v.incomeType], OTHER_INCOME_LABELS[v.otherIncomeType], v.spouseGiven, v.spouseSurname];
  const geo = clientIds.map(id => info.clients.find(c => c.id === id)).find(c => c && c.lat && c.lng);
  const spouseFilled = [v.spouseSurname, v.spouseGiven, v.spouseId, v.spouseDob].some(x => String(x || '').trim());
  const kidsN = children.filter(c => (c.name || c.idNo || c.dob || '').trim()).length;
  const docColor = { ok: 'var(--ok)', warn: 'var(--warn)', error: 'var(--bad)' }[info.docLevel];
  const addClient = (id: string) => { if (id && !clientIds.includes(id)) setClientIds([...clientIds, id]); };
  const left = info.clients.filter(c => !clientIds.includes(c.id));
  const docs = [...(w.docs || [])].sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));

  return (
    <div data-testid="worker-editor" data-edit={editId || ''} className="grid gap-2">
      <div className="mb-1 flex flex-wrap items-center gap-3" id="wAvatarWrap" style={{ ['--c' as string]: editing ? info.color : 'var(--neutral)' }}>
        <div className="grid size-12 shrink-0 place-items-center rounded-full text-base font-bold text-ink" style={{ background: 'color-mix(in srgb, var(--c) 34%, rgba(var(--tint),.06))', boxShadow: '0 0 0 2px var(--c)' }}>
          {initials(w.name || '?')}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-lg font-bold text-ink" data-testid="editor-title">{w.name || (editing ? tr('Edit Worker') : tr('Add Worker'))}</h4>
          {editing && <p className="text-[13px] text-ink-2"><Line parts={[info.site && <span key="s" className="text-ink">{info.site}</span>, <TodayPin key="p" w={info} />, <span key="h" className="font-mono text-fig">{hoursShort(info.monthHours)}</span>]} /></p>}
        </div>
        {editing && <Button size="icon" title={tr('Scan')} aria-label={tr('Scan')} data-testid="editor-scan" onClick={() => api.rescan()}><IconScan className="size-[18px]" /></Button>}
        {editing && info.notices.length > 0 && <div className="flex basis-full flex-wrap gap-1.5"><NoticeChipsAll notices={info.notices} /></div>}
      </div>

      <Accordion type="multiple" value={open} onValueChange={setOpen}>
        <AccordionItem value="person" data-sec="person" color={colorOf(['docGiven', 'docSurname', 'docId', 'docDob', 'docSex', 'docExpiry'], personVals)}>
          <AccordionTrigger icon={<IconUser />} summary={summary(personVals)}>{tr('Person')}</AccordionTrigger>
          <AccordionContent {...body('person')} className="grid gap-2.5">
            <FieldRow>
              {text('docGiven', { label: 'שם פרטי', placeholder: 'שם פרטי' })}
              {text('docSurname', { label: 'שם משפחה', placeholder: 'שם משפחה' })}
            </FieldRow>
            <FieldRow>
              {text('docId', { label: 'מספר ת.ז./דרכון', placeholder: 'ת.ז. / דרכון', hint: <>
                {w.idChecksumOk === false && <Hint><IconAlertTriangle className="inline size-3" /> {tr('The number failed the check digit test — check it by hand')}</Hint>}
              </> })}
              {text('docExpiry', { label: 'תוקף ת.ז./דרכון', placeholder: tr('DD/MM/YYYY') })}
            </FieldRow>
            <Field label="מין" hint={<ScanHint k="docSex" m={marks.docSex} />}>
              <Seg id="wSex" value={v.docSex} onChange={pick('docSex')} opts={Object.entries(SEX_LABELS)} mark={choiceMark('docSex')} onPointerDown={choicePointer('docSex')} />
            </Field>
            <FieldRow>
              <Field label="מצב משפחתי">
                <Choice id="wMaritalStatus" value={v.maritalStatus} empty="— לא נבחר —" opts={Object.entries(MARITAL_LABELS)}
                  onChange={val => { set('maritalStatus', val); if (val === 'marital_married') { setSpouseOpen(true); setOpen(o => (o.includes('form101') ? o : [...o, 'form101'])); } }} />
              </Field>
              <Field label="קופת חולים">
                <Choice id="wHealthFund" value={v.healthFund} empty="— לא נבחר —" opts={Object.entries(HEALTH_FUND_LABELS)} onChange={val => set('healthFund', val)} />
              </Field>
            </FieldRow>
            <FieldRow>
              {text('docDob', { label: 'תאריך לידה', placeholder: tr('DD/MM/YYYY') })}
              {text('phone', { label: 'טלפון', placeholder: '+972...' })}
            </FieldRow>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="address" data-sec="address" color={colorOf(['address', 'houseNumber', 'city'], addrVals)}>
          <AccordionTrigger icon={<IconHome />} summary={summary(addrVals)}>{tr('Address')}</AccordionTrigger>
          <AccordionContent {...body('address')}>
            <div className="grid grid-cols-[1.6fr_.8fr_1.3fr] gap-2.5 [&>*]:min-w-0">
              {text('address', { label: 'רחוב', placeholder: 'רחוב' })}
              {text('houseNumber', { label: 'מספר בית', placeholder: 'מס׳' })}
              {text('city', { label: 'עיר', placeholder: 'עיר' })}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="work" data-sec="work" color={colorOf([], workVals)}>
          <AccordionTrigger icon={<IconBriefcase />} summary={summary(workVals)}>{tr('Work')}</AccordionTrigger>
          <AccordionContent {...body('work')} className="grid gap-2.5">
            <Field label={<><IconUsers className="size-3.5" />{tr('Clients')} {clientIds.length > 0 && <span className="text-ink-3">({clientIds.length})</span>}</>}>
              {clientIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5" data-testid="editor-clients">
                  {clientIds.map(id => { const c = info.clients.find(x => x.id === id)!; return (
                    <span key={id} data-client={id} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/15 bg-white/[.06] py-1 pl-2.5 pr-1.5 text-xs">
                      <i className="size-2 shrink-0 rounded-full" style={{ background: c.color }} />
                      <span className="truncate">{c.name}{c.object && <span className="text-ink-3"> · {c.object}</span>}</span>
                      <button type="button" title={tr('Remove')} aria-label={tr('Remove')} className="text-ink-3" onClick={() => setClientIds(clientIds.filter(x => x !== id))}><IconX className="size-3.5" /></button>
                    </span>
                  ); })}
                </div>
              )}
              {info.clients.length
                ? <Combobox id="wClientSearch" options={left.map(c => ({ value: c.id, label: c.name, hint: c.object }))} value="" onChange={addClient}
                    placeholder={tr('Tap to add a client')} emptyText={left.length ? tr('Not found') : tr('All clients added')} />
                : <span className="text-xs text-ink-3">{tr('No clients yet')}</span>}
            </Field>
            <div className={cn(info.isFirmAdmin && 'grid grid-cols-2 gap-2.5 [&>*]:min-w-0')}>
              <Field label={<><IconTruckDelivery className="size-3.5" />{tr('Supplier')}</>}>
                <Choice id="wSupplierId" value={v.supplierId} empty={tr('— None —')} opts={info.suppliers.map(s => [s.id, s.name])} onChange={val => set('supplierId', val)} />
              </Field>
              {info.isFirmAdmin && (
                <Field label={<><IconUserShield className="size-3.5" />{tr('HR')}</>}>
                  <Choice id="wHrId" value={v.hrId} empty={tr('— None —')} onChange={val => set('hrId', val)}
                    opts={[...info.hrUsers.map(u => [u.id, u.name] as [string, string]), ...(v.hrId && !info.hrUsers.some(u => u.id === v.hrId) ? [[v.hrId, tr('(unknown HR)')] as [string, string]] : [])]} />
                </Field>
              )}
            </div>
            <Field label="תאריך תחילת עבודה">
              <DatePicker id="wStartDate" value={v.startDate} onChange={val => set('startDate', val)} />
            </Field>
            <div>
              <Button size="sm" className="w-full justify-between" data-testid="editor-roster-btn" aria-expanded={rosterOpen} onClick={() => setRosterOpen(!rosterOpen)}>
                <span className="inline-flex items-center gap-1.5"><IconCalendar className="size-4" />{tr('Weekly schedule')}</span>{rosterOpen ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
              </Button>
              {!rosterOpen && <Hint tone="muted">{editing ? tr('The schedule does not change while it stays closed.') : tr('Left closed, the worker is added with no shifts.')}</Hint>}
              {rosterOpen && (
                <div className="mt-2 grid gap-1.5" data-testid="editor-roster">
                  {roster.map((d, i) => (
                    <div key={i} className="grid grid-cols-[48px_1fr_1fr_1fr] items-center gap-1.5">
                      <span className="text-center text-[11px] leading-tight text-ink-2">{tr(DAYS_EN[i])}<br /><span className="text-info">{DAYS_HE[i]}</span></span>
                      <Choice id={'wt' + i} value={d.type} opts={[['work', tr('Work')], ['off', tr('Day off')]]}
                        onChange={val => setRoster(r => r.map((x, j) => (j === i ? { ...x, type: val as 'work' | 'off' } : x)))} />
                      <Input type="time" id={'ws' + i} value={d.start || ''} disabled={d.type === 'off'} className={cn(d.type === 'off' && 'opacity-30')}
                        onChange={e => setRoster(r => r.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      <Input type="time" id={'we' + i} value={d.end || ''} disabled={d.type === 'off'} className={cn(d.type === 'off' && 'opacity-30')}
                        onChange={e => setRoster(r => r.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Button size="sm" className="w-full justify-between" data-testid="editor-expiry-btn" aria-expanded={expiryOpen}
                onClick={() => { const o = !expiryOpen; setExpiryOpen(o); if (o) form.setValue('expiryEnabled', true); }}>
                <span className="inline-flex items-center gap-1.5"><IconAlertTriangle className="size-4" />{tr('Contract expiry warning')}</span>{expiryOpen ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
              </Button>
              {expiryOpen && (
                <div className="mt-2 grid gap-2">
                  <FieldRow>
                    <Field label={tr('Months until the deadline')}><Input type="number" min={1} step={1} id="wExpiryMonths" {...form.register('expiryMonths')} /></Field>
                    <Field label={tr('Warn how many months ahead')}><Input type="number" min={0} step={1} id="wExpiryWarnMonths" {...form.register('expiryWarnMonths')} /></Field>
                  </FieldRow>
                  {v.expiryEnabled && !v.startDate && <Hint tone="bad"><IconAlertTriangle className="inline size-3" /> {tr('No start date — the warning does not work without it.')}</Hint>}
                </div>
              )}
            </div>
            <Field label={tr('Notes')}><Textarea id="wNotes" placeholder={tr('Notes about the worker')} className="min-h-14" {...form.register('notes')} /></Field>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="documents" data-sec="documents" color={editing ? docColor : 'var(--neutral)'}>
          <AccordionTrigger icon={<IconFiles />} summary={editing ? info.docLines[0] || tr('Complete') : tr('Not filled in')}
            badge={editing && info.docProblems > 0 ? <Badge variant={info.docLevel === 'error' ? 'bad' : 'warn'}>{info.docLevel === 'error' ? <IconAlertTriangle /> : <IconAlertCircle />}{info.docProblems}</Badge> : undefined}>
            {tr('Documents')}
          </AccordionTrigger>
          <AccordionContent {...body('documents')} className="grid gap-1.5">
            {editing ? <>
              <DocLine color={info.docMissing.length ? 'var(--warn)' : 'var(--ok)'} icon={<IconId />} title={tr('ID / Passport')} sub={info.docExpiryText || v.docId}
                act={info.docMissing.length || info.docFailed ? <Button size="sm" onClick={() => api.rescan()}>{tr('Upload')}</Button> : null} />
              <DocLine color={w.docUrl ? 'var(--ok)' : 'var(--warn)'} icon={<IconFileText />} title={tr('Form 101')} sub={w.docUrl ? tr('Saved') : tr('Not saved yet')} />
              {docs.map(d => { const x = info.docExpiry[String(d.id)];
                return <DocLine key={d.id} color={x ? (x.level === 'error' ? 'var(--bad)' : 'var(--warn)') : 'var(--ok)'} icon={d.type === 'contract' ? <IconFileCertificate /> : <IconIdBadge2 />}
                  title={tr(WORKER_DOC_TYPES[d.type] || 'Document')} sub={x ? x.text : d.expiry ? tr('Expires {0}', { 0: fmtDMY(d.expiry) }) : d.name || ''}
                  act={x ? <Button size="sm" onClick={() => api.openDocUpload(w.id)}>{tr('Renew')}</Button> : null} />; })}
              <Button className="mt-1 justify-self-start" onClick={() => api.openDocUpload(w.id)}><IconUpload className="size-4" />{tr('Add document')}</Button>
            </> : <div className="text-[13px] text-ink-2">{tr('Documents are added on the worker card after the worker is saved.')}</div>}
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="form101" data-sec="form101" color={colorOf([], f101Vals)}>
          <AccordionTrigger icon={<IconIdBadge2 />} summary={summary(f101Vals)} badge={editing && !w.docUrl ? <Badge variant="warn"><IconAlertCircle />{tr('Sign')}</Badge> : undefined}>{tr('Form 101')}</AccordionTrigger>
          <AccordionContent {...body('form101')} className="grid gap-2.5">
            <div className="grid gap-2.5 min-[480px]:grid-cols-2 [&>*]:min-w-0">
              <Field label="סוג הכנסה (טופס 101)"><Choice id="wIncomeType" value={v.incomeType} opts={Object.entries(INCOME_LABELS)} onChange={val => set('incomeType', val)} /></Field>
              <Field label="הכנסה נוספת (טופס 101)"><Choice id="wOtherIncomeType" value={v.otherIncomeType} opts={Object.entries(OTHER_INCOME_LABELS)} onChange={val => set('otherIncomeType', val)} /></Field>
            </div>
            <Hint tone="muted">{w.docUrl ? tr('Changing these fields (or the address, city or income type above) updates the document saved in {0} by itself.', { 0: 'Firebase Storage' }) : tr('The Form 101 PDF is built by itself when the worker is saved.')}</Hint>
            <FieldRow>
              <Button size="sm" className="justify-between" aria-expanded={spouseOpen} data-testid="editor-spouse-btn" onClick={() => setSpouseOpen(!spouseOpen)}>
                <span className="inline-flex items-center gap-1.5" dir="rtl"><IconHeart className="size-4" />בן/בת הזוג{spouseFilled ? ' ✓' : ''}</span>{spouseOpen ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
              </Button>
              <Button size="sm" className="justify-between" aria-expanded={kidsOpen} data-testid="editor-kids-btn" onClick={() => setKidsOpen(!kidsOpen)}>
                <span className="inline-flex items-center gap-1.5" dir="rtl"><IconMoodKid className="size-4" />ילדים{kidsN ? ` (${kidsN})` : ''}</span>{kidsOpen ? <IconChevronUp className="size-4" /> : <IconChevronDown className="size-4" />}
              </Button>
            </FieldRow>
            <div className={cn('grid gap-2.5 rounded-[12px] border border-white/12 p-3', !spouseOpen && 'hidden')} data-testid="editor-spouse">
              <b className="flex items-center gap-1.5 text-[13px]" dir="rtl"><IconHeart className="size-4" />פרטי בן/בת הזוג</b>
              <FieldRow>{text('spouseSurname', { label: 'שם משפחה' })}{text('spouseGiven', { label: 'שם פרטי' })}</FieldRow>
              <FieldRow>{text('spouseId', { label: 'מספר זהות / דרכון', inputMode: 'numeric' })}{text('spouseDob', { label: 'תאריך לידה', placeholder: tr('DD/MM/YYYY') })}</FieldRow>
              <Field label="הכנסת בן/בת הזוג"><Seg id="wSpouseIncome" value={v.spouseIncome} onChange={val => set('spouseIncome', val)} opts={Object.entries(SPOUSE_INCOME_LABELS)} /></Field>
            </div>
            <div className={cn('grid gap-2 rounded-[12px] border border-white/12 p-3', !kidsOpen && 'hidden')} data-testid="editor-kids">
              <b className="flex items-center gap-1.5 text-[13px]" dir="rtl"><IconMoodKid className="size-4" />ילדים (ספח)</b>
              {children.map((c, i) => {
                const upd = (k: keyof Child) => (e: React.ChangeEvent<HTMLInputElement>) => setChildren(list => list.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
                return (
                  <div key={i} className="grid gap-1.5" data-testid="editor-child">
                    <Field label="שם הילד/ה"><Input dir="auto" value={c.name || ''} onChange={upd('name')} /></Field>
                    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 [&>*]:min-w-0">
                      <Field label="ת.ז. / דרכון"><Input value={c.idNo || ''} onChange={upd('idNo')} /></Field>
                      <Field label="תאריך לידה"><Input placeholder={tr('DD/MM/YYYY')} value={c.dob || ''} onChange={upd('dob')} /></Field>
                      <Button size="icon-sm" title="הסר" aria-label="הסר" onClick={() => setChildren(list => list.filter((_, j) => j !== i))}><IconTrash className="size-4" /></Button>
                    </div>
                  </div>
                );
              })}
              <Button size="sm" className="justify-self-start" dir="rtl" data-testid="editor-add-child" onClick={() => setChildren([...children, { name: '', idNo: '', dob: '' }])}><IconPlus className="size-4" />הוסף ילד/ה</Button>
            </div>
            <Field label="חתימה">
              <SignaturePad ref={sig} initial={draftSig} className="max-w-[420px]" />
            </Field>
          </AccordionContent>
        </AccordionItem>

        {editing && (
          <AccordionItem value="access" data-sec="access" color={token ? 'var(--ok)' : 'var(--neutral)'}>
            <AccordionTrigger icon={<IconKey />} summary={token ? tr('Punch link on') : tr('No punch link yet')}>{tr('Access')}</AccordionTrigger>
            <AccordionContent {...body('access')} className="grid gap-2">
              {token && (
                <Field label={<><IconLink className="size-3.5" />{tr('Personal punch link')}</>}>
                  <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-white/[.05] px-3 py-2.5">
                    <code className="min-w-0 flex-1 break-all text-[11px] text-[var(--blue-text)]" data-testid="editor-link">{info.punchLink.replace(/t=.*$/, 't=' + token)}</code>
                    <Button size="sm" onClick={() => api.copyLink(w.id)}><IconClipboardText className="size-4" />{tr('Copy')}</Button>
                  </div>
                  {geo ? <Hint tone="ok"><IconMapPin className="inline size-3" /> {tr('Geofence: {0} · {1}m', { 0: geo.name, 1: geo.radius || 100 })}</Hint>
                    : <Hint><IconAlertTriangle className="inline size-3" /> {tr('The linked client has no location — the punch is not checked by location')}</Hint>}
                  <Hint tone="muted">{tr('Send the link to the worker. They keep it as a bookmark.')}</Hint>
                </Field>
              )}
              <Button className="justify-self-start" data-testid="editor-new-token" onClick={() => { const t = api.newToken(w.id); if (t) setToken(t); }}><IconRefresh className="size-4" />{tr('New token')}</Button>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-ink-3" data-testid="editor-note">
        <IconDeviceFloppy className="size-3.5" />{tr(editing ? 'Changes are saved when the window closes' : 'The worker is created when the window closes')}
      </div>
    </div>
  );
}

function DocLine({ color, icon, title, sub, act }: { color: string; icon: React.ReactNode; title: string; sub?: string; act?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] bg-white/[.04] px-3 py-2" style={{ boxShadow: `inset 3px 0 0 ${color}` }} data-testid="editor-doc">
      <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] [&_svg]:size-[17px]" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>{icon}</span>
      <div className="min-w-0 flex-1"><b className="block text-sm font-semibold">{title}</b><small className="block truncate text-xs text-ink-2">{sub}</small></div>
      {act}
    </div>
  );
}
