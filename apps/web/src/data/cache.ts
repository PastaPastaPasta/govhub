// IndexedDB cache for proven Platform query results, so a reload paints instantly while the
// fresh proven read runs. Cached values are shown with their original height and age.
const DB = 'govhub';
const STORE = 'docs';

export interface CacheEntry<T> {
  value: T;
  height: number | null;
  /** ms */
  savedAt: number;
}

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

export async function cacheGet<T>(key: string): Promise<CacheEntry<T> | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as CacheEntry<T> | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function cachePut<T>(key: string, value: T, height: number | null): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ value, height, savedAt: Date.now() } satisfies CacheEntry<T>, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function cacheClear(): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Deletes the entries whose key matches (e.g. one profile's document cache when the user leaves it). */
export async function cacheDeleteWhere(match: (key: string) => boolean): Promise<void> {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (typeof c.key === 'string' && match(c.key)) tx.objectStore(STORE).delete(c.key);
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
