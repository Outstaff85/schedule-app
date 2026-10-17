// The logins of a client or a supplier in its window (stage 6d; docs/clients.md
// → Hours approval, docs/suppliers.md → Portal login): each login's name and
// user name, then its ticks as tiles — a client login's hours ticks; a supplier
// login's portal tabs, "Sees own workers' pay" and its hours ticks. A tick is
// saved at once (the page's updateUser call); a failed save puts it back. Only
// the owner / super-admin changes them and makes a New login.
import * as React from 'react';
import { IconUser, IconUserPlus } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import type { LoginRow, LoginsInfo, ManagerBridge } from './bridge';

const SECTIONS: Record<string, string> = { dashboard: 'Dashboard', workers: 'My Workers', hours: 'My Hours' };

export function Logins({ role, ownerId, info, api }: { role: 'client' | 'supplier'; ownerId: string | null; info: LoginsInfo; api: ManagerBridge }) {
  const [rows, setRows] = React.useState<LoginRow[]>(info.logins);
  const can = info.canEdit;
  const set = (uid: string, patch: Partial<LoginRow>) => setRows(rs => rs.map(r => (r.id === uid ? { ...r, ...patch } : r)));
  const flip = async (u: LoginRow, field: 'hourPerms' | 'supplierSections', key: string, all: string[]) => {
    const was = field === 'hourPerms' ? hourPermsOf(u) : u.supplierSections || Object.keys(SECTIONS);
    const next = was.includes(key) ? was.filter(k => k !== key) : all.filter(k => was.includes(k) || k === key);
    set(u.id, { [field]: next });
    if (!(await api.saveLogin(u.id, field, next))) set(u.id, { [field]: was });
  };
  const flipPay = async (u: LoginRow) => {
    const next = u.showPay === false;
    set(u.id, { showPay: next });
    if (!(await api.saveLogin(u.id, 'showPay', next))) set(u.id, { showPay: !next });
  };
  // a client login with no ticks has none; a supplier login without the field has the defaults
  const hourPermsOf = (u: LoginRow) => (Array.isArray(u.hourPerms) ? u.hourPerms : role === 'supplier' ? info.hourDefault : []);
  const hourKeys = Object.keys(info.hourLabels);

  return (
    <div className="grid gap-1.5" data-testid={role + '-logins'}>
      {rows.length ? rows.map(u => (
        <div key={u.id} data-testid="login" data-uid={u.id} className="grid gap-1.5">
          <div className="flex items-center gap-1.5 text-[13px] text-ink-2"><IconUser className="size-4" /><span>{u.name} · {u.username}</span></div>
          {role === 'supplier' && (
            <CheckGrid>
              {Object.keys(SECTIONS).map(k => (
                <CheckTile key={k} label={tr(SECTIONS[k])} data-field="supplierSections" data-key={k} disabled={!can}
                  checked={(u.supplierSections || Object.keys(SECTIONS)).includes(k)} onCheckedChange={() => flip(u, 'supplierSections', k, Object.keys(SECTIONS))} />
              ))}
              <CheckTile label={tr("Sees own workers' pay")} data-field="showPay" disabled={!can} checked={u.showPay !== false} onCheckedChange={() => flipPay(u)} />
            </CheckGrid>
          )}
          <CheckGrid className="mb-2">
            {hourKeys.map(k => (
              <CheckTile key={k} label={tr(info.hourLabels[k])} data-field="hourPerms" data-key={k} disabled={!can}
                checked={hourPermsOf(u).includes(k)} onCheckedChange={() => flip(u, 'hourPerms', k, hourKeys)} />
            ))}
          </CheckGrid>
        </div>
      )) : <div className="text-[13px] text-ink-2">{tr(role === 'client' ? 'No client login yet.' : 'No portal login yet.')}</div>}
      {can && ownerId && (
        <Button className="justify-self-start" data-testid="new-login" onClick={() => api.newLogin(role, ownerId)}>
          <IconUserPlus className="size-4" />{tr(role === 'client' ? 'New client login' : 'New portal login')}
        </Button>
      )}
    </div>
  );
}
