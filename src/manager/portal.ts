// A supplier or client login inside the manager app (docs/permissions-plan.md
// → stage 3): the same frame, its own tabs, its data only through the
// `supplier` / `hours` functions — the page loads no firm data for it and
// never reads Firestore. Pure: what tabs a login gets and which portal view
// each frame tab is.

/** The manager frame's tab → the supplier portal's own view. */
export const SUPPLIER_VIEWS: Record<string, 'dashboard' | 'workers' | 'hours' | 'review'> = {
  dashboard: 'dashboard', workers: 'workers', commission: 'hours', hours: 'review',
};

/**
 * The frame tabs of a supplier (its portal tabs, claim ss — Today the
 * dashboard, Workers, Commission its hours and pay — and Hours the review
 * with an hours or schedule tick, claim hp) or a client (Hours).
 */
export function portalTabs(role: string, ss: string[], hp: string[]): string[] {
  const review = hp.some(p => p === 'hours' || p === 'schedule');
  if (role === 'client') return ['hours'];
  const out: string[] = [];
  if (ss.includes('dashboard')) out.push('dashboard');
  if (ss.includes('workers')) out.push('workers');
  if (ss.includes('hours')) out.push('commission');
  if (review) out.push('hours');
  return out;
}

export const isPortalRole = (role?: string) => role === 'supplier' || role === 'client';
/** The session key each portal's own code reads (src/supplier/api.ts, src/client/App.tsx). */
export const PORTAL_SESSION_KEYS: Record<string, string> = { supplier: 'supplierPortal_session', client: 'clientPortal_session' };
