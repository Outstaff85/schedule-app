// The values of a contract's marks for one worker (docs/contracts.md → Signing, D3; the marks
// in docs/contracts-plan.md → D2 → The marks). Printed in Hebrew, as Form 101, except a
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
