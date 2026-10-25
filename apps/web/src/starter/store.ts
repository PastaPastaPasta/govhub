// The finalized starter token, kept until the faucet has paid and the identity exists (so "redeem later", or a reload, can finish
// it). Stored only encrypted, under the same one-time funding key as the account's funding record:
//   AES-256-GCM, key = HKDF-SHA256(funding private key, salt "govhub-starter-store-v1", info network || pubKeyHash),
//   AAD = the storage key `govhub.starter.v1.<network>.<pubKeyHashHex>`, a fresh 12-byte IV per save.
// Only the recovery phrase opens it. Nothing about the masternode or proposal is stored with the token.
//
// Also, under the same key but its own storage name (`govhub.starter.req.v1.<network>.<pubKeyHashHex>`, the AAD), the token REQUESTS
// from just before each is sent until a token is saved, one per (kind, subject): each names its masternode or proposal (proTxHash or
// govHash) and holds the blinding secrets, and is what lets a reload or crash after the issuer recorded that starter send the SAME
// blinded message again (the issuer re-signs it) instead of a new one it would refuse as already used. Trying another masternode or
// proposal never replaces a request for a different one. All are removed once a token is saved: every request is bound to this
// account's funding key, so once the account is funded none of them can fund anything else.
import { hash160, legacyRegistrationFundingPath, registrationFundingPath, wipe, type Network, type SeedWallet } from '@govhub/auth';
import { bytesToBase64, toHex } from '@govhub/badge';
import { fromStoredPending, fundingTarget, toStoredPending, type PendingStarter, type StarterToken, type StoredPending } from './client.ts';

export interface StoredStarter {
  v: 1;
  token: StarterToken;
  /** ms: when to redeem (now, or the random "later" time) */
  dueAt: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const enc = new TextEncoder();
const PREFIX = 'govhub.starter.v1.';
const REQ_PREFIX = 'govhub.starter.req.v1.';
export const starterStorageKey = (network: Network, pubKeyHashHex: string): string => `${PREFIX}${network}.${pubKeyHashHex}`;
const pendingStorageKey = (network: Network, pubKeyHashHex: string): string => `${REQ_PREFIX}${network}.${pubKeyHashHex}`;

const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function storeKey(fundingKey: Uint8Array, network: Network, pubKeyHash: Uint8Array): Promise<CryptoKey> {
  if (fundingKey.length !== 32 || fundingKey.every((x) => x === 0)) throw new Error('no funding key');
  if (pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes');
  const info = new Uint8Array([...enc.encode(network), ...pubKeyHash]);
  const raw = Uint8Array.from(fundingKey);
  let ikm: CryptoKey;
  try {
    ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  } finally {
    raw.fill(0);
  }
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('govhub-starter-store-v1'), info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function saveStarter(storage: Store, fundingKey: Uint8Array, network: Network, pubKeyHash: Uint8Array, entry: StoredStarter): Promise<void> {
  await seal(storage, starterStorageKey(network, toHex(pubKeyHash)), await storeKey(fundingKey, network, pubKeyHash), entry);
}

async function seal(storage: Store, name: string, key: CryptoKey, entry: StoredStarter | StoredPendingList): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, key, enc.encode(JSON.stringify(entry))));
  storage.setItem(name, JSON.stringify({ iv: bytesToBase64(iv), ct: bytesToBase64(ct) }));
}

/** null when nothing is stored; throws when an entry is there but does not decrypt with this key. */
export async function loadStarter(storage: Store, fundingKey: Uint8Array, network: Network, pubKeyHash: Uint8Array): Promise<StoredStarter | null> {
  const e = (await open(storage, starterStorageKey(network, toHex(pubKeyHash)), () => storeKey(fundingKey, network, pubKeyHash))) as StoredStarter | null;
  if (e === null) return null;
  if (e?.v !== 1 || e.token?.network !== network || typeof e.token.sig !== 'string' || typeof e.token.msgPrefix !== 'string') throw new Error('unknown starter entry');
  return e;
}

/** null when nothing is stored under `name`; throws when it does not decrypt. */
async function open(storage: Store, name: string, key: () => Promise<CryptoKey>): Promise<unknown> {
  const raw = storage.getItem(name);
  if (!raw) return null;
  const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(name) }, await key(), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Forgets the token and any request of this setup. */
export function forgetStarter(storage: Store, network: Network, pubKeyHashHex: string): void {
  storage.removeItem(starterStorageKey(network, pubKeyHashHex));
  storage.removeItem(pendingStorageKey(network, pubKeyHashHex));
}

/**
 * The account setups (by pubKeyHash hex) that hold a starter token or an unanswered starter request in this browser for `network`
 * (the sign-in sheet says so; nothing in them is readable without the phrase).
 */
export function pendingStarterKeys(storage: Pick<Storage, 'key' | 'length'>, network: Network): string[] {
  const out = new Set<string>();
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      for (const prefix of [PREFIX, REQ_PREFIX]) if (k?.startsWith(`${prefix}${network}.`)) out.add(k.slice(prefix.length + network.length + 1));
    }
  } catch {
    /* site data blocked: nothing stored */
  }
  return [...out];
}

/**
 * Whether account setup `identityIndex` keeps its starter token or request under the hardened account-setup key govhub used until
 * 2026-10-25, and nothing under today's key. A token is bound to its key's pubKeyHash, so such a setup finishes with that old key
 * (its address, sealer and funding run) instead of stranding the token.
 */
export function starterOnLegacyKey(storage: Pick<Storage, 'getItem'>, wallet: SeedWallet, identityIndex: number): boolean {
  const kept = (legacy: boolean) => {
    const hex = toHex(fundingTarget(wallet, identityIndex, legacy).pubKeyHash);
    return storage.getItem(starterStorageKey(wallet.network, hex)) !== null || storage.getItem(pendingStorageKey(wallet.network, hex)) !== null;
  };
  return !kept(false) && kept(true);
}

/** The seed's funding key for `identityIndex` (the legacy one where starterOnLegacyKey says so), for `fn` only (wiped after). */
async function withFundingKey<T>(storage: Pick<Storage, 'getItem'>, wallet: SeedWallet, identityIndex: number, fn: (priv: Uint8Array, pubKeyHash: Uint8Array) => Promise<T>): Promise<T> {
  const k = wallet.derive((starterOnLegacyKey(storage, wallet, identityIndex) ? legacyRegistrationFundingPath : registrationFundingPath)(wallet.network, identityIndex));
  try {
    return await fn(k.privateKey, hash160(k.publicKey));
  } finally {
    wipe(k.privateKey);
  }
}

export const saveStarterFor = (storage: Store, wallet: SeedWallet, identityIndex: number, entry: StoredStarter): Promise<void> =>
  withFundingKey(storage, wallet, identityIndex, (priv, h) => saveStarter(storage, priv, wallet.network, h, entry));

export interface StarterSealer {
  /** saves the token (and drops the requests: the account it is bound to is now funded) */
  save(entry: StoredStarter): Promise<void>;
  /** keeps the request about to be sent; replaces only an earlier request for the same (kind, subject) */
  savePending(p: PendingStarter): Promise<void>;
  /** drops the request for one (kind, subject) */
  forgetPending(kind: PendingStarter['kind'], subject: string): Promise<void>;
  /** the token and every request */
  forget(): void;
}

/** The stored request list: `{v: 2, list}`; an entry from before the list existed is a single request (v 1). */
interface StoredPendingList {
  v: 2;
  list: StoredPending[];
}
const asList = (x: unknown): StoredPending[] => {
  if (x && typeof x === 'object' && (x as StoredPendingList).v === 2 && Array.isArray((x as StoredPendingList).list)) return (x as StoredPendingList).list;
  if (x && typeof x === 'object' && (x as StoredPending).v === 1) return [x as StoredPending];
  return [];
};
const sameSubject = (a: Pick<StoredPending, 'kind' | 'subject'>, kind: string, subject: string) => a.kind === kind && a.subject === subject;

async function updatePending(storage: Store, name: string, key: CryptoKey, f: (l: StoredPending[]) => StoredPending[]): Promise<void> {
  // an entry that does not open with this key is not ours to overwrite: it throws (the caller treats saving as best effort)
  const list = f(asList(await open(storage, name, async () => key)));
  if (list.length) await seal(storage, name, key, { v: 2, list });
  else storage.removeItem(name);
}

/**
 * Saves and forgets this setup's token without the wallet: the (non-extractable) encryption key is derived up front, so a token
 * that arrives after the sheet closed (and the wallet was wiped) is still kept.
 */
export const starterSealer = (storage: Store, wallet: SeedWallet, identityIndex: number): Promise<StarterSealer> =>
  withFundingKey(storage, wallet, identityIndex, async (priv, h) => {
    const hex = toHex(h);
    const name = starterStorageKey(wallet.network, hex);
    const req = pendingStorageKey(wallet.network, hex);
    const key = await storeKey(priv, wallet.network, h);
    return {
      save: async (e) => {
        await seal(storage, name, key, e);
        storage.removeItem(req);
      },
      savePending: (p) => updatePending(storage, req, key, (l) => [...l.filter((x) => !sameSubject(x, p.kind, p.subject)), toStoredPending(p)]),
      forgetPending: (kind, subject) => updatePending(storage, req, key, (l) => l.filter((x) => !sameSubject(x, kind, subject))),
      forget: () => forgetStarter(storage, wallet.network, hex),
    };
  });

/** The stored starter of this account setup; null when there is none or it does not open. */
export const loadStarterFor = (storage: Store, wallet: SeedWallet, identityIndex: number): Promise<StoredStarter | null> =>
  withFundingKey(storage, wallet, identityIndex, (priv, h) => loadStarter(storage, priv, wallet.network, h)).catch(() => null);

/** The unanswered starter requests of this account setup, oldest first; empty when there are none or they do not open. */
export const loadPendingFor = (storage: Store, wallet: SeedWallet, identityIndex: number): Promise<PendingStarter[]> =>
  withFundingKey(storage, wallet, identityIndex, async (priv, h) => {
    const list = asList(await open(storage, pendingStorageKey(wallet.network, toHex(h)), () => storeKey(priv, wallet.network, h)));
    const out: PendingStarter[] = [];
    for (const x of list) {
      try {
        out.push(await fromStoredPending(x));
      } catch {
        /* a malformed entry is skipped, never trusted */
      }
    }
    return out;
  }).catch(() => []);

/** Drops the stored request for one (kind, subject) of this account setup (e.g. its epoch's issuance has closed). */
export const forgetPendingFor = (storage: Store, wallet: SeedWallet, identityIndex: number, kind: PendingStarter['kind'], subject: string): Promise<void> =>
  withFundingKey(storage, wallet, identityIndex, async (priv, h) =>
    updatePending(storage, pendingStorageKey(wallet.network, toHex(h)), await storeKey(priv, wallet.network, h), (l) => l.filter((x) => !sameSubject(x, kind, subject))),
  ).catch(() => {});

/** Forgets this setup's token and requests, under today's key and the legacy one (the account is funded: neither funds anything else). */
export function forgetStarterFor(storage: Store, wallet: SeedWallet, identityIndex: number): void {
  for (const legacy of [false, true]) forgetStarter(storage, wallet.network, toHex(fundingTarget(wallet, identityIndex, legacy).pubKeyHash));
}
