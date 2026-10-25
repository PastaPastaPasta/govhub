// IndexedDB stores for the verification worker: the verified header run per network (@govhub/dapi HeaderStore), proven
// ProRegTx facts (ProRegCache) and superblock coinbases read from the verified chain (SuperblockCache). All hold only what this
// browser verified; a missing or broken database just means "cold".
import type { HeaderStore, Network, ProRegCache, ProRegInfo, StoredChain } from '@govhub/dapi';
import type { SuperblockCache, SuperblockCoinbase } from './chain.ts';

const DB = 'govhub-verify';
const CHAINS = 'chains';
const PROREG = 'proreg';
const SUPERBLOCKS = 'superblocks';
/** At most this many cached superblock coinbases (testnet has one an hour); past it the store starts over. */
const MAX_CACHED_SUPERBLOCKS = 20_000;

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      for (const name of [CHAINS, PROREG, SUPERBLOCKS]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      // another tab (or worker) asking for a newer version must not be blocked by this connection: close it, reopen on next use
      req.result.onversionchange = () => {
        req.result.close();
        dbp = null;
      };
      resolve(req.result);
    };
    // cold for now, but a later call tries again (e.g. once an old tab holding version 1 has closed)
    const fail = () => {
      dbp = null;
      resolve(null);
    };
    req.onerror = fail;
    req.onblocked = fail;
  });
  return dbp;
}

function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined);
        let tx: IDBTransaction, req: IDBRequest<T> | void;
        try {
          tx = d.transaction(store, mode);
          req = f(tx.objectStore(store));
        } catch {
          return resolve(undefined); // the connection was closed for a newer version meanwhile
        }
        tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      }),
  );
}

/**
 * One verified header run per network and scope ('chain': proof of work; 'qchain': ChainLock-anchored, with the last proven state). It
 * does not depend on which nodes or proof sources served it (it is verified from the pinned checkpoint).
 */
export function headerStore<T extends { network: Network } = StoredChain>(scope: string): HeaderStore<T> {
  return {
    load: async (network) => (await run<T>(CHAINS, 'readonly', (s) => s.get(`${scope}:${network}`))) ?? null,
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
        let tx: IDBTransaction;
        try {
          tx = d.transaction(PROREG, 'readonly');
        } catch {
          return resolve(); // the connection was closed for a newer version meanwhile
        }
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

/**
 * Superblock coinbases of `network` by height. An entry is used only for the block hash the verified chain has at that height
 * (verify/chain.ts), so a reorganised or forged entry is never read as a fact. Bounded: past MAX_CACHED_SUPERBLOCKS it is cleared.
 */
export function superblockCache(network: Network): SuperblockCache {
  let puts = 0;
  return {
    get: (height) => run<SuperblockCoinbase>(SUPERBLOCKS, 'readonly', (s) => s.get(`${network}:${height}`)),
    async put(height, value) {
      if (puts++ % 100 === 0 && ((await run<number>(SUPERBLOCKS, 'readonly', (s) => s.count())) ?? 0) >= MAX_CACHED_SUPERBLOCKS) {
        await run(SUPERBLOCKS, 'readwrite', (s) => void s.clear());
      }
      await run(SUPERBLOCKS, 'readwrite', (s) => void s.put(value, `${network}:${height}`));
    },
  };
}
