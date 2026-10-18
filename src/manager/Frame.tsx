// The manager app's frame in React (React migration stage 8e-1): the Shell
// with `app` — the title bar (the 11C logo and its name, Saved, the
// breadcrumb plate, the date / greeting / weather in the middle, the bell,
// the Language button, the account menu), the side menu on a computer and
// the bottom bar with More on a phone; Hebrew mirrors the frame only. It
// draws `frame.ts`'s state, which the page's modules write; its actions run
// the page's own through `ManagerBridge`. The page's sections (#appMain, the
// tabs' React islands) are moved into the Shell's page area as they are.
// The bell's list is still the page's (it opens under the bell).
import * as React from 'react';
import { IconCash, IconCalendar, IconDownload, IconHome, IconLock, IconTruckDelivery, IconUserEdit, IconUsers, IconUsersGroup } from '@tabler/icons-react';
import { LanguageScope, adoptLanguage, tr } from '@/lib/i18n';
import { Shell, ShellGreeting, type ShellSection } from '@/components/shared/shell';
import { AppBrand, ShellBell } from '@/components/shared/app-brand';
import { AccountMenu } from '@/components/shared/account-menu';
import { LanguageButton } from '@/components/shared/language';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useFrame } from './frame';
import type { ManagerBridge } from './bridge';

/** The sections in menu order: their icon and colour; `more` = under More on a phone. */
const SECTIONS: { key: string; label: string; Icon: typeof IconHome; color: string; more?: boolean }[] = [
  { key: 'dashboard', label: 'Today', Icon: IconHome, color: '#22d3ee' },
  { key: 'schedule', label: 'Schedule', Icon: IconCalendar, color: '#818cf8' },
  { key: 'workers', label: 'Workers', Icon: IconUsersGroup, color: '#6dd6a0' },
  { key: 'clients', label: 'Clients', Icon: IconUsers, color: '#60a5fa', more: true },
  { key: 'suppliers', label: 'Suppliers', Icon: IconTruckDelivery, color: '#c084fc', more: true },
  { key: 'admin', label: 'Admin', Icon: IconLock, color: '#ff8a95', more: true },
  { key: 'accounting', label: 'Accounting', Icon: IconCash, color: '#f7c062' },
];

/** Puts a page element (found by id) inside this spot, each time the spot mounts. */
function Slot({ id, className }: { id: string; className?: string }) {
  const ref = React.useCallback((el: HTMLDivElement | null) => {
    const node = document.getElementById(id);
    if (el && node && node.parentElement !== el) el.appendChild(node);
  }, [id]);
  return <div ref={ref} className={className} data-slot-for={id} />;
}

export function Frame({ api }: { api: ManagerBridge }) {
  const f = useFrame();
  adoptLanguage(api.lang(), api.dict()); // the labels in the page's language (f.lang redraws on a change)
  const sections: ShellSection[] = SECTIONS.filter(s => f.tabs.includes(s.key)).map(({ key, label, Icon, color, more }) => ({
    key, label: tr(label), color, more, count: f.counts[key],
    countTitle: key === 'accounting' && f.counts[key] ? tr('{0} hours batch(es) waiting for review', { 0: f.counts[key] }) : undefined,
    icon: <Icon data-testid={`tab-${key}`} style={key === 'admin' && f.adminWarn ? { color: 'var(--warn)' } : undefined} />,
  }));
  const a = f.account;
  // The sign-in and the super-admin's Firms list cover the page: no frame under them.
  if (f.screen !== 'app') return null;
  return (
    <LanguageScope lang={f.lang}>
    <Shell
      app
      steady
      brand={<AppBrand save={f.save} />}
      sections={sections}
      active={f.tab}
      onSelect={k => api.switchTab(k)}
      crumb={f.crumb}
      center={f.greet && <ShellGreeting name={f.greet.name} wx={f.greet.wx} />}
      tools={<>
        {f.bell.shown && <ShellBell count={f.bell.count} onClick={e => api.toggleBell(e.nativeEvent)} />}
        <LanguageButton onPick={l => api.setLanguage(l)} />
        {a && (
          <AccountMenu name={a.name} firm={a.firm} sub={a.sub} onSignOut={() => api.signOut()} onThemeSave={t => api.saveTheme(t)}>
            {f.install && <DropdownMenuItem onSelect={() => api.installApp()} data-testid="account-install"><IconDownload />{tr('Install app')}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => api.editMyName()} data-testid="account-name"><IconUserEdit />{tr('My name')}</DropdownMenuItem>
          </AccountMenu>
        )}
      </>}
    >
      <Slot id="appMain" />
    </Shell>
    </LanguageScope>
  );
}
