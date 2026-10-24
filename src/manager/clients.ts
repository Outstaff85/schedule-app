// The Clients and Suppliers tabs' small rules (stage 6d; docs/clients.md,
// docs/suppliers.md): the client window's billing state, its record, the
// Google Maps link reader, the margin, and the supplier's own rate from a date.
// Billing never changes a worker's pay; the supplier's rate only its commission.
import { localYMD } from '@/lib/payroll';
import { myRateOn } from '@/supplier/money';
import type { CommissionRate } from '@/supplier/api';
import type { ClientRecord, CommissionEntry, SupplierRecord } from './bridge';

/** '' or empty → null, else the number (a bad one → 0), like the old clientRateNum. */
export function rateNum(v: string | number | null | undefined): number | null {
  return v === '' || v == null ? null : parseFloat(String(v)) || 0;
}
const numOrEmpty = (v: number | null | undefined) => (v == null ? '' : String(v));

/** How the client is billed while its window is open (the old __cBill). */
export type Bill = {
  rateMode: 'tiered' | 'fixed' | 'daily';
  /** the hourly mode to go back to from "By the day" */
  hourMode: 'tiered' | 'fixed';
  dailyBillRate: number | null;
  fixedBillRate: number | null;
  billRate: number | null;
  billOtRate: number | null;
  billShabbatRate: number | null;
};

export function billOf(c: ClientRecord): Bill {
  return {
    rateMode: c.rateMode === 'fixed' ? 'fixed' : c.rateMode === 'daily' ? 'daily' : 'tiered',
    hourMode: c.rateMode === 'fixed' ? 'fixed' : 'tiered',
    dailyBillRate: c.dailyBillRate ?? null,
    fixedBillRate: c.fixedBillRate ?? null,
    // clients saved before billRate existed: the worker default
    billRate: c.billRate != null && c.billRate !== '' ? Number(c.billRate) : (c.defaultHourlyRate ?? null),
    billOtRate: c.billOtRate ?? null,
    billShabbatRate: c.billShabbatRate ?? null,
  };
}

/** The main billing rate next to the worker rate: the flat rate in fixed mode, the regular rate otherwise. */
export const billMain = (b: Bill) => (b.rateMode === 'fixed' ? b.fixedBillRate : b.billRate);
export function setBillMain(b: Bill, v: string): Bill {
  const n = rateNum(v);
  return b.rateMode === 'fixed' ? { ...b, fixedBillRate: n } : { ...b, billRate: n };
}
/** By the hour / By the day: by the hour goes back to the hourly mode last picked. */
export function setPayUnit(b: Bill, unit: 'hour' | 'day'): Bill {
  return { ...b, rateMode: unit === 'day' ? 'daily' : b.hourMode || 'tiered' };
}
/** By law (OT / Shabbat inline) or one fixed rate. */
export function setRateMode(b: Bill, mode: 'tiered' | 'fixed'): Bill {
  return { ...b, rateMode: mode, hourMode: mode };
}

/** The client window's text fields. */
export type ClientForm = {
  name: string; companyNumber: string; address: string; object: string; radius: string;
  mapsUrl: string; lat: string; lng: string; defRate: string;
};
export function clientFormOf(c: ClientRecord): ClientForm {
  return {
    name: c.name || '', companyNumber: c.companyNumber || '', address: c.address || '', object: c.object || '',
    radius: String(c.radius || 100), mapsUrl: c.mapsUrl || '', lat: c.lat ? String(c.lat) : '', lng: c.lng ? String(c.lng) : '',
    defRate: numOrEmpty(c.defaultHourlyRate),
  };
}

/**
 * The record the window saves: the form plus the billing state. The window
 * sets only the regular worker rate; OT and Shabbat follow the law from it (an
 * older client's own OT / Shabbat rates are cleared).
 */
export function clientRecordOf(f: ClientForm, b: Bill, color: string): ClientRecord {
  return {
    name: f.name.trim(), object: f.object.trim(), address: f.address.trim(), companyNumber: f.companyNumber.trim(), color,
    lat: parseFloat(f.lat) || null, lng: parseFloat(f.lng) || null, radius: clientRadius(f.radius), mapsUrl: f.mapsUrl.trim(),
    defaultHourlyRate: rateNum(f.defRate), defaultOtRate: null, defaultShabbatRate: null,
    rateMode: b.rateMode, fixedBillRate: b.fixedBillRate, billRate: b.billRate, billOtRate: b.billOtRate, billShabbatRate: b.billShabbatRate,
    dailyBillRate: b.dailyBillRate,
  };
}

/** A site's punch radius in metres: 100 when empty, never under 10 (a
 *  negative or tiny radius would put every punch outside the site). */
export function clientRadius(v: unknown): number {
  return Math.max(10, parseInt(String(v ?? ''), 10) || 100);
}

/** A pasted Google Maps link (or plain "lat, lng"): its point, or null. */
export function parseMapsUrl(url: string): { lat: string; lng: string } | null {
  if (!url) return null;
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /\/(-?\d+\.\d+),(-?\d+\.\d+)/,
    /^\s*(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)\s*$/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return { lat: m[1], lng: m[2] }; }
  return null;
}

/** What the firm keeps per regular hour (the client's rate minus the worker's), or null while either is empty. */
export function margin(worker: number | null, client: number | null): { perHour: number; pct: number } | null {
  if (worker == null || client == null || !client) return null;
  const m = client - worker;
  return { perHour: m, pct: Math.round((m / client) * 100) };
}

/** "25.2k" for the figures in the windows (the old fmtMoneyShort). */
export function moneyShort(v: number): string {
  const r = Math.round(v || 0);
  return Math.abs(r) >= 10000 ? Math.round(r / 100) / 10 + 'k' : r.toLocaleString('en-US');
}

/** The supplier's rate on a date (the page's supplierRateOn; the portal's myRateOn is the same rule). */
export function rateOn(list: CommissionEntry[] | undefined, date: Date): CommissionEntry | null {
  return myRateOn((list || []) as CommissionRate[], date) as CommissionEntry | null;
}

/**
 * The supplier window's Commission fields (owner / super-admin only): a changed
 * rate or mode becomes a new entry of sp.commission from its date (an entry
 * with the same date is replaced); an emptied rate goes back to the default
 * from then on. Unchanged → undefined (the list is kept as it is).
 */
export function commissionFromForm(list: CommissionEntry[] | undefined, mode: 'hour' | 'day', rateText: string, from: string): CommissionEntry[] | undefined {
  from = from || localYMD(new Date());
  const v = rateText.trim(), cur = rateOn(list, new Date(from + 'T12:00'));
  const rate = v === '' ? null : parseFloat(v) || 0;
  if (cur ? Number(cur.rate) === rate && (cur.mode || 'hour') === mode : rate == null) return undefined;
  const next = (list || []).filter(x => x && String(x.from || '') !== from);
  next.push({ from, mode, rate });
  return next.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
}

/** The supplier window's fields. */
export type SupplierForm = { name: string; companyNumber: string; phone: string; contactPerson: string; bank: string; bankBranch: string; accountNumber: string };
export function supplierFormOf(s: SupplierRecord): SupplierForm {
  return {
    name: s.name || '', companyNumber: s.companyNumber || '', phone: s.phone || '', contactPerson: s.contactPerson || '',
    bank: s.bank || '', bankBranch: s.bankBranch || '', accountNumber: s.accountNumber || '',
  };
}
export function supplierRecordOf(f: SupplierForm, color: string): SupplierRecord {
  return {
    name: f.name.trim(), phone: f.phone.trim(), bank: f.bank.trim(), bankBranch: f.bankBranch.trim(), accountNumber: f.accountNumber.trim(),
    companyNumber: f.companyNumber.trim(), contactPerson: f.contactPerson.trim(), color,
  };
}
