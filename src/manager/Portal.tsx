// A supplier or client login inside the manager app (docs/portals.md;
// portal.ts): the frame's open tab drawn with the portal's own
// screens — a supplier's Dashboard, Workers, its hours and pay (Commission)
// and the hours review (Hours); a client's hours review. Every call goes to
// the `supplier` / `hours` function with the Firebase ID token, as on the
// portals: the page reads no Firestore for these logins.
import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { tr } from '@/lib/i18n';
import { loadBackend } from '@/lib/backend';
import { Spinner } from '@/components/ui/spinner';
import { Toaster } from '@/components/ui/sonner';
import { HoursReview } from '@/hours-review/HoursReview';
import { HOURS_FN_URL, type HoursCall } from '@/hours-review/hours';
import { queryClient, useSupplierData } from '@/supplier/api';
import { Dashboard } from '@/supplier/Dashboard';
import { Workers } from '@/supplier/Workers';
import { Hours } from '@/supplier/Hours';
import { SUPPLIER_VIEWS } from './portal';

/** The `hours` function with the ID token; a refused session signs out (`onSignOut`). */
function hoursCaller(onSignOut: () => void): HoursCall {
  return async body => {
    const token = await (await loadBackend()).idToken();
    const res = await fetch(HOURS_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    const r = await res.json();
    if (r && r.error && /session|sign in|token/i.test(r.error)) onSignOut();
    return r;
  };
}

export type PortalProps = { role: 'supplier' | 'client'; tab: string; username: string; onSignOut: () => void };

export function PortalView(p: PortalProps) {
  const call = React.useMemo(() => hoursCaller(p.onSignOut), [p.onSignOut]);
  if (p.role === 'client') return (
    <div className="mx-auto max-w-[760px]" data-testid="client-portal">
      <HoursReview call={call} sign={{ signer: p.username }} />
      <Toaster />
    </div>
  );
  return (
    <QueryClientProvider client={queryClient}>
      <SupplierView tab={p.tab} call={call} />
      <Toaster />
    </QueryClientProvider>
  );
}

function SupplierView({ tab, call }: { tab: string; call: HoursCall }) {
  const view = SUPPLIER_VIEWS[tab] || 'dashboard';
  const { isPending, isError, refetch } = useSupplierData();
  return (
    <div className="mx-auto w-full max-w-[960px]" data-testid="supplier-portal" data-tab={view} data-ready={isPending ? undefined : '1'}>
      {view === 'review' ? <div className="mx-auto max-w-[760px]"><HoursReview call={call} /></div>
        : isPending ? <div className="py-10 text-center text-sm text-ink-2"><Spinner className="mr-2 inline size-4 align-[-3px]" />{tr('Loading…')}</div>
        : isError ? <div className="py-10 text-center text-sm text-ink-2">{tr('Could not load — check the connection and try again.')} <button type="button" className="underline" onClick={() => void refetch()}>{tr('Retry')}</button></div>
        : view === 'dashboard' ? <Dashboard />
        : view === 'workers' ? <Workers />
        : <Hours />}
    </div>
  );
}
