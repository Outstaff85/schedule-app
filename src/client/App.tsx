// The client portal (/client, docs/client-portal.md): a client of the firm
// signs in on the one login page (the manager app's), which hands over here
// with this page's own session (clientPortal_session); the page reviews its
// workers' hours at its site. It never reads Firestore: every call goes to the
// `hours` function with the Firebase ID token, so a client never receives
// wages, rates, suppliers, GPS, documents or tokens.
import * as React from 'react';
import { tr } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { useVersionWatch } from '@/lib/version-watch';
import { Brand, Shell } from '@/components/shared/shell';
import { LanguageButton } from '@/components/shared/language';
import { AccountMenu } from '@/components/shared/account-menu';
import type { ThemeChoice } from '@/lib/theme';
import { HoursReview, useHoursOwner } from '@/hours-review/HoursReview';
import { HOURS_FN_URL, type HoursCall } from '@/hours-review/hours';

// The theme picked in the account menu is also kept on the account (login brings it back on any device).
const saveTheme = (theme: ThemeChoice) => { loadBackend().then(b => b.handleAction('updateMyTheme', { action: 'updateMyTheme', theme }, {})).catch(() => {}); };

export const SESSION_KEY = 'clientPortal_session';
export type ClientSession = { uid: string; role: 'client'; tenantId?: string; clientId?: string; username?: string };

export function getSession(): ClientSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !s.uid || s.role !== 'client') { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
const toLogin = () => location.replace('schedule-manager.html');

// Sign out: this portal's session and the site's Firebase sign-in end, and the one login page opens.
export async function logout() {
  localStorage.removeItem(SESSION_KEY);
  try { await (await loadBackend()).signOut(); } catch { /* already out */ }
  location.href = 'schedule-manager.html';
}

const call: HoursCall = async body => {
  const token = await (await loadBackend()).idToken();
  const res = await fetch(HOURS_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const r = await res.json();
  if (r && r.error && /session|sign in|token/i.test(r.error)) void logout();
  return r;
};

// The gate runs once per page load (a language change redraws the tree).
let gate: Promise<boolean> | null = null;
function passGate(): Promise<boolean> {
  return gate || (gate = (async () => {
    if (!getSession()) return false;
    // The Firebase sign-in is gone (site data cleared, signed out): log in again.
    try { if (!(await loadBackend()).currentUser()) { localStorage.removeItem(SESSION_KEY); return false; } } catch { /* offline: keep the session */ }
    return true;
  })());
}

const watched = () => [location.pathname, '/firestore-backend.js'];

export function App() {
  const [ok, setOk] = React.useState(false);
  const session = getSession();
  const owner = useHoursOwner();
  useVersionWatch(watched);
  React.useEffect(() => { void passGate().then(pass => (pass ? setOk(true) : toLogin())); }, []);
  if (!ok || !session) return null;
  return (
    <Shell
      brand={<Brand name={tr('Client Portal')} sub={owner ? [owner.name, owner.object].filter(Boolean).join(' · ') : ''} />}
      tools={<>
        <LanguageButton />
        <AccountMenu name={session.username || ''} sub={tr('Client')} onThemeSave={saveTheme} onSignOut={() => void logout()} />
      </>}
    >
      <div className="mx-auto max-w-[760px] p-4">
        <HoursReview call={call} hideOwner sign={{ signer: session.username || '' }} />
      </div>
    </Shell>
  );
}
