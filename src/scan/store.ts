// The scan window's batches kept on this phone (IndexedDB) until Done has read them, for 3 minutes at most
// (owner, 2026-10-20 — as long as the lab page stays loaded, lab.ts):
// a window closed by mistake, or a page the phone reloaded, opens again with them (docs/scan.md →
// The scan window → Batches). Only on this device; nothing here goes to a server.
const DB = 'scanner', STORE = 'batches', KEY = 'current', KEEP_MS = 3 * 60 * 1000;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { d.close(); }
}

/** The batches kept, or null (none, older than 3 minutes — then cleared —, or no storage here). */
export async function loadBatches<B>(): Promise<B[] | null> {
  try {
    const v = await run<{ at: number; batches: B[] } | undefined>('readonly', s => s.get(KEY));
    if (v && Date.now() - v.at > KEEP_MS) { await run('readwrite', s => s.delete(KEY)); return null; }
    if (!v || !Array.isArray(v.batches)) return null;
    return v.batches;
  } catch { return null; }
}

/** Keeps the batches (an empty list clears them). Never throws. */
export async function saveBatches<B>(batches: B[]): Promise<void> {
  try {
    if (!batches.length) await run('readwrite', s => s.delete(KEY));
    else await run('readwrite', s => s.put({ at: Date.now(), batches }, KEY));
  } catch { /* private mode or full: kept only while the window is open */ }
}
