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
 * The frame tabs of a supplier, from its flat rights (claim rt): Today (its
 * dashboard), Workers, Commission (its hours and pay) and Hours (the review,
 * with Hours or Schedule); a client: Hours.
 */
export function portalTabs(role: string, rights: string[]): string[] {
  if (role === 'client') return ['hours'];
  const out: string[] = [];
  if (rights.includes('today')) out.push('dashboard');
  if (rights.includes('workers')) out.push('workers');
  if (rights.includes('commission')) out.push('commission');
  if (rights.some(p => p === 'hours' || p === 'schedule')) out.push('hours');
  return out;
}

export const isPortalRole = (role?: string) => role === 'supplier' || role === 'client';
/** Each portal role's session key: page/gate.ts writes, restores and clears them; the supplier's screens read theirs (src/supplier/api.ts). */
export const PORTAL_SESSION_KEYS: Record<string, string> = { supplier: 'supplierPortal_session', client: 'clientPortal_session' };
