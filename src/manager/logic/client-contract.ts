// A client's contract — the manager app's side (docs/contracts.md → Client contracts): the calls to the
// `sign_documents` function's client actions (functions/client_signing.py) with the login's ID token, the
// WhatsApp message and link, and the client's details a signing brings back, taken onto the client's EMPTY
// contact fields only (what the firm typed is never overwritten). Pure apart from the call; never draws.
import { signCall } from './signing';

export type ClientDetails = {
  name?: string; companyNumber?: string; address?: string; contactPhone?: string; email?: string; signerName?: string; signerRole?: string;
};
export type ClientSignRequest = {
  id: string; clientId: string; status: 'sent' | 'signing' | 'signed' | 'replaced' | 'withdrawn'; way?: 'remote' | 'person';
  templateId?: string; templateName?: string; templateVersion?: number; signDate?: string | null; dateFixed?: boolean;
  sentAt?: string; sentBy?: string; signedAt?: string; signedAtIso?: string; appliedAt?: string; expiresAt?: string; withdrawnWhy?: string;
  part?: { path: string; name: string; size: number }; clientDetails?: ClientDetails;
};

/** A document of the client (tenants/<t>/clients/<c>/docs/<request id>, written once by the server when a signed contract's PDF is built). */
export type ClientDoc = {
  id: string; type: 'contract'; name: string; fileId: string; path: string; mediaType?: string; size?: number; uploadedAt?: string;
  signed?: boolean; signedAt?: string | null; signDate?: string | null; signRequestId?: string; templateId?: string; templateName?: string;
};
/** One line of the client window's signed contracts: from the client's documents, or a signed request not among them yet. */
export type SignedLine = { id: string; name: string; path: string; signDate: string; signedAt: string; from: 'doc' | 'request' };

/** The client's signed contracts: its documents first, then (a fallback) a signed request whose entry is not there yet; newest first. */
export function signedLines(docs: ClientDoc[] | null, reqs: ClientSignRequest[] | null): SignedLine[] {
  const out: SignedLine[] = (docs || []).filter(d => d.type === 'contract' && d.path).map(d => ({
    id: d.signRequestId || d.id, name: d.name, path: d.path, signDate: d.signDate || '', signedAt: d.signedAt || d.uploadedAt || '', from: 'doc' as const }));
  const have = new Set(out.map(l => l.id));
  for (const r of reqs || [])
    if (r.part && !have.has(r.id)) out.push({ id: r.id, name: r.part.name, path: r.part.path, signDate: r.signDate || '', signedAt: r.signedAtIso || '', from: 'request' });
  return out.sort((a, b) => b.signedAt.localeCompare(a.signedAt));
}

/** The client's details the sign page shows (and the client may change), in its order. */
export const CLIENT_DETAILS: (keyof ClientDetails)[] = ['name', 'companyNumber', 'address', 'contactPhone', 'email', 'signerName', 'signerRole'];
/** The contact fields a signing may fill on the client when they are empty (the name is the firm's own). */
export const TAKE_ON: (keyof ClientDetails)[] = ['companyNumber', 'address', 'contactPhone', 'email', 'signerName', 'signerRole'];

/** A client action of the `sign_documents` function: clientList / clientDocs / clientSend / clientView / clientSign / clientBuild / clientWithdraw / clientApplied. */
export const clientCall = <T = Record<string, unknown>>(body: Record<string, unknown>) => signCall<T>(body);

/** The client's own details from a form or a record (empty ones as ''). */
export function detailsOf(c: Record<string, unknown>): Required<ClientDetails> {
  const out = {} as Required<ClientDetails>;
  for (const k of CLIENT_DETAILS) out[k] = String(c[k] ?? '').trim();
  return out;
}

/** What a signed contract's details add to the client: only the contact fields that are empty now. {} when nothing. */
export function takeOnPatch(current: Record<string, unknown>, signed: ClientDetails | undefined): Partial<ClientDetails> {
  const out: Partial<ClientDetails> = {};
  for (const k of TAKE_ON) {
    const v = String((signed || {})[k] ?? '').trim();
    if (v && !String(current[k] ?? '').trim()) out[k] = v;
  }
  return out;
}

/** The signed contracts of a client not taken on yet (their details not looked at). */
export const toTakeOn = (reqs: ClientSignRequest[]) => reqs.filter(r => r.status === 'signed' && !r.appliedAt);

/** The client's WhatsApp number: digits only, a leading 0 → 972. '' when none. */
export function waPhone(phone: unknown): string {
  return String(phone || '').replace(/\D/g, '').replace(/^0/, '972');
}

/** The WhatsApp text, in the sender's language (`what`: the line on what to do, already translated): the client's name, what to do, the link. */
export function clientSignMessage(name: string, link: string, what: string): string {
  return [String(name || '').trim(), what, link].filter(Boolean).join('\n');
}

/** The wa.me link to the client's contact phone with the message; '' without a phone. */
export function clientWhatsapp(phone: unknown, name: string, link: string, what: string): string {
  const to = waPhone(phone);
  return to ? 'https://wa.me/' + to + '?text=' + encodeURIComponent(clientSignMessage(name, link, what)) : '';
}

/** The client's latest request (not replaced): what its status line says. */
export function latestRequest(reqs: ClientSignRequest[]): ClientSignRequest | null {
  return reqs.filter(r => r.status !== 'replaced').sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))[0] || null;
}
