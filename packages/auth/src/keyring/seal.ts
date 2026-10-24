// Keyring encryption (forum.keyring). Envelope encryption with a fresh random key per write:
//
//   K          = 32 random bytes, NEW on every write (so nothing is ever encrypted twice under one key and a removed unlocker
//                cannot open later writes)
//   body       = nonce(24) || XChaCha20-Poly1305(K, nonce, AAD, padded plaintext)        split into 4,096-byte fields c0 (c1, c2)
//   AAD        = UTF8("govhub/keyring/v1") || 0x00 || contractId || ownerId || u8 kind || u8 version || u8 bucket || SHA-256(wraps)
//   wraps      = 8 slots x 80 bytes, in random order; each used slot is RFC 9180 HPKE base-mode SealBase(pkR, info, "", K) =
//                enc(32) || ChaCha20-Poly1305 ciphertext of K (48); unused slots are 80 random bytes. A reader tries every slot.
//   info       = UTF8("govhub/keyring/v1/wrap") || 0x00 || contractId || ownerId || u8 kind
//
// Unlockers (pkR):
//   seed     DeriveKeyPair( HKDF-SHA256(ikm = BIP39 entropy, salt = UTF8("govhub/keyring/v1/seed"),
//                                       info = UTF8(network) || 0x00 || ownerId, 32) )
//            The entropy IS the seed (no BIP39 passphrase, PLAN 4.1), so the phrase alone restores the keyring on any device.
//            This public key is never published: it exists only inside the encrypted content.
//   passkey  recipientFromPrf(PRF output) with the passkey vault's PRF input, i.e. the same X25519 key as the passkey's
//            `forum.vault` entry; the different HPKE info keeps the two uses apart. One passkey ceremony opens both.
// A key-paste session holds neither, so it cannot open the keyring.
//
// The chain sees: that the identity has a keyring (and a pending-votes document), the bucket (1 or 2), and when it changes. Not the
// number of keys, masternodes, unlockers or pending votes, nor anything else inside.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes } from '../bytes.ts';
import type { Network } from '../keys.ts';
import { deriveKeyPair, openBase, sealBase, type HpkeKeyPair } from '../vault/hpke.ts';
import { BUCKET_CHUNKS, CHUNK_LENGTH, KEYRING_FORMAT_VERSION, KeyringFormatError, NONCE_LENGTH, plaintextLength, type KeyringKind } from './format.ts';

export const SLOT_COUNT = 8;
export const SLOT_LENGTH = 80;
export const WRAPS_LENGTH = SLOT_COUNT * SLOT_LENGTH;

export class KeyringLockedError extends Error {
  constructor(message = 'This key cannot open the keyring.') {
    super(message);
    this.name = 'KeyringLockedError';
  }
}

const te = new TextEncoder();
const is32 = (b: Uint8Array) => b.length === 32;

/** What is stored in a `forum.keyring` document (besides `kind`). */
export interface SealedKeyring {
  version: number;
  bucket: number;
  wraps: Uint8Array;
  /** c0, c1, c2 */
  chunks: Uint8Array[];
}

export function seedUnlocker(entropy: Uint8Array, network: Network, ownerId: Uint8Array): HpkeKeyPair {
  if (entropy.length !== 16 && entropy.length !== 32) throw new Error('seed entropy must be 16 or 32 bytes');
  if (!is32(ownerId)) throw new Error('owner id must be 32 bytes');
  const ikm = hkdf(sha256, entropy, te.encode('govhub/keyring/v1/seed'), concatBytes(te.encode(network), Uint8Array.of(0), ownerId), 32);
  try {
    return deriveKeyPair(ikm);
  } finally {
    ikm.fill(0);
  }
}

export function wrapInfo(contractId: Uint8Array, ownerId: Uint8Array, kind: KeyringKind): Uint8Array {
  if (!is32(contractId) || !is32(ownerId)) throw new Error('contract and owner ids must be 32 bytes');
  return concatBytes(te.encode('govhub/keyring/v1/wrap'), Uint8Array.of(0), contractId, ownerId, Uint8Array.of(kind));
}

export function bodyAad(contractId: Uint8Array, ownerId: Uint8Array, kind: KeyringKind, version: number, bucket: number, wraps: Uint8Array): Uint8Array {
  if (!is32(contractId) || !is32(ownerId)) throw new Error('contract and owner ids must be 32 bytes');
  return concatBytes(te.encode('govhub/keyring/v1'), Uint8Array.of(0), contractId, ownerId, Uint8Array.of(kind, version, bucket), sha256(wraps));
}

function randomIndex(n: number): number {
  // rejection sampling: uniform in [0, n)
  const lim = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const v = new DataView(randomBytes(4).buffer).getUint32(0);
    if (v < lim) return v % n;
  }
}

/** Seals `plaintext` (already padded to `bucket`'s length) to every recipient. Does not wipe `plaintext` (the caller owns it). */
export function sealKeyring(o: { contractId: Uint8Array; ownerId: Uint8Array; kind: KeyringKind; bucket: number; plaintext: Uint8Array; recipients: Uint8Array[] }): SealedKeyring {
  if (o.plaintext.length !== plaintextLength(o.bucket)) throw new KeyringFormatError('plaintext is not padded to its bucket');
  if (o.recipients.length < 1 || o.recipients.length > SLOT_COUNT) throw new KeyringFormatError(`1 to ${SLOT_COUNT} unlockers`);
  const K = randomBytes(32);
  try {
    const info = wrapInfo(o.contractId, o.ownerId, o.kind);
    const order = Array.from({ length: SLOT_COUNT }, (_, i) => i);
    for (let i = SLOT_COUNT - 1; i > 0; i--) {
      const j = randomIndex(i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const wraps = randomBytes(WRAPS_LENGTH);
    o.recipients.forEach((pk, i) => {
      if (!is32(pk)) throw new KeyringFormatError('an unlocker key is 32 bytes');
      const { enc, ciphertext } = sealBase(pk, info, new Uint8Array(0), K);
      wraps.set(concatBytes(enc, ciphertext), order[i]! * SLOT_LENGTH);
    });
    const nonce = randomBytes(NONCE_LENGTH);
    const ct = xchacha20poly1305(K, nonce, bodyAad(o.contractId, o.ownerId, o.kind, KEYRING_FORMAT_VERSION, o.bucket, wraps)).encrypt(o.plaintext);
    const body = concatBytes(nonce, ct);
    const chunks = Array.from({ length: BUCKET_CHUNKS[o.bucket]! }, (_, i) => body.slice(i * CHUNK_LENGTH, (i + 1) * CHUNK_LENGTH));
    return { version: KEYRING_FORMAT_VERSION, bucket: o.bucket, wraps, chunks };
  } finally {
    K.fill(0);
  }
}

/** Opens a sealed keyring with one unlocker's private key. Returns the padded plaintext (the caller decodes and wipes it). */
export function openKeyring(o: { contractId: Uint8Array; ownerId: Uint8Array; kind: KeyringKind; sealed: SealedKeyring; recipientPrivateKey: Uint8Array }): Uint8Array {
  const s = o.sealed;
  if (s.version !== KEYRING_FORMAT_VERSION) throw new KeyringFormatError('unknown keyring version');
  const chunks = BUCKET_CHUNKS[s.bucket];
  if (!chunks || s.chunks.length !== chunks || s.chunks.some((c) => c.length !== CHUNK_LENGTH)) throw new KeyringFormatError('keyring ciphertext has the wrong shape for its bucket');
  if (s.wraps.length !== WRAPS_LENGTH) throw new KeyringFormatError('keyring wraps have the wrong length');
  const info = wrapInfo(o.contractId, o.ownerId, o.kind);
  let K: Uint8Array | null = null;
  for (let i = 0; i < SLOT_COUNT && !K; i++) {
    const slot = s.wraps.subarray(i * SLOT_LENGTH, (i + 1) * SLOT_LENGTH);
    try {
      const k = openBase(slot.slice(0, 32), o.recipientPrivateKey, info, new Uint8Array(0), slot.slice(32));
      if (k.length === 32) K = k;
    } catch {
      /* not this slot (or a random filler) */
    }
  }
  if (!K) throw new KeyringLockedError();
  try {
    const body = concatBytes(...s.chunks);
    try {
      return xchacha20poly1305(K, body.subarray(0, NONCE_LENGTH), bodyAad(o.contractId, o.ownerId, o.kind, s.version, s.bucket, s.wraps)).decrypt(body.subarray(NONCE_LENGTH));
    } catch {
      throw new KeyringFormatError('the keyring does not decrypt (corrupt or tampered)');
    }
  } finally {
    K.fill(0);
  }
}
