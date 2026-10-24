// Ids the app makes on the device (from schedule-manager.html).
/** a record's id (a worker, client, supplier, punch…) */
export function uid(): string { return 'id' + Math.random().toString(36).slice(2, 9); }
/**
 * A worker's punch-link token: 16 random bytes from crypto.getRandomValues as
 * base64url (22 characters, 128 bits) — the link alone opens the worker's
 * page, so it must not be guessable. The server makes the same kind
 * (portal.py supplierAddWorker: secrets.token_urlsafe(16)); older 8-character
 * tokens keep working.
 */
export function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
