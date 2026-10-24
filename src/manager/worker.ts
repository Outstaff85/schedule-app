// The worker window's rules (docs/workers.md → Worker modal, Saving), as the
// old showWorkerModal / saveWorkerNow had them: the form's fields, the scan
// fields a document scan fills, what the save writes and when a save is
// "nothing changed" or rebuilds the Form 101. Form 101 labels are Hebrew
// (CLAUDE.md → UI text language), like the printed form.
import type { Child, DayShift, WorkerRecord } from './bridge';
import { localYMD } from '@/lib/payroll';
import { normDigits } from '@/scan-process/ids';

/** The form's fields, as strings (the inputs' values). */
export type WorkerForm = {
  docGiven: string; docSurname: string; docId: string; docExpiry: string; docSex: string;
  maritalStatus: string; healthFund: string; docDob: string; phone: string;
  address: string; houseNumber: string; city: string;
  supplierId: string; hrId: string; startDate: string;
  expiryEnabled: boolean; expiryMonths: string; expiryWarnMonths: string; notes: string;
  incomeType: string; otherIncomeType: string;
  spouseSurname: string; spouseGiven: string; spouseId: string; spouseDob: string; spouseIncome: string;
  /** the contract (docs/contracts.md → The worker's contract): its category, a template for this worker alone ('' = the category's default), the worker's own terms */
  contractCategory: string; contractTemplateId: string; terms1: string; terms2: string; terms3: string; terms4: string; terms5: string;
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
/** The worker has a stored scan: its pages (`scanPages`), or the old sidecar not yet split into pages. */
export function workerHasScan(w: Pick<WorkerRecord, 'scanPages' | 'assetsFileId'> | null | undefined): boolean {
  return !!w && ((Array.isArray(w.scanPages) && w.scanPages.length > 0) || !!w.assetsFileId);
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
    contractCategory: w.contractCategory || '', contractTemplateId: w.contractTemplateId || '',
    ...(Object.fromEntries([0, 1, 2, 3, 4].map(i => ['terms' + (i + 1), (w.contractTerms || [])[i] || ''])) as Pick<WorkerForm, 'terms1' | 'terms2' | 'terms3' | 'terms4' | 'terms5'>),
  };
}

const OFF: DayShift = { type: 'off', start: null, end: null };

/** A document number as it is stored and compared: a passport's without spaces, in capitals; an
 * Israeli ID's digits joined, one typed without its leading 0 (8 digits) padded to 9. */
export function normDocId(v: string, docType?: string): string {
  const s = String(v || '').trim();
  if (docType === 'passport') return s.replace(/\s/g, '').toUpperCase();
  const d = normDigits(s);
  return /^\d{8}$/.test(d) ? d.padStart(9, '0') : d;
}
/** The key two document numbers are matched by (any type): no spaces or dashes, capitals, no leading zeros. */
export function docIdKey(v: string): string {
  const s = String(v || '').replace(/[\s-]/g, '').toUpperCase();
  return /^\d+$/.test(s) ? s.replace(/^0+/, '') : s;
}

/** An edit whose number only differs in form from the stored one (an 8-digit ID now padded, dashes,
 * capitals) keeps the stored form: the signed print's hash and the Form 101 stay as they are. */
export function keepStoredDocId(fields: Partial<WorkerRecord>, prev: WorkerRecord): Partial<WorkerRecord> {
  const stored = String(prev.docId || '');
  if (typeof fields.docId !== 'string' || !stored || fields.docId === stored || (fields.docType || prev.docType || 'israeli_id') !== (prev.docType || 'israeli_id')) return fields;
  return docIdKey(fields.docId) === docIdKey(stored) ? { ...fields, docId: prev.docId } : fields;
}

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
    docId: normDocId(v.docId, o.docType), address: t(v.address), houseNumber: t(v.houseNumber), city: t(v.city), docDob: t(v.docDob), docExpiry: t(v.docExpiry), notes: t(v.notes),
    incomeType: v.incomeType || '', otherIncomeType: v.otherIncomeType || '', docSurname, docGiven, maritalStatus, healthFund: v.healthFund || '',
    docChildren: o.children.map(c => ({ name: t(c.name), idNo: t(c.idNo), dob: t(c.dob) })).filter(c => c.name || c.idNo || c.dob),
    clientIds: [...o.clientIds],
    schedule: o.roster ? o.roster.map(d => ({ type: d.type, start: d.type === 'work' ? d.start || null : null, end: d.type === 'work' ? d.end || null : null }))
      : o.prevSchedule || [0, 1, 2, 3, 4, 5, 6].map(() => ({ ...OFF })),
    spouseSurname, spouseGiven, spouseId, spouseDob: t(v.spouseDob), spouseIncome: v.spouseIncome || '',
    supplierId: v.supplierId || null,
    docType: o.docType,
    contractCategory: t(v.contractCategory), contractTemplateId: v.contractTemplateId || '', contractTerms: contractTerms(v),
  };
}

/** The worker's own terms ({{terms_1}}…{{terms_5}}), without the empty ones at the end. */
export function contractTerms(v: Pick<WorkerForm, 'terms1' | 'terms2' | 'terms3' | 'terms4' | 'terms5'>): string[] {
  const out = [v.terms1, v.terms2, v.terms3, v.terms4, v.terms5].map(s => String(s || '').trim());
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

const norm = (v: unknown) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? '' : JSON.stringify(v));
/** An edit closed with nothing changed in the form's fields: equal to the record, or to the record's
 * own form passed through the same save (the form's defaults — a start date of today, the income
 * types… — are not a change of a record that lacked them). */
export function sameFields(fields: Partial<WorkerRecord>, prev: WorkerRecord): boolean {
  if (Object.keys(fields).every(k => norm(fields[k]) === norm(prev[k]))) return true;
  const base = commonFields(formOf(prev), {
    status: prev.status || 'active', colorIdx: prev.colorIdx || 0,
    children: Array.isArray(prev.docChildren) ? prev.docChildren as Child[] : [], clientIds: prev.clientIds || [],
    docType: prev.docType || 'israeli_id', roster: null, prevSchedule: prev.schedule || null,
  });
  return Object.keys(fields).every(k => norm(fields[k]) === norm(base[k]));
}

/** The fields printed on the Form 101: a change rebuilds the stored PDF. */
export const FORM101_WATCHED = ['docId', 'address', 'houseNumber', 'city', 'incomeType', 'otherIncomeType',
  'docSurname', 'docGiven', 'maritalStatus', 'healthFund', 'workStartDate', 'phone', 'docSex', 'docDob', 'docChildren',
  'spouseSurname', 'spouseGiven', 'spouseId', 'spouseDob', 'spouseIncome'];
export const form101Changed = (prev: WorkerRecord, next: WorkerRecord) =>
  FORM101_WATCHED.some(f => JSON.stringify(prev[f]) !== JSON.stringify(next[f]));

/** The form's own defaults (a new worker's), which a merge into a duplicate never copies. */
const DEFAULTED = ['startDate', 'workStartDate', 'expiryEnabled', 'expiryMonths', 'expiryWarnMonths', 'incomeType', 'otherIncomeType', 'maritalStatus'];

/** A new worker matching an existing one: only values the user entered overwrite — not empty ones, nor the
 * form's defaults (start date, contract warning, income types…), nor the document type unless a scan
 * found it; the roster, status and colour stay, clients merge. */
export function mergeIntoDuplicate(fields: Partial<WorkerRecord>, dupClientIds: string[], o: { scanned?: boolean } = {}): Partial<WorkerRecord> {
  const out: Partial<WorkerRecord> = {};
  const blank = (v: unknown) => v === '' || v == null || (Array.isArray(v) && !v.length);
  const defaults = commonFields(formOf({} as WorkerRecord), { status: 'active', colorIdx: 0, children: [], clientIds: [], docType: 'israeli_id', roster: null, prevSchedule: null });
  const isDefault = (k: string) => DEFAULTED.includes(k) && norm(fields[k]) === norm(defaults[k]);
  Object.keys(fields).forEach(k => {
    if (blank(fields[k]) || ['schedule', 'status', 'colorIdx'].includes(k) || isDefault(k)) return;
    if (k === 'docType' && !o.scanned) return;
    out[k] = fields[k];
  });
  if (out.clientIds) out.clientIds = [...new Set([...dupClientIds, ...out.clientIds])];
  return out;
}

/** "DD/MM/YYYY" for a stored YYYY-MM-DD, else the value as it is. */
export function fmtDMY(s?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s || '';
}
