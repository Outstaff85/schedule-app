// The values of a contract's marks for one worker (docs/contracts.md → Signing, D3; the marks
// in docs/contracts.md → The marks). Printed in Hebrew, as Form 101, except a
// foreign passport's names, which stay in Latin letters. The pay marks are filled only for a
// login that may see pay (`seePay`), otherwise left out — the server refuses a send that
// carries them from a login without it. {{signature}}, {{sign_date}} and {{today}} are the
// server's. Pure: the worker and its context in, the values out.
import { workerAddress, workerDocId } from '../worker';
import { HEALTH_FUND_LABELS, MARITAL_LABELS, SEX_LABELS } from '../worker';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;
const DAYS_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/** YYYY-MM-DD (or DD/MM/YYYY already) → DD/MM/YYYY; '' when empty. */
export function dmy(s: unknown): string {
  const v = String(s || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

function addMonths(ymd: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m || !months) return '';
  const d = new Date(+m[1], +m[2] - 1 + months, +m[3]);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

const money = (v: unknown) => (v === '' || v == null || isNaN(Number(v)) || Number(v) === 0 ? '' : Number(v) + ' ₪');

/** The worker's weekly hours: each work day with its times, Sunday first. */
export function scheduleText(schedule: unknown): string {
  const days = Array.isArray(schedule) ? schedule : [];
  return days.map((d: Rec, i: number) => (d && d.type === 'work' && d.start && d.end ? `${DAYS_HE[i]} ${d.start}–${d.end}` : ''))
    .filter(Boolean).join(', ');
}

export interface ValuesCtx { profile: Rec | null; clients: Rec[]; suppliers: Rec[]; seePay: boolean }

export function contractValues(w: Rec, ctx: ValuesCtx): Record<string, string> {
  const passport = w.docType === 'passport';
  const given = String(w.docGiven || '').trim(), surname = String(w.docSurname || '').trim();
  const street = (workerAddress(w as any) + ' ' + (w.houseNumber || '')).trim();
  const p = ctx.profile || {};
  const firmAddress = [((p.street || '') + ' ' + (p.streetNumber || '')).trim(), p.city].filter(Boolean).join(', ');
  const start = String(w.startDate || w.workStartDate || '');
  const months = Number(w.expiryEnabled ? w.expiryMonths : 0) || 0;
  const terms: string[] = Array.isArray(w.contractTerms) ? w.contractTerms : [];
  const out: Record<string, string> = {
    given, surname, full_name: [given, surname].filter(Boolean).join(' '),
    id: workerDocId(w as any), id_type: passport ? 'דרכון' : 'ת.ז.', id_expiry: dmy(w.docExpiry), dob: dmy(w.docDob),
    sex: SEX_LABELS[w.docSex] || '', marital: MARITAL_LABELS[w.maritalStatus] || '', phone: String(w.phone || ''),
    address: street, city: String(w.city || ''), full_address: [street, w.city].filter(Boolean).join(', '),
    health_fund: HEALTH_FUND_LABELS[w.healthFund] || '',
    start_date: dmy(start), end_date: months ? addMonths(start, months) : '', contract_months: months ? String(months) : '',
    site: (w.clientIds || []).map((id: string) => ctx.clients.find(c => c.id === id)?.name).filter(Boolean).join(', '),
    supplier: (w.supplierId && ctx.suppliers.find(s => s.id === w.supplierId)?.name) || '',
    schedule: scheduleText(w.schedule),
    company: String(p.companyName || ''), company_address: firmAddress, company_phone: String(p.phone || ''),
    deductions_file: String(p.deductionsFileNumber || ''),
  };
  for (let i = 0; i < 5; i++) out['terms_' + (i + 1)] = String(terms[i] || '');
  if (ctx.seePay) {
    const daily = w.payMode === 'daily';
    out.rate = money(w.hourlyRate || w.regRate);
    out.pay_mode = daily ? 'יומי' : 'שעתי';
    out.ot_rate = money(w.otRate);
    out.shabbat_rate = money(w.shabbatRate);
    out.travel = [w.travelAllowance ? money(w.travelAllowance) + ' ליום' : '', w.travelMonthly ? money(w.travelMonthly) + ' לחודש' : ''].filter(Boolean).join(', ');
    out.bank = [w.bank, w.bankBranch && 'סניף ' + w.bankBranch, w.bankAccountNumber && 'חשבון ' + w.bankAccountNumber].filter(Boolean).join(', ');
  }
  return out;
}

/**
 * The values of a client contract's marks (docs/contracts.md → Client contracts), from the client window's live form:
 * the client's details, the firm's marks (as a worker's contract has them), and — only for a login that sees client
 * billing (`seeBilling`, canSeeBilling) — what the client pays: by law / fixed / by the day, its rate, and by law its
 * overtime and Shabbat rates when set. An empty value stays empty. {{client_signature}}, {{client_sign_date}} and
 * {{today}} are the server's.
 */
export function clientContractValues(c: Rec, ctx: { profile: Rec | null; seeBilling: boolean }): Record<string, string> {
  const s = (v: unknown) => String(v ?? '').trim();
  const p = ctx.profile || {};
  const out: Record<string, string> = {
    client_name: s(c.name), client_company_no: s(c.companyNumber), client_address: s(c.address), client_phone: s(c.contactPhone),
    client_email: s(c.email), client_signer: s(c.signerName), client_signer_role: s(c.signerRole),
    company: s(p.companyName), company_address: [((p.street || '') + ' ' + (p.streetNumber || '')).trim(), p.city].filter(Boolean).join(', '),
    company_phone: s(p.phone), deductions_file: s(p.deductionsFileNumber),
  };
  if (ctx.seeBilling) {
    const mode = c.rateMode === 'fixed' ? 'fixed' : c.rateMode === 'daily' ? 'daily' : 'tiered';
    // a client saved before billRate existed: the worker default (as the client window shows it)
    const bill = c.billRate != null && c.billRate !== '' ? c.billRate : c.defaultHourlyRate;
    out.client_rate = mode === 'daily' ? (money(c.dailyBillRate) ? money(c.dailyBillRate) + ' ליום' : '') : money(mode === 'fixed' ? c.fixedBillRate : bill);
    // the mode only with a rate: a client with no billing set prints none
    out.client_pay_mode = !out.client_rate ? '' : mode === 'daily' ? 'יומי' : mode === 'fixed' ? 'שעתי קבוע' : 'שעתי לפי חוק';
    out.client_ot_rate = mode === 'tiered' ? money(c.billOtRate) : '';
    out.client_shabbat_rate = mode === 'tiered' ? money(c.billShabbatRate) : '';
  }
  return out;
}

// ── What the signed documents print about the worker (D4: data changed → a new signature) ──
// The firm's details, signature and stamp: a change of them asks no worker to sign again.
const FIRM_MARKS = ['company', 'company_address', 'company_phone', 'deductions_file', 'company_signature', 'stamp'];
const PAY_MARKS = ['rate', 'pay_mode', 'ot_rate', 'shabbat_rate', 'travel', 'bank'];
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** A short hash of what Form 101 and the contract print about the worker: Form 101's values without the
 * firm's block and the date, and the contract's marks the template prints, without the firm's (a change to
 * the firm's own details asks no worker to sign again). The pay marks count only when they were filled. */
export function printHash(form101: Record<string, unknown>, values: Record<string, string>, marks: string[] | null, withPay: boolean): string {
  const f: Record<string, unknown> = { ...form101 };
  delete f.employer; delete f.signDate; delete f.firmMissing; delete f.signaturePngBase64; delete f.extraPages;
  // street / houseNumber repeat `address` (sent apart for the PDF only): left out, so the hash stays what it was before they were sent.
  delete f.street; delete f.houseNumber;
  const keys = (marks && marks.length ? marks : Object.keys(values))
    .filter(k => k in values && !FIRM_MARKS.includes(k) && (withPay || !PAY_MARKS.includes(k))).sort();
  const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k] ?? null]));
  return hash(sorted(f) + '|' + JSON.stringify(keys.map(k => [k, values[k] || ''])));
}
