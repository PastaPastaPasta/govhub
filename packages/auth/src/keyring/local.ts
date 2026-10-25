// Device-local records encrypted under the keyring (the signed votes a browser watches, apps/web voting/pending.ts). Before a vote is
// released it links masternodes together, so it is never kept in plain storage: the key is derived from the keyring's random id,
// which only someone who can open the keyring knows, and is held in memory only while the keyring's session lasts.
//
//   key  = HKDF-SHA256(ikm = keyringId, salt = UTF8("govhub/keyring/v1/local"), info = UTF8(scope), 32)
//   blob = base64( nonce(24) || XChaCha20-Poly1305(key, nonce, AAD = UTF8(scope), plaintext) )
//
// `scope` names what the record is for (e.g. "votes|testnet|testnet|<identity>"), so a blob copied to another slot does not open.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, fromBase64, randomBytes, toBase64 } from '../bytes.ts';
import { KEYRING_ID_LENGTH, KeyringFormatError, NONCE_LENGTH } from './format.ts';

const te = new TextEncoder();

/** The key for one scope's local records. The caller wipes it (`fill(0)`) when the session ends. */
export function localRecordKey(keyringId: Uint8Array, scope: string): Uint8Array {
  if (keyringId.length !== KEYRING_ID_LENGTH) throw new KeyringFormatError('keyring id must be 16 bytes');
  return hkdf(sha256, keyringId, te.encode('govhub/keyring/v1/local'), te.encode(scope), 32);
}

export function sealLocalRecord(key: Uint8Array, scope: string, plaintext: Uint8Array): string {
  const nonce = randomBytes(NONCE_LENGTH);
  return toBase64(concatBytes(nonce, xchacha20poly1305(key, nonce, te.encode(scope)).encrypt(plaintext)));
}

/** The plaintext, or null when the blob is not a record of this key and scope (another keyring, tampered, or garbage). */
export function openLocalRecord(key: Uint8Array, scope: string, blob: string): Uint8Array | null {
  try {
    const b = fromBase64(blob);
    if (b.length < NONCE_LENGTH + 16) return null;
    return xchacha20poly1305(key, b.subarray(0, NONCE_LENGTH), te.encode(scope)).decrypt(b.subarray(NONCE_LENGTH));
  } catch {
    return null;
  }
}
