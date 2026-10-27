// The worker window's Contract section (docs/contracts.md → The worker's contract, D2): the
// contract's category, the template this worker signs (the category's default unless another is
// picked for this worker alone), the worker's own terms that fill {{terms_1}}…{{terms_5}}, and a
// contract uploaded for this worker only (a template that belongs to the worker). The firm's
// templates are loaded when the section is first opened. A login that may change the firm's
// signature and stamp (canFirmSign) — a staff or HR login with the right sees no Admin — opens them here.
import * as React from 'react';
import { IconRubberStamp, IconUpload } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldRow } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TEMPLATE_ACCEPT, defaultFor, listTemplates, type ContractTemplate } from './contracts';
import { UploadWindow } from './ContractTemplates';
import { FirmSealWindow } from './FirmSeal';
import { canFirmSign } from './logic/access';
import type { FormKey, WorkerForm } from './worker';

const DEFAULT = '-';

export function ContractSection({ v, set, workerId, opened, toast }: {
  v: WorkerForm; set: (k: FormKey, val: string) => void; workerId: string | null; opened: boolean; toast: (m: string) => void;
}) {
  const [list, setList] = React.useState<ContractTemplate[] | null>(null);
  const [upload, setUpload] = React.useState<File | null>(null);
  const [seal, setSeal] = React.useState(false);
  const pick = React.useRef<HTMLInputElement>(null);
  const load = React.useCallback(() => { listTemplates(workerId || undefined).then(r => setList(r.templates), () => setList([])); }, [workerId]);
  React.useEffect(() => { if (opened && list === null) load(); }, [opened, list, load]);
  const firm = (list || []).filter(t => !t.workerId);
  const own = (list || []).filter(t => t.workerId && t.workerId === workerId);
  const categories = [...new Set(firm.map(t => t.category || ''))].filter(Boolean).sort();
  const def = defaultFor(list || [], v.contractCategory);
  const chosen = (list || []).find(t => t.id === v.contractTemplateId);
  const label = (t: ContractTemplate) => t.name + (t.category ? ' · ' + t.category : '') + (t.workerId ? ' · ' + tr('this worker only') : '');
  return (
    <div className="grid gap-2.5" data-testid="editor-contract">
      <FieldRow>
        <div className="grid min-w-0 gap-1.5">
          <Label>{tr('Contract category')}</Label>
          <Input id="wContractCategory" list="wContractCategories" value={v.contractCategory || ''} placeholder={tr('e.g. hourly')}
            onChange={e => set('contractCategory', e.target.value)} />
          <datalist id="wContractCategories">{categories.map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label>{tr('Contract template')}</Label>
          <Select value={v.contractTemplateId || DEFAULT} onValueChange={val => set('contractTemplateId', val === DEFAULT ? '' : val)}>
            <SelectTrigger id="wContractTemplate" data-testid="editor-contract-template"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{def ? tr('The default: {0}', { 0: def.name }) : tr('The default of the category')}</SelectItem>
              {[...own, ...firm].map(t => <SelectItem key={t.id} value={t.id}>{label(t)}</SelectItem>)}
              {v.contractTemplateId && !chosen && list && <SelectItem value={v.contractTemplateId}>{tr('A deleted template')}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </FieldRow>
      {list && !def && !chosen && <p className="text-[11px] text-warn" data-testid="editor-contract-none">{tr('No default template for this category — add one in Admin → Contract templates, or pick one.')}</p>}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">{tr("The worker's own terms")}</p>
      {([1, 2, 3, 4, 5] as const).map(i => (
        <div key={i} className="grid gap-1">
          <Label htmlFor={'wTerms' + i}>{'{{terms_' + i + '}}'}</Label>
          <Input id={'wTerms' + i} dir="auto" value={v[('terms' + i) as FormKey] as string || ''} placeholder={i === 1 ? tr('e.g. a special rate, hours, a trial period') : ''}
            onChange={e => set(('terms' + i) as FormKey, e.target.value)} />
        </div>
      ))}
      {workerId && <>
        <input ref={pick} type="file" accept={TEMPLATE_ACCEPT} className="hidden" data-testid="editor-contract-file"
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setUpload(f); }} />
        <Button size="sm" className="justify-self-start" data-testid="editor-contract-upload" onClick={() => pick.current?.click()}>
          <IconUpload className="size-4" />{tr('A contract for this worker only')}</Button>
      </>}
      {canFirmSign() && <Button size="sm" className="justify-self-start" data-testid="editor-contract-seal" onClick={() => setSeal(true)}>
        <IconRubberStamp className="size-4" />{tr("Firm's signature and stamp")}</Button>}
      {seal && <FirmSealWindow toast={toast} onClose={() => setSeal(false)} />}
      {upload && workerId && <UploadWindow file={upload} categories={categories} api={{ toast }} workerId={workerId}
        onClose={() => setUpload(null)} onSaved={t => { setUpload(null); set('contractTemplateId', t.id); load(); }} />}
    </div>
  );
}
