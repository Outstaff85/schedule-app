// The contract templates' server calls (functions/contracts.py, the `contract_templates`
// function; docs/contracts.md → Contract templates): the firm's list, a template's file or its
// sample filled with made-up data, the upload made light (prepare → save), rename / category /
// default (update), delete. Each call carries the login's ID token; a super-admin works in the
// firm it is viewing (asTenantId).
import { CONTRACTS_FN_URL } from './logic/functions';
import { loadFirestoreBackend } from './data/api';
import { gsAuth } from './data/session';

/** A mark placed by hand on a page (a page that is a picture, or a mark the search missed): PDF points from the page's top left. */
export type Placed = { mark: string; page: number; x: number; y: number; w: number; h: number; rtl?: boolean };
export type ContractTemplate = {
  id: string; name: string; category?: string; isDefault?: boolean; size?: number; origSize?: number; pages?: number;
  createdAt?: string; updatedAt?: string; version?: number; marks?: string[]; unknown?: string[]; placed?: Placed[];
  workerId?: string | null; signedCount?: number; pictures?: number[];
  /** the firm's signature and stamp at the bottom right of every page (absent: a template saved before it — off) */
  sealEveryPage?: boolean;
};
export type Prepared = {
  lightBase64: string; sampleBase64: string; origSize: number; lightSize: number; pictures: number[];
  marks: string[]; unknown: string[]; pages: { w: number; h: number; png: string }[]; heavy: boolean;
};

/** The marks a template may carry, in the order docs/contracts.md → The marks lists them (functions/contracts.py MARKS). */
export const MARKS = ['given', 'surname', 'full_name', 'id', 'id_type', 'id_expiry', 'dob', 'sex', 'marital', 'phone', 'address', 'city',
  'full_address', 'health_fund', 'start_date', 'end_date', 'contract_months', 'site', 'supplier', 'schedule', 'rate', 'pay_mode', 'ot_rate',
  'shabbat_rate', 'travel', 'bank', 'company', 'company_address', 'company_phone', 'deductions_file', 'company_signature', 'stamp',
  'terms_1', 'terms_2', 'terms_3', 'terms_4', 'terms_5', 'signature', 'sign_date', 'today'] as const;
/** The firm's signature and stamp (functions/seal.py): pictures drawn at their marks — the signature first, the stamp over it. */
export const SEAL_MARKS = ['company_signature', 'stamp'];
/** The marks filled from the worker's pay (only for a login that may see pay — D3). */
export const PAY_MARKS = ['rate', 'pay_mode', 'ot_rate', 'shabbat_rate', 'travel', 'bank'];

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const idToken = await (await loadFirestoreBackend()).idToken();
  const resp = await fetch(CONTRACTS_FN_URL, {
    method: 'POST',
    headers: idToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken } : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...gsAuth(), ...body }),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.ok) throw new Error((json && json.error) || 'HTTP ' + resp.status);
  return json as T;
}

export type SealFlags = { hasStamp: boolean; hasSignature: boolean };
export const listTemplates = (workerId?: string) =>
  call<{ templates: ContractTemplate[]; canManage: boolean; canFirmSign?: boolean; seal?: SealFlags }>({ action: 'list', ...(workerId ? { workerId } : {}) });
export const templateFile = (id: string, sample = false) => call<{ pdfBase64: string; name: string }>({ action: 'file', id, sample });
/** A PDF, or a Word file (.docx — the server has it turned into a PDF first, D7). */
export const prepareTemplate = (b64: string, name: string, word = false, sealEveryPage = true) =>
  call<Prepared>({ action: 'prepare', [word ? 'docxBase64' : 'pdfBase64']: b64, name, sealEveryPage });
export const isWordFile = (f: File) => /\.docx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEMPLATE_ACCEPT = 'application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const sampleTemplate = (pdfBase64: string, placed: Placed[], sealEveryPage = true) =>
  call<{ sampleBase64: string }>({ action: 'sample', pdfBase64, placed, sealEveryPage });
export const saveTemplate = (b: {
  pdfBase64: string; name: string; category?: string; placed?: Placed[]; origSize?: number; workerId?: string; replaceId?: string; sealEveryPage?: boolean;
}) => call<{ template: ContractTemplate }>({ action: 'save', ...b });
export const updateTemplate = (id: string, ch: { name?: string; category?: string; isDefault?: boolean; sealEveryPage?: boolean }) =>
  call<{ template: ContractTemplate }>({ action: 'update', id, ...ch });
export const deleteTemplate = (id: string) => call<{ ok: true }>({ action: 'delete', id });

/** The firm's signature and stamp (functions/seal.py; docs/contracts.md → The firm's signature and stamp): whether each
 * is set and, for a login that may change them, small previews (base64 PNG). `tenantId`: the firm a super-admin edits. */
export type SealKind = 'stamp' | 'signature';
export type SealInfo = SealFlags & {
  canFirmSign: boolean; previews?: { stamp: string | null; signature: string | null }; signatureWay?: 'drawn' | 'upload' | null; preview?: string;
};
const firm = (tenantId?: string | null) => (tenantId ? { asTenantId: tenantId } : {});
export const sealInfo = (tenantId?: string | null) => call<SealInfo>({ action: 'seal', ...firm(tenantId) });
/** A picture (any image, its paper made transparent on the server) or the signature drawn on the pad (`drawn`). */
export const saveSeal = (kind: SealKind, imageBase64: string, drawn = false, tenantId?: string | null) =>
  call<SealInfo>({ action: 'sealSave', kind, imageBase64, drawn, ...firm(tenantId) });
export const deleteSeal = (kind: SealKind, tenantId?: string | null) => call<SealInfo>({ action: 'sealDelete', kind, ...firm(tenantId) });

/** A PDF in base64 opened in a new tab (a template, its sample). */
export function openPdf(b64: string, name = 'contract.pdf'): void {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  openPdfBlob(new Blob([bytes], { type: 'application/pdf' }), name);
}
/** A PDF opened in a new tab (or saved, when the browser blocks the tab) — Download data's answer. */
export function openPdfBlob(blob: Blob, name = 'data.pdf'): void {
  const url = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }));
  const win = window.open(url, '_blank', 'noopener');
  if (!win) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** "2.4 MB" / "180 KB". */
export function sizeText(n?: number): string {
  const v = Number(n || 0);
  return v >= 1024 * 1024 ? (Math.round(v / 1024 / 102.4) / 10) + ' MB' : Math.max(1, Math.round(v / 1024)) + ' KB';
}
/** The default template of a category (or of the firm's templates, when the category has none). */
export function defaultFor(list: ContractTemplate[], category?: string): ContractTemplate | null {
  const firm = list.filter(t => !t.workerId);
  return firm.find(t => t.isDefault && (t.category || '') === (category || '')) || null;
}
