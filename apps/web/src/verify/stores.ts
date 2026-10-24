// IndexedDB stores for the verification worker: the verified header run per network (@govhub/dapi HeaderStore) and proven
// ProRegTx facts (ProRegCache). Both hold only what this browser verified; a missing or broken database just means "cold".
import type { HeaderStore, ProRegCache, ProRegInfo, StoredChain } from '@govhub/dapi';

const DB = 'govhub-verify';
const CHAINS = 'chains';
const PROREG = 'proreg';

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CHAINS);
      req.result.createObjectStore(PROREG);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined);
        const tx = d.transaction(store, mode);
        const req = f(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      }),
  );
}

/** One verified header run per network. It does not depend on which nodes served it (it is verified from the pinned checkpoint). */
export function headerStore(scope: string): HeaderStore {
  return {
    load: async (network) => (await run<StoredChain>(CHAINS, 'readonly', (s) => s.get(`${scope}:${network}`))) ?? null,
    save: async (chain) => void (await run(CHAINS, 'readwrite', (s) => void s.put(chain, `${scope}:${chain.network}`))),
  };
}

/** ProRegTx facts never change (type and collateral are fixed at registration), so entries never expire. */
export function proRegCache(network: string): ProRegCache {
  return {
    async load(hashes) {
      const out = new Map<string, ProRegInfo>();
      const d = await db();
      if (!d) return out;
      await new Promise<void>((resolve) => {
        const tx = d.transaction(PROREG, 'readonly');
        const st = tx.objectStore(PROREG);
        for (const h of hashes) {
          const req = st.get(`${network}:${h}`);
          req.onsuccess = () => { if (req.result) out.set(h, req.result as ProRegInfo); };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      return out;
    },
    async save(entries) {
      await run(PROREG, 'readwrite', (s) => {
        for (const [h, v] of entries) s.put(v, `${network}:${h}`);
      });
    },
  };
}
