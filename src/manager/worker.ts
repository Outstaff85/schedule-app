// The worker window's rules (docs/workers.md → Worker modal, Saving), as the
// old showWorkerModal / saveWorkerNow had them: the form's fields, the scan
// fields a document scan fills, what the save writes and when a save is
// "nothing changed" or rebuilds the Form 101. Form 101 labels are Hebrew
// (CLAUDE.md → UI text language), like the printed form.
import type { Child, DayShift, WorkerRecord } from './bridge';
import { localYMD } from '@/lib/payroll';

/** The form's fields, as strings (the inputs' values). */
export type WorkerForm = {
  docGiven: string; docSurname: string; docId: string; docExpiry: string; docSex: string;
  maritalStatus: string; healthFund: string; docDob: string; phone: string;
  address: string; houseNumber: string; city: string;
  supplierId: string; hrId: string; startDate: string;
  expiryEnabled: boolean; expiryMonths: string; expiryWarnMonths: string; notes: string;
  incomeType: string; otherIncomeType: string;
  spouseSurname: string; spouseGiven: string; spouseId: string; spouseDob: string; spouseIncome: string;
};
export type FormKey = keyof WorkerForm;

/** The scan fields: the page of the document they are printed on, the Hebrew label, Israeli ID only. */
export const SCAN_FIELDS: Record<string, { page: 'front' | 'sefach'; label: string; passportLabel?: string; idOnly?: boolean }> = {
  docGiven: { page: 'front', label: 'שם פרטי' },
  docSurname: { page: 'front', label: 'שם משפחה' },
  docId: { page: 'front', label: 'מספר זהות', passportLabel: 'מספר דרכון' },
  docDob: { page: 'front', label: 'תאריך לידה' },
  docSex: { page: 'front', label: 'מין' },
  address: { page: 'sefach', label: 'רחוב', idOnly: true },
  houseNumber: { page: 'sefach', label: 'מס׳ בית', idOnly: true },
  city: { page: 'sefach', label: 'ישוב', idOnly: true },
};
export const scanLabel = (key: string, docType?: string) =>
  (docType === 'passport' && SCAN_FIELDS[key].passportLabel) || SCAN_FIELDS[key].label;

/** The scan fields a set of values lacks (Israeli ID: the address too). */
export function missingScanKeys(vals: Record<string, unknown>, docType?: string): string[] {
  const isId = (docType || 'israeli_id') !== 'passport';
  return Object.keys(SCAN_FIELDS).filter(k => (isId || !SCAN_FIELDS[k].idOnly) && !String(vals[k] ?? '').trim());
}

// An ID / passport number older records kept inside `address` ("ת.ז. 123…", "Passport X").
const LEGACY_DOC_IN_ADDRESS = /^\s*(?:ת\.ז\.|Passport)\s*(\S+)\s*$/;
export function workerDocId(w: WorkerRecord): string {
  if (w.docId) return w.docId;
  const m = LEGACY_DOC_IN_ADDRESS.exec(w.address || '');
  return m ? m[1] : '';
}
export function workerAddress(w: WorkerRecord): string {
  const addr = w.address || '';
  if (w.docId) return addr;
  return LEGACY_DOC_IN_ADDRESS.test(addr) ? '' : addr;
}
/** The scan fields as the worker card reads them (the legacy number in `address` counts). */
export function recordScanValues(w: WorkerRecord): Record<string, string> {
  return { docGiven: w.docGiven || '', docSurname: w.docSurname || '', docId: workerDocId(w), docDob: w.docDob || '', docSex: w.docSex || '',
    address: workerAddress(w), houseNumber: w.houseNumber || '', city: w.city || '' };
}

export const INCOME_LABELS: Record<string, string> = { monthly: 'משכורת חודשית', secondary: 'משרה נוספת', partial: 'משרה חלקית', daily: 'שכר יומי', pension: 'פנסיה', scholarship: 'מלגה' };
export const OTHER_INCOME_LABELS: Record<string, string> = { none: 'אין הכנסה נוספת', ...INCOME_LABELS };
export const MARITAL_LABELS: Record<string, string> = { marital_single: 'רווק/ה', marital_married: 'נשוי/אה', marital_divorced: 'גרוש/ה', marital_widowed: 'אלמן/ה' };
export const HEALTH_FUND_LABELS: Record<string, string> = { Clalit: 'כללית', Maccabi: 'מכבי', Meuhedet: 'מאוחדת', Leumit: 'לאומית' };
export const SEX_LABELS: Record<string, string> = { M: 'זכר', F: 'נקבה' };
export const SPOUSE_INCOME_LABELS: Record<string, string> = { none: 'אין לבן/בת הזוג כל הכנסה', work: 'יש הכנסה: עבודה/קצבה/עסק', other: 'יש הכנסה: הכנסה אחרת' };
export const WORKER_DOC_TYPES: Record<string, string> = { contract: 'Contract', visa: 'Visa', work_permit: 'Work permit', other: 'Other' };
export const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/** The form's starting values. A record older than the given name / surname split shows `name` split. */
export function formOf(w: WorkerRecord): WorkerForm {
  let given = w.docGiven || '', surname = w.docSurname || '';
  if (!given && !surname && w.name) {
    const parts = String(w.name).trim().split(/\s+/);
    given = parts[0] || ''; surname = parts.slice(1).join(' ');
  }
  return {
    docGiven: given, docSurname: surname, docId: workerDocId(w), docExpiry: w.docExpiry || '', docSex: w.docSex || '',
    maritalStatus: w.maritalStatus || '', healthFund: w.healthFund || '', docDob: w.docDob || '', phone: w.phone || '',
    address: workerAddress(w), houseNumber: w.houseNumber || '', city: w.city || '',
    supplierId: w.supplierId || '', hrId: w.hrId || '',
    startDate: w.startDate || w.workStartDate || localYMD(new Date()),
    expiryEnabled: !!w.expiryEnabled, expiryMonths: String(w.expiryMonths || 9), expiryWarnMonths: String(w.expiryWarnMonths ?? 1), notes: w.notes || '',
    incomeType: w.incomeType || 'monthly', otherIncomeType: w.otherIncomeType || 'none',
    spouseSurname: w.spouseSurname || '', spouseGiven: w.spouseGiven || '', spouseId: w.spouseId || '', spouseDob: w.spouseDob || '', spouseIncome: w.spouseIncome || '',
  };
}

const OFF: DayShift = { type: 'off', start: null, end: null };

/** What a save writes onto the record (`commonFields`). The roster only when it was opened. */
export function commonFields(v: WorkerForm, o: {
  status: string; colorIdx: number; children: Child[]; clientIds: string[]; docType: string;
  roster: DayShift[] | null; prevSchedule: DayShift[] | null;
}): Partial<WorkerRecord> {
  const t = (s: string) => String(s || '').trim();
  const docGiven = t(v.docGiven), docSurname = t(v.docSurname);
  const spouseSurname = t(v.spouseSurname), spouseGiven = t(v.spouseGiven), spouseId = t(v.spouseId);
  // A spouse filled in with no marital status is married.
  const maritalStatus = !v.maritalStatus && (spouseSurname || spouseGiven || spouseId) ? 'marital_married' : v.maritalStatus;
  const startDate = v.startDate || '';
  return {
    name: (docGiven + ' ' + docSurname).trim(), colorIdx: o.colorIdx, phone: t(v.phone), status: o.status,
    startDate, workStartDate: startDate, docSex: v.docSex || '',
    expiryEnabled: !!v.expiryEnabled, expiryMonths: parseInt(v.expiryMonths) || 9, expiryWarnMonths: parseInt(v.expiryWarnMonths) || 0,
    docId: t(v.docId), address: t(v.address), houseNumber: t(v.houseNumber), city: t(v.city), docDob: t(v.docDob), docExpiry: t(v.docExpiry), notes: t(v.notes),
    incomeType: v.incomeType || '', otherIncomeType: v.otherIncomeType || '', docSurname, docGiven, maritalStatus, healthFund: v.healthFund || '',
    docChildren: o.children.map(c => ({ name: t(c.name), idNo: t(c.idNo), dob: t(c.dob) })).filter(c => c.name || c.idNo || c.dob),
    clientIds: [...o.clientIds],
    schedule: o.roster ? o.roster.map(d => ({ type: d.type, start: d.type === 'work' ? d.start || null : null, end: d.type === 'work' ? d.end || null : null }))
      : o.prevSchedule || [0, 1, 2, 3, 4, 5, 6].map(() => ({ ...OFF })),
    spouseSurname, spouseGiven, spouseId, spouseDob: t(v.spouseDob), spouseIncome: v.spouseIncome || '',
    supplierId: v.supplierId || null,
    docType: o.docType,
  };
}

const norm = (v: unknown) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? '' : JSON.stringify(v));
/** An edit closed with nothing changed in the form's fields. */
export const sameFields = (fields: Partial<WorkerRecord>, prev: WorkerRecord) =>
  Object.keys(fields).every(k => norm(fields[k]) === norm(prev[k]));

/** The fields printed on the Form 101: a change rebuilds the stored PDF. */
export const FORM101_WATCHED = ['docId', 'address', 'houseNumber', 'city', 'incomeType', 'otherIncomeType',
  'docSurname', 'docGiven', 'maritalStatus', 'healthFund', 'workStartDate', 'phone', 'docSex', 'docDob', 'docChildren',
  'spouseSurname', 'spouseGiven', 'spouseId', 'spouseDob', 'spouseIncome'];
export const form101Changed = (prev: WorkerRecord, next: WorkerRecord) =>
  FORM101_WATCHED.some(f => JSON.stringify(prev[f]) !== JSON.stringify(next[f]));

/** A new worker matching an existing one: only non-empty values overwrite, the roster, status and colour stay, clients merge. */
export function mergeIntoDuplicate(fields: Partial<WorkerRecord>, dupClientIds: string[]): Partial<WorkerRecord> {
  const out: Partial<WorkerRecord> = {};
  const blank = (v: unknown) => v === '' || v == null || (Array.isArray(v) && !v.length);
  Object.keys(fields).forEach(k => { if (!blank(fields[k]) && !['schedule', 'status', 'colorIdx'].includes(k)) out[k] = fields[k]; });
  if (out.clientIds) out.clientIds = [...new Set([...dupClientIds, ...out.clientIds])];
  return out;
}

/** "DD/MM/YYYY" for a stored YYYY-MM-DD, else the value as it is. */
export function fmtDMY(s?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || '';
}
