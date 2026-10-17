// My Workers: a plate per own worker (name and NEW, phone · clients, the
// commission ₪/h or ₪/day; green while on site); a tap, a double click or a
// long press opens the edit form; ⋮ and a swipe: Edit, Delete. Delete never
// asks — the plate goes behind the Undo snack and the server delete
// (supplierDeleteWorker) runs only after its 5 s; Select deletes several the
// same way. Every write goes through the supplier function's narrow actions.
import * as React from 'react';
import { AnimatePresence } from 'motion/react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { IconCheck, IconHome, IconPlus, IconUser } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { PageHead } from '@/components/shared/page-head';
import { Section } from '@/components/shared/section';
import { Plate } from '@/components/shared/plate';
import { PagedList } from '@/components/shared/paged-list';
import { SelectBar, SelectHead, useSelection } from '@/components/shared/select-mode';
import { undoDelete } from '@/components/shared/undo';
import { Window } from '@/components/shared/window';
import { NewBadge } from '@/components/shared/new-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { FieldRow, Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { clientName, lastEntryFor, refreshData, supplierCall, useSupplierData, type SWorker } from './api';
import { plateRate } from './money';

async function deleteNow(id: string): Promise<boolean> {
  try {
    const r = await supplierCall({ action: 'supplierDeleteWorker', workerId: id });
    if (r.error) { toast.error(r.error); return false; }
    return true;
  } catch (e) { toast.error(tr('Failed: {0}', { 0: (e as Error).message })); return false; }
}

export function Workers() {
  const { d } = useSupplierData();
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [edit, setEdit] = React.useState<SWorker | 'new' | null>(null);
  const list = d.workers.filter(w => !hidden.has(w.id));
  const sel = useSelection(React.useMemo(() => list.map(w => w.id), [list]));

  const hide = (ids: string[], on: boolean) => setHidden(h => { const n = new Set(h); ids.forEach(id => (on ? n.add(id) : n.delete(id))); return n; });
  const remove = (ids: string[]) => {
    const one = d.workers.find(w => w.id === ids[0]);
    hide(ids, true);
    undoDelete(
      ids.length === 1 && one ? tr('{name} deleted', { name: one.name }) : tr('{n} workers deleted', { n: ids.length }),
      async () => {
        let ok = 0;
        for (const id of ids) if (await deleteNow(id)) ok++;
        if (ok) toast.success(tr('Removed'));
        await refreshData();
        hide(ids, false);
      },
      () => hide(ids, false),
    );
  };

  return (
    <div data-testid="workers">
      <PageHead title={tr('My Workers')}>
        <Button variant="primary" className="og-new" onClick={() => setEdit('new')}><IconPlus className="size-[18px]" />{tr('New')}</Button>
      </PageHead>
      {!d.workers.length
        ? <div className="py-4 text-sm text-faint">{tr('No workers yet')}</div>
        : (
          <Section label={tr('Workers')} count={list.length} tools={<SelectHead sel={sel} />}>
            <AnimatePresence initial={false}>
              <PagedList items={list} render={w => {
                const onSite = lastEntryFor(d.punches, w.id)?.type === 'in';
                return (
                  <Plate
                    key={w.id}
                    data-worker-id={w.id}
                    color={onSite ? 'var(--green)' : 'var(--neutral)'}
                    title={w.name}
                    chips={<NewBadge createdAt={w.createdAt} />}
                    sub={[w.phone || '', (w.clientIds || []).map(id => clientName(d.clients, id)).filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                    right={plateRate(w) || undefined}
                    onOpen={() => setEdit(w)}
                    onEdit={() => setEdit(w)}
                    onDelete={() => remove([w.id])}
                    selecting={sel.on}
                    selected={sel.picked.has(w.id)}
                    onToggle={() => sel.toggle(w.id)}
                  />
                );
              }} />
            </AnimatePresence>
          </Section>
        )}
      <SelectBar sel={sel} onDelete={remove} />
      <WorkerWindow worker={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

// ── Add / edit: a plain manual form (no document scan here — a deliberate
// scope cut), drawn like the manager app's editors: section plates, one open
// at a time, a closed one shows its summary; the given name is required.
const workerSchema = z.object({
  docGiven: z.string().trim().min(1, 'Name required'),
  docSurname: z.string().trim(),
  phone: z.string().trim(),
  docId: z.string().trim(),
  address: z.string().trim(),
  city: z.string().trim(),
});
type WorkerFields = z.infer<typeof workerSchema>;

function fieldsOf(w: SWorker | null): WorkerFields {
  // A record older than the given name / surname split only has `name`.
  const name = (w && w.name) || '';
  return {
    docGiven: w && w.docGiven != null ? w.docGiven : name.split(' ')[0] || '',
    docSurname: w && w.docSurname != null ? w.docSurname : name.split(' ').slice(1).join(' '),
    phone: (w && w.phone) || '', docId: (w && w.docId) || '', address: (w && w.address) || '', city: (w && w.city) || '',
  };
}

function WorkerWindow({ worker, onClose }: { worker: SWorker | 'new' | null; onClose: () => void }) {
  const w = worker === 'new' ? null : worker;
  return (
    <Window open={!!worker} onOpenChange={o => { if (!o) onClose(); }} title={w ? tr('Edit Worker') : tr('Add Worker')} description={w ? w.name : undefined}>
      {worker && <WorkerForm key={w ? w.id : 'new'} worker={w} onDone={onClose} />}
    </Window>
  );
}

const summary = (vals: string[]) => vals.filter(Boolean).join(' · ') || tr('Not filled in');

function WorkerForm({ worker, onDone }: { worker: SWorker | null; onDone: () => void }) {
  const form = useForm<WorkerFields>({ resolver: zodResolver(workerSchema), defaultValues: fieldsOf(worker) });
  const v = useWatch({ control: form.control }) as WorkerFields;
  const [open, setOpen] = React.useState('person');
  const [busy, setBusy] = React.useState(false);
  const save = async (fields: WorkerFields) => {
    setBusy(true);
    try {
      const body = worker ? { action: 'supplierUpdateWorker', workerId: worker.id, worker: fields } : { action: 'supplierAddWorker', worker: fields };
      const r = await supplierCall(body);
      if (r.error) { toast.error(r.error); return; }
      toast.success(tr('Saved'));
      await refreshData();
      onDone();
    } catch (e) { toast.error(tr('Failed: {0}', { 0: (e as Error).message })); }
    finally { setBusy(false); }
  };
  const missing = !String(v.docGiven || '').trim();
  const text = (name: keyof WorkerFields, label: string, type = 'text') => (
    <FormField control={form.control} name={name} render={({ field }) => (
      <FormItem><FormLabel>{label}</FormLabel><FormControl><Input type={type} data-field={name} {...field} /></FormControl><FormMessage /></FormItem>
    )} />
  );
  return (
    <Form {...form}>
      <form noValidate data-testid="worker-form" className="grid gap-3" onSubmit={form.handleSubmit(save, () => setOpen('person'))}>
        <Accordion type="single" collapsible value={open} onValueChange={setOpen}>
          <AccordionItem value="person" color={missing ? 'var(--amber)' : 'var(--green)'}>
            <AccordionTrigger icon={<IconUser />} summary={open === 'person' ? undefined : summary([[v.docGiven, v.docSurname].filter(Boolean).join(' '), v.phone, v.docId])}>{tr('Person')}</AccordionTrigger>
            <AccordionContent className="grid gap-2.5">
              <FieldRow>{text('docGiven', tr('Given name'))}{text('docSurname', tr('Surname'))}</FieldRow>
              <FieldRow>{text('phone', tr('Phone'), 'tel')}{text('docId', tr('ID / Passport number'))}</FieldRow>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="address" color={v.address || v.city ? 'var(--green)' : 'var(--neutral)'}>
            <AccordionTrigger icon={<IconHome />} summary={open === 'address' ? undefined : summary([v.address, v.city])}>{tr('Address')}</AccordionTrigger>
            <AccordionContent className="grid gap-2.5">
              <FieldRow>{text('address', tr('Address'))}{text('city', tr('City'))}</FieldRow>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <Button type="submit" variant="primary" disabled={busy} data-testid="worker-save"><IconCheck className="size-[18px]" />{tr('Save')}</Button>
      </form>
    </Form>
  );
}
