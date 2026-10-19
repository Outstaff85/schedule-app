// The browser backend for the new pages: firestore-backend.js (built from
// src/lib/firestore-backend.ts, loaded once as a plain script; it defines
// initFirestoreBackend()) — the same file and sign-in the manager page uses,
// so the version check sees one file. docs/backend.md → Browser data layer.
import type { FirestoreBackend } from './firestore-backend';

export type Backend = FirestoreBackend;

let loading: Promise<Backend> | null = null;

declare global { interface Window { __fsBackendLoad?: Promise<Backend> } }

export function loadBackend(): Promise<Backend> {
  if (loading) return loading;
  // One load per page (the manager page's loadFirestoreBackend keeps the same promise on window).
  if (window.__fsBackendLoad) return (loading = window.__fsBackendLoad);
  loading = new Promise<Backend>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = '/firestore-backend.js';
    el.onload = () => window.initFirestoreBackend!().then(resolve, reject);
    el.onerror = () => reject(new Error('firestore-backend.js failed to load'));
    document.head.appendChild(el);
  }).catch(e => { loading = null; window.__fsBackendLoad = undefined; throw e; });
  window.__fsBackendLoad = loading;
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
