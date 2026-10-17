// The browser backend for the new pages: firestore-backend.js (an old-page
// file, loaded once as a plain script; it defines initFirestoreBackend()) —
// the same sign-in the old pages use. Only what the new pages call is typed.
// docs/backend.md → firestore-backend.js.

export interface Backend {
  currentUser(): { uid: string } | null;
  signOut(): Promise<void>;
  idToken(): Promise<string>;
  /** the login's hours ticks (claim hp) */
  hourPerms(): Promise<string[]>;
  /** the supplier portal tabs this login may use (claim ss; none stored = all three) */
  supplierSections(): Promise<string[]>;
  handleAction(action: string, params: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window { initFirestoreBackend?: () => Promise<Backend> }
}

let loading: Promise<Backend> | null = null;

export function loadBackend(): Promise<Backend> {
  if (loading) return loading;
  loading = new Promise<Backend>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = '/firestore-backend.js';
    el.onload = () => window.initFirestoreBackend!().then(resolve, reject);
    el.onerror = () => reject(new Error('firestore-backend.js failed to load'));
    document.head.appendChild(el);
  }).catch(e => { loading = null; throw e; });
  return loading;
}

/** A plain script from the CDN, once (SheetJS for the Excel export — the old pages' loadXlsx). */
const scripts: Record<string, Promise<void>> = {};
export function loadScript(src: string): Promise<void> {
  return scripts[src] || (scripts[src] = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => { delete scripts[src]; el.remove(); reject(new Error('Script not loaded: ' + src)); };
    document.head.appendChild(el);
  }));
}
export const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
