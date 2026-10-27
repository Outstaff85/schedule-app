// The client's sign page's only server: the `sign_documents` function with the link's token (`clientToken`,
// functions/client_signing.py → run_public). No login: the token reaches this one request and nothing else.
export const SIGN_FN_URL = 'https://europe-west3-schedule-odinson.cloudfunctions.net/sign_documents';

/** The link's token (?t=…); '' when the page was opened without one. */
export const linkToken = (): string => new URLSearchParams(location.search).get('t') || '';

export async function clientSignFn<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(SIGN_FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, clientToken: linkToken() }) });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || !json.ok) throw new Error((json && json.error) || 'HTTP ' + resp.status);
  return json as T;
}

export type Mine = {
  status: 'sent' | 'signing' | 'signed'; templateName: string; firm: string; signDate?: string | null; dateFixed?: boolean;
  details: Record<string, string>;
};
