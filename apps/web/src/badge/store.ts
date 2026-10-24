// Pending badge requests, encrypted at rest (PLAN §8.5: the client keeps the blinded state and finishes the request later, even
// across reloads). A job holds the unblinding factor `inv` (the one secret that links the issuer's view to the final badge) and,
// for the key-paste path, the MN voting key, so it is stored only encrypted:
//   AES-256-GCM, key = HKDF-SHA256(the signed-in identity's private signing key, salt "govhub-badge-store-v1", info identityId),
//   AAD = identityId, a fresh 12-byte IV per save.
// The plaintext is padded to 16 KiB buckets so the stored size does not tell how many MNs a browser requested badges for.
// Without a key-holding session (fixture identities) jobs live in memory only.
import { bytesToBase64 } from '@govhub/badge';
import type { BadgeJob } from './client.ts';

export interface JobStore {
  load(): Promise<BadgeJob[]>;
  save(jobs: BadgeJob[]): Promise<void>;
}

const enc = new TextEncoder();
const BUCKET = 16 * 1024;
export const jobStorageKey = (slot: string) => `govhub.badge.jobs.v1.${slot}`;

const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveStoreKey(secret: Uint8Array, identityId: string): Promise<CryptoKey> {
  if (secret.length !== 32 || secret.every((x) => x === 0)) throw new Error('no signing key in this session');
  const ikm = await crypto.subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('govhub-badge-store-v1'), info: enc.encode(identityId) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function pad(json: string): Uint8Array<ArrayBuffer> {
  const body = enc.encode(json);
  const total = Math.ceil((body.length + 4) / BUCKET) * BUCKET;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}
function unpad(b: Uint8Array): string {
  const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
  if (n > b.length - 4) throw new Error('corrupt badge store');
  return new TextDecoder().decode(b.subarray(4, 4 + n));
}

/**
 * `slot` names the storage entry (identity and signing key id: the encryption key comes from the signing key, and one identity can
 * sign in with several keys). A stored entry that does not decrypt makes load() throw, and the caller never saves over it.
 */
export function encryptedJobStore(slot: string, identityId: string, key: CryptoKey, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): JobStore {
  const aad = enc.encode(identityId);
  return {
    async load() {
      const raw = storage.getItem(jobStorageKey(slot));
      if (!raw) return [];
      const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad }, key, unb64(ct));
      const jobs = JSON.parse(unpad(new Uint8Array(pt))) as BadgeJob[];
      return Array.isArray(jobs) ? jobs.filter((j) => j && j.v === 1 && j.ownerId === identityId) : [];
    },
    async save(jobs) {
      if (!jobs.length) return storage.removeItem(jobStorageKey(slot));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, pad(JSON.stringify(jobs))));
      storage.setItem(jobStorageKey(slot), JSON.stringify({ iv: bytesToBase64(iv), ct: bytesToBase64(ct) }));
    },
  };
}

export function memoryJobStore(): JobStore {
  let jobs: BadgeJob[] = [];
  return { load: async () => jobs.map((j) => ({ ...j })), save: async (j) => void (jobs = j.map((x) => ({ ...x }))) };
}
