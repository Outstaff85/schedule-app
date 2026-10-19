// The logins of a client or a supplier in its window (stage 6d; docs/clients.md
// → Hours approval, docs/suppliers.md → Portal login): each login's name and
// user name, its permission template, then its ticks as tiles — a client
// login's hours ticks; a supplier login's portal tabs, "Sees own workers' pay"
// and its hours ticks. The ticks are the template's: shown here, changed only
// by the super-admin in the template (Admin → Users → Templates). The owner /
// super-admin makes a New login here.
import * as React from 'react';
import { IconTemplate, IconUser, IconUserPlus } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { CheckGrid, CheckTile } from '@/components/ui/checkbox';
import type { LoginRow, LoginsInfo, ManagerBridge } from './bridge';
import { loadTemplates, useTemplates } from './templates';

const SECTIONS: Record<string, string> = { dashboard: 'Dashboard', workers: 'My Workers', hours: 'My Hours' };

export function Logins({ role, ownerId, info, api }: { role: 'client' | 'supplier'; ownerId: string | null; info: LoginsInfo; api: ManagerBridge }) {
  const tpls = useTemplates();
  React.useEffect(() => { if (info.canEdit && info.logins.length && !tpls.list) void loadTemplates(api.adminCall); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a client login with no ticks has none; a supplier login without the field has the defaults
  const hourPermsOf = (u: LoginRow) => (Array.isArray(u.hourPerms) ? u.hourPerms : role === 'supplier' ? info.hourDefault : []);
  const hourKeys = Object.keys(info.hourLabels);
  const tplName = (u: LoginRow) => (tpls.list || []).find(t => t.id === u.templateId)?.name;

  return (
    <div className="grid gap-1.5" data-testid={role + '-logins'}>
      {info.logins.length ? info.logins.map(u => (
        <div key={u.id} data-testid="login" data-uid={u.id} className="grid gap-1.5">
          <div className="flex items-center gap-1.5 text-[13px] text-ink-2"><IconUser className="size-4" /><span>{u.name} · {u.username}</span></div>
          {tpls.list && (
            <div className="flex items-center gap-1.5 text-[12px] text-ink-2" data-testid="login-template">
              <IconTemplate className="size-3.5" />{tplName(u) ? tr('Rights follow {0}', { 0: tplName(u)! }) : <span className="text-warn">{tr('No template: pick one in Admin → Users')}</span>}
            </div>
          )}
          {role === 'supplier' && (
            <CheckGrid>
              {Object.keys(SECTIONS).map(k => (
                <CheckTile key={k} label={tr(SECTIONS[k])} data-field="supplierSections" data-key={k} disabled
                  checked={(u.supplierSections || Object.keys(SECTIONS)).includes(k)} />
              ))}
              <CheckTile label={tr("Sees own workers' pay")} data-field="showPay" disabled checked={u.showPay !== false} />
            </CheckGrid>
          )}
          <CheckGrid className="mb-2">
            {hourKeys.map(k => (
              <CheckTile key={k} label={tr(info.hourLabels[k])} data-field="hourPerms" data-key={k} disabled checked={hourPermsOf(u).includes(k)} />
            ))}
          </CheckGrid>
        </div>
      )) : <div className="text-[13px] text-ink-2">{tr(role === 'client' ? 'No client login yet.' : 'No portal login yet.')}</div>}
      {info.canEdit && ownerId && (
        <Button className="justify-self-start" data-testid="new-login" onClick={() => api.newLogin(role, ownerId)}>
          <IconUserPlus className="size-4" />{tr(role === 'client' ? 'New client login' : 'New portal login')}
        </Button>
      )}
    </div>
  );
}
