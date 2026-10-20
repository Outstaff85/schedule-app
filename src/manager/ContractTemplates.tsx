// Admin → Contract templates (docs/contracts.md → Contract templates, D2): the firm's contract
// templates — a plate per template (its category and Default, size, date added, how many signed
// it), a tap opens its sample filled with made-up data, ✎ / ⋮ Edit renames it, ⋮ changes its category, makes
// it the category's default, replaces its file (a new version) or deletes it (the Undo snack).
// New template: a PDF is made light on the server, its marks listed, a page that is a picture
// gets its marks placed by hand, and the admin saves it after seeing the sample. The same window
// uploads a worker's own template from the worker window (`workerId`).
import * as React from 'react';
import {
  IconAlertTriangle, IconFileText, IconLoader2, IconPlus, IconRefresh, IconStar, IconTag, IconEye, IconX,
} from '@tabler/icons-react';
import { tr, uiLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FieldRow } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Window } from '@/components/shared/window';
import { Plate } from '@/components/shared/plate';
import { Section } from '@/components/shared/section';
import { PagedList } from '@/components/shared/paged-list';
import { undoDelete } from '@/components/shared/undo';
import { Field } from './ClientEditor';
import { readFileB64 } from './logic/uploads';
import {
  MARKS, TEMPLATE_ACCEPT, deleteTemplate, isWordFile, listTemplates, openPdf, prepareTemplate, sampleTemplate, saveTemplate, sizeText, templateFile, updateTemplate,
  type ContractTemplate, type Placed, type Prepared,
} from './contracts';

type Api = { toast: (msg: string, ms?: number) => void };
const hidden = new Set<string>();

/** The firm's templates, loaded once per pane (and again after a change). */
function useTemplates(workerId?: string) {
  const [list, setList] = React.useState<ContractTemplate[] | null>(null);
  const [error, setError] = React.useState('');
  const load = React.useCallback(() => {
    listTemplates(workerId).then(r => { setList(r.templates); setError(''); }, e => setError(String(e?.message || e)));
  }, [workerId]);
  React.useEffect(load, [load]);
  return { list, error, load, setList };
}

const dateText = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(uiLocale()) : '');

type Pending = { key: string; name: string; error?: string };
/** Several files at once (D7): each is its own call, all sent at once; a ready one is saved as it is and the list
 * read again (a toast says so); a failed one stays as a red line with its reason (the server writes Admin → Errors). */
function prepareInBackground(files: File[], api: Api, setPending: React.Dispatch<React.SetStateAction<Pending[]>>, load: () => void) {
  const items = files.map(f => ({ key: f.name + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6), name: f.name.replace(/\.(pdf|docx)$/i, ''), file: f }));
  setPending(list => [...list, ...items.map(({ key, name }) => ({ key, name }))]);
  void Promise.all(items.map(async it => {
    try {
      const p = await prepareTemplate(await readFileB64(it.file), it.file.name, isWordFile(it.file));
      await saveTemplate({ pdfBase64: p.lightBase64, name: it.name, origSize: p.origSize });
      setPending(list => list.filter(x => x.key !== it.key));
      api.toast(tr('Template ready: {0} ({1} → {2})', { 0: it.name, 1: sizeText(p.origSize), 2: sizeText(p.lightSize) }));
      load();
    } catch (e: any) {
      setPending(list => list.map(x => (x.key === it.key ? { ...x, error: String(e?.message || e) } : x)));
    }
  }));
}

export function ContractTemplatesPane({ api }: { api: Api }) {
  const { list, error, load } = useTemplates();
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [upload, setUpload] = React.useState<{ file: File; replace?: ContractTemplate } | null>(null);
  const [edit, setEdit] = React.useState<{ t: ContractTemplate; what: 'name' | 'category' } | null>(null);
  const pick = React.useRef<HTMLInputElement>(null);
  const replaceFor = React.useRef<ContractTemplate | null>(null);
  const [pending, setPending] = React.useState<Pending[]>([]);
  if (error && !list) return <p className="text-[13px] text-bad" data-testid="contracts-error">{tr(error)}</p>;
  if (!list) return <div className="grid gap-2" aria-busy="true" data-testid="contracts-loading">{[0, 1].map(i => <Skeleton key={i} className="h-[62px]" />)}</div>;
  const firm = list.filter(t => !t.workerId && !hidden.has(t.id));
  const categories = [...new Set(firm.map(t => t.category || ''))].filter(Boolean).sort();

  const remove = (t: ContractTemplate) => {
    hidden.add(t.id); redraw();
    undoDelete(t.name,
      () => { deleteTemplate(t.id).then(load, e => api.toast(tr(String(e?.message || e)))).finally(() => { hidden.delete(t.id); redraw(); }); },
      () => { hidden.delete(t.id); redraw(); });
  };
  const makeDefault = (t: ContractTemplate) => updateTemplate(t.id, { isDefault: true }).then(() => { load(); api.toast(tr('Default for its category')); },
    e => api.toast(tr(String(e?.message || e))));
  const sample = (t: ContractTemplate) => templateFile(t.id, true).then(r => openPdf(r.pdfBase64, t.name + '.pdf'), e => api.toast(tr(String(e?.message || e))));

  const row = (t: ContractTemplate) => (
    <Plate key={t.id} data-testid="contract-row" data-id={t.id} className="mb-1.5" color={t.isDefault ? 'var(--ok)' : 'var(--info)'}
      icon={<IconFileText />}
      title={<span>{t.name}{t.version && t.version > 1 ? <span className="text-[11px] font-normal text-ink-2"> v{t.version}</span> : null}</span>}
      chips={<>{t.category && <Badge variant="default" data-testid="contract-category">{t.category}</Badge>}
        {t.isDefault && <Badge variant="ok" data-testid="contract-default">{tr('Default')}</Badge>}</>}
      sub={<span className="grid whitespace-normal">
        <span>{[sizeText(t.size), dateText(t.createdAt), tr('{0} signed', { 0: t.signedCount || 0 })].join(' · ')}</span>
        {!!t.unknown?.length && <span className="inline-flex items-center gap-1 text-warn"><IconAlertTriangle className="size-3.5" />{tr('Unknown marks: {0}', { 0: t.unknown.join(', ') })}</span>}
      </span>}
      onOpen={() => sample(t)}
      onEdit={() => setEdit({ t, what: 'name' })}
      actions={[
        { label: tr('Category'), icon: <IconTag />, onSelect: () => setEdit({ t, what: 'category' }) },
        ...(t.isDefault ? [] : [{ label: tr('Make default'), icon: <IconStar />, onSelect: () => void makeDefault(t) }]),
        { label: tr('Replace file'), icon: <IconRefresh />, onSelect: () => { replaceFor.current = t; pick.current?.click(); } },
      ]}
      onDelete={() => remove(t)} />
  );
  return (
    <div data-testid="contracts">
      <Section label={<span className="inline-flex items-center gap-1.5"><IconFileText className="size-4" />{tr('Contract templates')}</span>} count={firm.length}
        tools={<Button variant="primary" size="sm" className="og-new" data-testid="contract-new" onClick={() => { replaceFor.current = null; pick.current?.click(); }}>
          <IconPlus className="size-4" />{tr('New template')}</Button>}>
        <input ref={pick} type="file" accept={TEMPLATE_ACCEPT} multiple className="hidden" data-testid="contract-file"
          onChange={e => {
            const files = [...(e.target.files || [])]; e.target.value = '';
            // one file: the upload window; several: each prepared and saved in the background (D7)
            if (files.length === 1) setUpload({ file: files[0], replace: replaceFor.current || undefined });
            else if (files.length > 1) prepareInBackground(files, api, setPending, load);
          }} />
        {pending.map(p => (
          <Plate key={p.key} data-testid="contract-pending" data-state={p.error ? 'error' : 'busy'} className="mb-1.5" color={p.error ? 'var(--bad)' : 'var(--neutral)'}
            icon={p.error ? <IconAlertTriangle /> : <IconLoader2 className="animate-spin" />} title={p.name}
            sub={p.error ? <span className="whitespace-normal text-bad">{tr(p.error)}</span> : tr('Preparing…')}
            onDelete={p.error ? () => setPending(list => list.filter(x => x.key !== p.key)) : undefined} />
        ))}
        <PagedList items={firm} render={row}
          empty={<Empty data-testid="contracts-empty"><EmptyMedia><IconFileText /></EmptyMedia><EmptyTitle>{tr('No contract templates yet. Save the contract from Word as PDF, with marks like {{given}}, and add it here.')}</EmptyTitle></Empty>} />
      </Section>
      {upload && <UploadWindow file={upload.file} replace={upload.replace} categories={categories} api={api}
        onClose={() => setUpload(null)} onSaved={() => { setUpload(null); load(); }} />}
      {edit && <EditWindow t={edit.t} what={edit.what} categories={categories} api={api} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

/** Rename a template, or give it another category. */
function EditWindow({ t, what, categories, api, onClose, onSaved }: {
  t: ContractTemplate; what: 'name' | 'category'; categories: string[]; api: Api; onClose: () => void; onSaved: () => void;
}) {
  const [val, setVal] = React.useState(what === 'name' ? t.name : t.category || '');
  const save = () => {
    if (what === 'name' && !val.trim()) { onClose(); return; }
    if (val === (what === 'name' ? t.name : t.category || '')) { onClose(); return; }
    updateTemplate(t.id, what === 'name' ? { name: val.trim() } : { category: val.trim() }).then(onSaved, e => { api.toast(tr(String(e?.message || e))); onClose(); });
  };
  return (
    <Window open onOpenChange={o => { if (!o) save(); }} title={what === 'name' ? tr('Rename') : tr('Category')}>
      <div className="grid gap-3 px-1 pb-2" data-testid="contract-edit">
        <Field label={what === 'name' ? tr('Name') : tr('Category')}>
          <Input autoFocus value={val} list="contractCategories" data-testid="contract-edit-input" onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); }} />
          <datalist id="contractCategories">{categories.map(c => <option key={c} value={c} />)}</datalist>
        </Field>
      </div>
    </Window>
  );
}

/** A new template (or a new version of one): made light on the server, its marks, the sample, the hand placing, Save. */
export function UploadWindow({ file, replace, categories, api, workerId, onClose, onSaved }: {
  file: File; replace?: ContractTemplate; categories: string[]; api: Api; workerId?: string;
  onClose: () => void; onSaved: (t: ContractTemplate) => void;
}) {
  const [prep, setPrep] = React.useState<Prepared | null>(null);
  const [err, setErr] = React.useState('');
  const [name, setName] = React.useState(replace ? replace.name : file.name.replace(/\.(pdf|docx)$/i, ''));
  const [category, setCategory] = React.useState(replace ? replace.category || '' : '');
  const [placed, setPlaced] = React.useState<Placed[]>(replace?.placed || []);
  const [sample, setSample] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    readFileB64(file).then(b64 => prepareTemplate(b64, file.name, isWordFile(file))).then(p => { if (live) { setPrep(p); setSample(p.sampleBase64); } },
      e => { if (live) setErr(String(e?.message || e)); });
    return () => { live = false; };
  }, [file]);
  const resample = (next: Placed[]) => {
    setPlaced(next);
    if (prep) sampleTemplate(prep.lightBase64, next).then(r => setSample(r.sampleBase64), () => {});
  };
  const save = async () => {
    if (!prep || busy) return;
    setBusy(true);
    try {
      const r = await saveTemplate({ pdfBase64: prep.lightBase64, name: name.trim() || file.name, category: category.trim(), placed, origSize: prep.origSize,
        ...(workerId ? { workerId } : {}), ...(replace ? { replaceId: replace.id } : {}) });
      api.toast(tr('Template saved'));
      onSaved(r.template);
    } catch (e: any) { api.toast(tr(String(e?.message || e))); setBusy(false); }
  };
  const marks = [...new Set([...(prep?.marks || []), ...placed.map(p => p.mark)])];
  return (
    <Window open wide onOpenChange={o => { if (!o) onClose(); }} title={replace ? tr('Replace file') : tr('New template')}
      description={file.name}
      footer={prep && <Button variant="primary" data-testid="contract-save" disabled={busy} onClick={save}>{busy ? <IconLoader2 className="size-4 animate-spin" /> : null}{tr('Save')}</Button>}>
      <div className="grid gap-3 px-1 pb-2" data-testid="contract-upload" data-state={err ? 'error' : prep ? 'ready' : 'busy'}>
        {!prep && !err && <p className="inline-flex items-center gap-2 text-sm text-ink-2"><IconLoader2 className="size-4 animate-spin" />{tr('Making the file light and finding its marks…')}</p>}
        {err && <p className="text-sm text-bad" data-testid="contract-upload-error">{tr(err)}</p>}
        {prep && <>
          <p className="text-sm" data-testid="contract-sizes">{tr('Made light: {0} → {1}', { 0: sizeText(prep.origSize), 1: sizeText(prep.lightSize) })}
            {prep.heavy && <span className="text-warn"> · {tr('still heavy')}</span>}</p>
          <FieldRow>
            <Field label={tr('Name')}><Input value={name} data-testid="contract-name" onChange={e => setName(e.target.value)} /></Field>
            {!workerId && <Field label={tr('Category')}>
              <Input value={category} list="contractUploadCategories" placeholder={tr('e.g. hourly')} data-testid="contract-category-input" onChange={e => setCategory(e.target.value)} />
              <datalist id="contractUploadCategories">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </Field>}
          </FieldRow>
          <div className="grid gap-1" data-testid="contract-marks">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">{tr('Marks found')}</p>
            <div className="flex flex-wrap gap-1">{marks.length ? marks.map(m => <Badge key={m} variant="default" data-mark={m}>{'{{' + m + '}}'}</Badge>)
              : <span className="text-sm text-warn">{tr('No marks found — place them by hand below, or type them in the file and save it as PDF from Word again.')}</span>}</div>
            {!!prep.unknown.length && <p className="text-sm text-warn" data-testid="contract-unknown">
              <IconAlertTriangle className="me-1 inline size-4" />{tr('Unknown marks (a typo?): {0}', { 0: prep.unknown.map(u => '{{' + u + '}}').join(', ') })}</p>}
          </div>
          {!!prep.pictures.length && <p className="text-sm text-warn" data-testid="contract-pictures">
            {tr('Pages {0} are pictures (a scan): their text can\'t be searched — tap where each value goes.', { 0: prep.pictures.map(i => i + 1).join(', ') })}</p>}
          <PlaceMarks pages={prep.pages} pictures={prep.pictures} placed={placed} onChange={resample} />
          <Button size="sm" className="self-start" data-testid="contract-sample" onClick={() => openPdf(sample, name + ' - sample.pdf')}>
            <IconEye className="size-4" />{tr('Open the sample')}</Button>
        </>}
      </div>
    </Window>
  );
}

/** The pages, small: a tap places the chosen mark there (PDF points from the page's top left). */
function PlaceMarks({ pages, pictures, placed, onChange }: { pages: Prepared['pages']; pictures: number[]; placed: Placed[]; onChange: (p: Placed[]) => void }) {
  const [all, setAll] = React.useState(false);
  const [mark, setMark] = React.useState<string>('given');
  const [width, setWidth] = React.useState('120');
  const shown = pages.map((p, i) => ({ ...p, i })).filter(p => all || pictures.includes(p.i));
  return (
    <div className="grid gap-2" data-testid="contract-place">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={tr('Mark to place')} className="min-w-40">
          <Select value={mark} onValueChange={setMark}>
            <SelectTrigger data-testid="contract-place-mark"><SelectValue /></SelectTrigger>
            <SelectContent>{MARKS.map(m => <SelectItem key={m} value={m}>{'{{' + m + '}}'}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label={tr('Width (pt)')} className="w-24"><Input type="number" min={20} max={500} value={width} data-testid="contract-place-width" onChange={e => setWidth(e.target.value)} /></Field>
        {!pictures.length || pictures.length < pages.length ? (
          <Button size="sm" data-testid="contract-place-all" onClick={() => setAll(!all)}>{all ? tr('Only the picture pages') : tr('Place a mark by hand')}</Button>
        ) : null}
      </div>
      {!!placed.length && <div className="flex flex-wrap gap-1" data-testid="contract-placed">
        {placed.map((p, j) => (
          <Badge key={j} variant="default" className="gap-1">{'{{' + p.mark + '}}'} · {tr('page {0}', { 0: p.page + 1 })}
            <button type="button" aria-label={tr('Remove')} onClick={() => onChange(placed.filter((_, k) => k !== j))}><IconX className="size-3" /></button></Badge>
        ))}
      </div>}
      <div className="grid gap-2 min-[701px]:grid-cols-2">
        {shown.map(p => (
          <div key={p.i} className="relative overflow-hidden rounded-lg border border-line bg-white" data-testid="contract-page" data-page={p.i}>
            <img src={'data:image/png;base64,' + p.png} alt={tr('page {0}', { 0: p.i + 1 })} className="block w-full cursor-crosshair"
              onClick={e => {
                const box = (e.target as HTMLImageElement).getBoundingClientRect();
                const k = p.w / box.width, h = 14, w = Math.max(20, Math.min(500, Number(width) || 120));
                const x = (e.clientX - box.left) * k, y = (e.clientY - box.top) * k;
                onChange([...placed, { mark, page: p.i, x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h, rtl: true }]);
              }} />
            {placed.filter(q => q.page === p.i).map((q, j) => (
              <span key={j} className={cn('pointer-events-none absolute border-2 border-accent bg-accent/15')}
                style={{ left: (100 * q.x) / p.w + '%', top: (100 * q.y) / p.h + '%', width: (100 * q.w) / p.w + '%', height: (100 * q.h) / p.h + '%' }} />
            ))}
            <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[11px] text-white">{p.i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

