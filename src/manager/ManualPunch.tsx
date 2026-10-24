// The manual punch (docs/clients.md → Manual punch), drawn in React into the
// page's #manualPunchModal (stage 6d): the worker (this client's workers, or
// every active one), IN / OUT, the date, the time and a note. The punch is
// marked manual and not GPS-verified; the page adds it to the punch log and
// sends it (gsSavePunch).
import * as React from 'react';
import { IconCheck, IconClock, IconEdit, IconLogin, IconLogout } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { localYMD } from '@/lib/payroll';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { FieldRow } from '@/components/ui/form';
import type { ManagerBridge, ManualPunch as Punch } from './bridge';
import { Field } from './ClientEditor';

const pad = (n: number) => String(n).padStart(2, '0');

export function ManualPunch({ clientId, api }: { clientId: string; api: ManagerBridge }) {
  const info = React.useMemo(() => api.punchInfo(clientId), [clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now] = React.useState(() => new Date());
  const [wid, setWid] = React.useState('');
  const [type, setType] = React.useState<'in' | 'out'>('in');
  const [date, setDate] = React.useState(localYMD(now));
  const [time, setTime] = React.useState(pad(now.getHours()) + ':' + pad(now.getMinutes()));
  const [note, setNote] = React.useState('');
  if (!info) return null;
  const { client, workers } = info;

  const save = () => {
    if (!wid) { api.toast(tr('Please select a worker')); return; }
    if (!time) { api.toast(tr('Please enter a time')); return; }
    const w = workers.find(x => x.id === wid);
    // `date` from the field's own parts (new Date('yyyy-mm-dd') is UTC midnight:
    // a day early on a device west of UTC), so it is the same day as `ts`.
    const [y, m, d] = date.split('-');
    const p: Punch = {
      id: Date.now(), workerId: wid, workerName: w?.name || 'Unknown', type, time,
      date: d + '/' + m + '/' + y, ts: new Date(date + 'T' + time + ':00').toISOString(),
      site: client.name || '', clientId: client.id || null, dist: null, gpsVerified: false, manual: true, notes: note.trim(),
      gpsWarnings: ['Manual entry by manager'],
    };
    api.addPunch(p);
  };

  return (
    <div data-testid="manual-punch" className="grid gap-3">
      <div className="flex items-center gap-2 text-lg font-bold"><IconClock className="size-5" />{tr('Manual Punch — {0}', { 0: client.name })}</div>
      <Field label={tr('Worker')} htmlFor="mpWorker">
        <Select value={wid} onValueChange={setWid}>
          <SelectTrigger id="mpWorker" className="w-full"><SelectValue placeholder={tr('— Select worker —')} /></SelectTrigger>
          <SelectContent>{workers.map(w => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={tr('Type')}>
        <div className="grid grid-cols-2 gap-2" data-testid="mp-type">
          <Button data-type="in" on={type === 'in'} className={cn(type === 'in' && '!border-ok text-ok')} onClick={() => setType('in')}><IconLogin className="size-4" />{tr('Clock IN')}</Button>
          <Button data-type="out" on={type === 'out'} className={cn(type === 'out' && '!border-bad text-bad')} onClick={() => setType('out')}><IconLogout className="size-4" />{tr('Clock OUT')}</Button>
        </div>
      </Field>
      <FieldRow>
        <Field label={tr('Date')} htmlFor="mpDate"><DatePicker id="mpDate" value={date} onChange={setDate} /></Field>
        <Field label={tr('Time')} htmlFor="mpTime"><Input id="mpTime" type="time" value={time} onChange={e => setTime(e.target.value)} /></Field>
      </FieldRow>
      <Field label={tr('Note (optional)')} htmlFor="mpNote">
        <Input id="mpNote" value={note} placeholder={tr('e.g. Late arrival, approved by manager')} onChange={e => setNote(e.target.value)} />
      </Field>
      <Alert variant="warn"><IconEdit /><AlertDescription>{tr('Manual entry — GPS not verified')}</AlertDescription></Alert>
      <Button variant="primary" className="og-save" data-testid="mp-save" onClick={save}><IconCheck />{tr('Save Punch')}</Button>
    </div>
  );
}
