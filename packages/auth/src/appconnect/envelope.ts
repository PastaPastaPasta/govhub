// The response envelope (DIP pasta-app-connect, "Encryption Envelope" and "Payload"):
//
//   shared = ECDH(walletEphPriv, appEphPub).x
//   key    = HKDF-SHA256(ikm = shared, salt = "dash:key-exchange:v1", info = "app-connect:v2", L = 32)
//   aad    = "dash:app-connect:v2" ‖ hash160(appEphPub) ‖ ownerId
//   payload = nonce (12) ‖ AES-256-GCM(key, nonce, aad, slot₀ ‖ … ‖ slotₙ₋₁) ‖ tag (16)
import { gcm } from '@noble/ciphers/aes.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hash160, randomBytes, wipe } from '../bytes.ts';

const ascii = (s: string) => new TextEncoder().encode(s);
export const HKDF_SALT = ascii('dash:key-exchange:v1');
export const HKDF_INFO = ascii('app-connect:v2');
export const AAD_PREFIX = ascii('dash:app-connect:v2');
export const NONCE_BYTES = 12;
export const ENVELOPE_BYTES = NONCE_BYTES + 16;
export const SLOT_BYTES = 32;
/** The `loginKeyResponse` schema caps the payload at 572 bytes. */
export const MAX_SLOTS = 17;

export class PayloadError extends Error {
  constructor(
    readonly code: 'framing' | 'decrypt',
    message: string,
  ) {
    super(message);
    this.name = 'AppConnectPayloadError';
  }
}

export function responseAad(appEphemeralPubKey: Uint8Array, ownerId: Uint8Array): Uint8Array {
  if (appEphemeralPubKey.length !== 33 || ownerId.length !== 32) throw new Error('aad needs a 33-byte key and a 32-byte owner id');
  return concatBytes(AAD_PREFIX, hash160(appEphemeralPubKey), ownerId);
}

/** The HKDF key both sides derive; the caller wipes it. */
export function responseKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const point = secp256k1.getSharedSecret(privateKey, publicKey, true);
  const x = point.slice(1, 33);
  try {
    return hkdf(sha256, x, HKDF_SALT, HKDF_INFO, 32);
  } finally {
    wipe(point, x);
  }
}

/** Slots in a payload of this length, or null when it is not 28 + 32n bytes with 1 <= n <= 17. */
export function slotCount(payloadLength: number): number | null {
  const body = payloadLength - ENVELOPE_BYTES;
  if (body <= 0 || body % SLOT_BYTES) return null;
  const n = body / SLOT_BYTES;
  return n <= MAX_SLOTS ? n : null;
}

/**
 * App side: checks the framing and the tag and returns the slots in payload order, at most `maxSlots` of them. The caller owns the
 * returned keys and wipes them.
 */
export function openPayload(o: { appEphemeralPrivateKey: Uint8Array; ownerId: Uint8Array; walletEphemeralPubKey: Uint8Array; encryptedPayload: Uint8Array; maxSlots?: number }): Uint8Array[] {
  const n = slotCount(o.encryptedPayload.length);
  if (n === null || n > (o.maxSlots ?? MAX_SLOTS)) throw new PayloadError('framing', `a payload of ${o.encryptedPayload.length} bytes is not 28 + 32n for this request`);
  let key: Uint8Array;
  try {
    key = responseKey(o.appEphemeralPrivateKey, o.walletEphemeralPubKey);
  } catch {
    throw new PayloadError('decrypt', 'the wallet ephemeral key is not a valid point');
  }
  const aad = responseAad(secp256k1.getPublicKey(o.appEphemeralPrivateKey, true), o.ownerId);
  let plain: Uint8Array;
  try {
    plain = gcm(key, o.encryptedPayload.subarray(0, NONCE_BYTES), aad).decrypt(o.encryptedPayload.subarray(NONCE_BYTES));
  } catch {
    throw new PayloadError('decrypt', 'the payload does not decrypt for this request and owner');
  } finally {
    wipe(key);
  }
  const slots = Array.from({ length: n }, (_, i) => plain.slice(i * SLOT_BYTES, (i + 1) * SLOT_BYTES));
  wipe(plain);
  return slots;
}

/** Wallet side, for tests and the wallet simulator: encrypts `slots` to the request. */
export function sealPayload(o: { appEphemeralPubKey: Uint8Array; ownerId: Uint8Array; slots: Uint8Array[]; walletEphemeralPrivateKey?: Uint8Array; nonce?: Uint8Array }): {
  walletEphemeralPubKey: Uint8Array;
  encryptedPayload: Uint8Array;
} {
  if (o.slots.length < 1 || o.slots.length > MAX_SLOTS || o.slots.some((s) => s.length !== SLOT_BYTES)) throw new Error('expected 1 to 17 slots of 32 bytes');
  const nonce = o.nonce ?? randomBytes(NONCE_BYTES);
  const walletPriv = o.walletEphemeralPrivateKey ?? secp256k1.utils.randomSecretKey();
  const key = responseKey(walletPriv, o.appEphemeralPubKey);
  const plain = concatBytes(...o.slots);
  try {
    const sealed = gcm(key, nonce, responseAad(o.appEphemeralPubKey, o.ownerId)).encrypt(plain);
    return { walletEphemeralPubKey: secp256k1.getPublicKey(walletPriv, true), encryptedPayload: concatBytes(nonce, sealed) };
  } finally {
    wipe(key, plain);
    if (!o.walletEphemeralPrivateKey) wipe(walletPriv);
  }
}
