// The supplier portal's data (docs/supplier-portal.md): its own session key,
// and every call to the `supplier` function (functions-auth/portal.py) with
// the Firebase ID token. That function hands out only this supplier's own
// workers and punches through its allow-lists (no client billing, GPS,
// punch-link tokens or file links; wages only with "sees pay") and writes only
// through its narrow actions. Reads go through TanStack Query: the data stays
// cached across a language change and is refreshed after every write.
import { QueryClient, useQuery } from '@tanstack/react-query';
import { loadBackend } from '@/lib/backend';
import type { PayClient, PayWorker, Punch } from '@/lib/payroll';

export const SESSION_KEY = 'supplierPortal_session';
export type SupplierSession = { uid: string; role: 'supplier'; tenantId?: string; supplierId?: string; username?: string };

export function getSession(): SupplierSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s || !s.uid || s.role !== 'supplier') { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
export const toLogin = () => location.replace('schedule-manager.html');

// Sign out: this portal's session and the site's Firebase sign-in end, and the one login page opens.
export async function logout() {
  localStorage.removeItem(SESSION_KEY);
  try { await (await loadBackend()).signOut(); } catch { /* already out */ }
  location.href = 'schedule-manager.html';
}

export const SUPPLIER_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/supplier';

/** One supplier action; resolves with the JSON reply ({error} on refusal). */
export async function supplierCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  const token = await (await loadBackend()).idToken();
  const res = await fetch(SUPPLIER_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  const r = await res.json();
  if (r && r.error && /session|sign in|token/i.test(r.error)) void logout();
  return r;
}

// ── Shapes: only what the server sends this role (portal.py strip_worker) ──
export interface SWorker extends PayWorker {
  id: string;
  name: string;
  docGiven?: string;
  docSurname?: string;
  docId?: string;
  phone?: string;
  address?: string;
  city?: string;
  clientIds?: string[];
  supplierRate?: number | null;
  supplierDayRate?: number | null;
  createdAt?: string;
  avatarB64?: string;
}
export interface SClient extends PayClient { name: string; object?: string }
export interface SPunch extends Punch { id?: string; workerId: string; workerName?: string; clientId?: string; site?: string; date?: string }
export interface CommissionRate { from?: string; mode?: 'hour' | 'day'; rate?: number | string | null }
export interface SupplierData {
  workers: SWorker[];
  clients: SClient[];
  punches: SPunch[];
  showPay: boolean;
  commission: CommissionRate[];
}
export interface HoursBatch {
  id?: string;
  status?: 'pending' | 'approved' | 'rejected';
  uploadedAt?: string;
  decidedAt?: string;
  entries?: { workerId?: string; date?: string; inTime?: string; outTime?: string }[];
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } } });
export const DATA_KEY = ['supplier', 'data'] as const;
export const SENT_KEY = ['supplier', 'sentHours'] as const;

async function loadData(): Promise<SupplierData> {
  const [sch, pl] = await Promise.all([
    supplierCall<Partial<SupplierData> & { entries?: never }>({ action: 'loadSchedule' }),
    supplierCall<{ entries?: SPunch[] }>({ action: 'loadPunchLog' }),
  ]);
  if (sch.error) throw new Error(sch.error);
  return {
    workers: sch.workers || [],
    clients: sch.clients || [],
    punches: pl.entries || [],
    showPay: sch.showPay === true,
    commission: Array.isArray(sch.commission) ? sch.commission : [],
  };
}

const EMPTY: SupplierData = { workers: [], clients: [], punches: [], showPay: false, commission: [] };
export function useSupplierData() {
  const q = useQuery({ queryKey: DATA_KEY, queryFn: loadData });
  return { ...q, d: q.data || EMPTY };
}
export const refreshData = () => queryClient.invalidateQueries({ queryKey: DATA_KEY });

export function useSentHours() {
  return useQuery({
    queryKey: SENT_KEY,
    queryFn: async () => {
      const r = await supplierCall<{ batches?: HoursBatch[] }>({ action: 'supplierListHours' });
      if (r.error) throw new Error(r.error);
      return r.batches || [];
    },
  });
}

/** The worker's last punch (IN = on site now). */
export function lastEntryFor(punches: SPunch[], workerId: string): SPunch | null {
  let best: SPunch | null = null;
  for (const e of punches) if (e.workerId === workerId && (!best || new Date(e.ts).getTime() > new Date(best.ts).getTime())) best = e;
  return best;
}
export const clientName = (clients: SClient[], id?: string) => clients.find(c => c.id === id)?.name || '';
