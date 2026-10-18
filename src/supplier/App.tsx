// The supplier portal (/supplier, docs/supplier-portal.md): a supplier
// (staffing agency) signs in on the one login page (the manager app's), which
// hands over here with this page's own session (supplierPortal_session). Its
// own workers, their punches and hours, the hours it sends for approval and,
// with an hours tick, the hours review. Every call goes to the `supplier`
// (and `hours`) function with the Firebase ID token — the page never reads
// Firestore, so it receives only what those functions' allow-lists send.
import * as React from 'react';
import { IconChecks, IconClockHour4, IconLayoutDashboard, IconUsers } from '@tabler/icons-react';
import { tr } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { useVersionWatch } from '@/lib/version-watch';
import { Brand, Shell, type ShellSection } from '@/components/shared/shell';
import { LanguageButton } from '@/components/shared/language';
import { AccountMenu } from '@/components/shared/account-menu';
import type { ThemeChoice } from '@/lib/theme';
import { Spinner } from '@/components/ui/spinner';
import { HoursReview } from '@/hours-review/HoursReview';
import { HOURS_FN_URL, type HoursCall } from '@/hours-review/hours';
import { getSession, logout, toLogin, useSupplierData, SESSION_KEY } from './api';
import { setUi, useUi, type Tab } from './store';
import { Dashboard } from './Dashboard';
import { Workers } from './Workers';
import { Hours } from './Hours';

// The theme picked in the account menu is also kept on the account (login brings it back on any device).
const saveTheme = (theme: ThemeChoice) => { loadBackend().then(b => b.handleAction('updateMyTheme', { action: 'updateMyTheme', theme }, {})).catch(() => {}); };

const hoursCall: HoursCall = async body => {
  const token = await (await loadBackend()).idToken();
  const res = await fetch(HOURS_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const r = await res.json();
  if (r && r.error && /session|sign in|token/i.test(r.error)) void logout();
  return r;
};

type Gate = { sections: Tab[]; review: boolean };
// The gate runs once per page load (a language change redraws the tree):
// the Firebase sign-in, the tabs this login may use (claim ss, set by the owner
// in Admin → Users) and the hours approval tab (an hours or schedule tick, claim hp).
let gate: Promise<Gate | null> | null = null;
function passGate(): Promise<Gate | null> {
  return gate || (gate = (async () => {
    if (!getSession()) return null;
    let b;
    try { b = await loadBackend(); } catch { return { sections: ['dashboard', 'workers', 'hours'], review: false }; }
    // The Firebase sign-in is gone (site data cleared, signed out): log in again.
    if (!b.currentUser()) { localStorage.removeItem(SESSION_KEY); return null; }
    const [ss, hp] = await Promise.all([b.supplierSections().catch(() => ['dashboard', 'workers', 'hours']), b.hourPerms().catch(() => [] as string[])]);
    const sections = (['dashboard', 'workers', 'hours'] as Tab[]).filter(t => ss.includes(t));
    return { sections, review: hp.some(p => p === 'hours' || p === 'schedule') };
  })());
}

const watched = () => [location.pathname, '/firestore-backend.js'];

export function App() {
  const [g, setG] = React.useState<Gate | null>(null);
  const session = getSession();
  useVersionWatch(watched);
  React.useEffect(() => { void passGate().then(r => (r ? setG(r) : toLogin())); }, []);
  if (!g || !session) return null;
  return <Portal gate={g} name={session.username || ''} />;
}

function Portal({ gate: g, name }: { gate: Gate; name: string }) {
  const ui = useUi();
  const { isPending, isError, refetch } = useSupplierData();
  const all: (ShellSection & { key: Tab })[] = [
    { key: 'dashboard', label: tr('Dashboard'), icon: <IconLayoutDashboard />, color: 'var(--accent)' },
    { key: 'workers', label: tr('My Workers'), icon: <IconUsers />, color: 'var(--green)' },
    { key: 'hours', label: tr('My Hours'), icon: <IconClockHour4 />, color: 'var(--uline-1)' },
    { key: 'review', label: tr('Approvals'), icon: <IconChecks />, color: 'var(--amber)' },
  ];
  const sections = all.filter(s => (s.key === 'review' ? g.review : g.sections.includes(s.key)));
  // A tab without its tick falls back to the first allowed one.
  const tab: Tab | '' = sections.some(s => s.key === ui.tab) ? ui.tab : sections[0]?.key || '';
  return (
    <Shell
      brand={<Brand name={tr('Supplier Portal')} />}
      tools={<>
        <LanguageButton />
        <AccountMenu name={name} sub={tr('Supplier')} onThemeSave={saveTheme} onSignOut={() => void logout()} />
      </>}
      sections={sections}
      active={tab}
      onSelect={k => setUi({ tab: k as Tab })}
    >
      <div className="mx-auto w-full max-w-[960px] p-4" data-testid="supplier-portal" data-tab={tab} data-ready={isPending ? undefined : '1'}>
        {tab === 'review' ? <div className="mx-auto max-w-[760px]"><HoursReview call={hoursCall} /></div>
          : isPending ? <div className="py-10 text-center text-sm text-ink-2"><Spinner className="mr-2 inline size-4 align-[-3px]" />{tr('Loading…')}</div>
          : isError ? <div className="py-10 text-center text-sm text-ink-2">{tr('Could not load — check the connection and try again.')} <button type="button" className="underline" onClick={() => void refetch()}>{tr('Retry')}</button></div>
          : tab === 'dashboard' ? <Dashboard />
          : tab === 'workers' ? <Workers />
          : tab === 'hours' ? <Hours />
          : null}
      </div>
    </Shell>
  );
}
