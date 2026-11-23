/**
 * Translation cache backed by IndexedDB (available in the service worker).
 *
 * Keyed by provider + model + languages + skill fingerprint + source text, so a page
 * that is re-translated with the same settings costs nothing. Entries expire by TTL.
 */
export interface CacheEntry {
  key: string;
  translation: string;
  createdAt: number;
  provider: string;
  sourceLang: string;
  targetLang: string;
}

const DB_NAME = 'lingo-context';
const DB_VERSION = 1;
const STORE = 'translations';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const request = run(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export async function cacheGetMany(keys: string[], ttlDays: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const db = await openDb();
  const cutoff = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : 0;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    let pending = keys.length;
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (entry && (!cutoff || entry.createdAt >= cutoff)) out.set(key, entry.translation);
        if (--pending === 0) resolve();
      };
      req.onerror = () => {
        if (--pending === 0) resolve();
      };
    }
    if (keys.length === 0) resolve();
  });
  return out;
}

export async function cachePutMany(entries: CacheEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const entry of entries) store.put(entry);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Cache write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Cache write aborted'));
  });
}

export async function cacheStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb();
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const countReq = store.count();
    let count = 0;
    let bytes = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const value = cursor.value as CacheEntry;
        bytes += (value.translation?.length ?? 0) + (value.key?.length ?? 0) + 64;
        cursor.continue();
      }
    };
    countReq.onsuccess = () => {
      count = countReq.result;
    };
    transaction.oncomplete = () => resolve({ count, bytes });
    transaction.onerror = () => resolve({ count: 0, bytes: 0 });
  });
}

export async function cacheClear(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}

export async function cachePrune(ttlDays: number): Promise<number> {
  if (ttlDays <= 0) return 0;
  const cutoff = Date.now() - ttlDays * 86_400_000;
  const db = await openDb();
  return new Promise((resolve) => {
    let removed = 0;
    const transaction = db.transaction(STORE, 'readwrite');
    const index = transaction.objectStore(STORE).index('createdAt');
    const req = index.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      removed++;
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(removed);
    transaction.onerror = () => resolve(removed);
  });
}
