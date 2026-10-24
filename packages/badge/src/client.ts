// RSABSSA-SHA384-PSS-Randomized (RFC 9474) on top of @cloudflare/blindrsa-ts: the client (blind, finalize) and the reader
// (verify). Browser- and Worker-safe: only globalThis.crypto (WebCrypto), no Node imports.
//
// Library behaviour this wrapper compensates for (spikes/blindrsa README):
//  - finalize() reduces blindSig mod n silently: we reject blindSig >= n and wrong lengths ourselves.
//  - verify() leaves length and s < n to WebCrypto: we check both ourselves.
//  - blind()/finalize() take no key validation: importIssuerKey checks e, modulus size, tiny factors and canonical DER.
//  - inputs are `x.slice().buffer`'d: every input is copied into a plain Uint8Array first (Buffer views would leak the pool).

import { RSABSSA, type BlindRSA } from '@cloudflare/blindrsa-ts';
import { base64ToBytes, bytesToBigInt, concat, copy, equalBytes } from './bytes.ts';
import { buildBadgeMessage, deriveKeyId, MSG_PREFIX_LEN, type BadgeFields } from './format.ts';

export const VARIANT = 'RSABSSA-SHA384-PSS-Randomized';
const PUBLIC_EXPONENT_B64 = 'AQAB'; // 65537
/** RSA-2048 or RSA-3072 only (contract: spki 294..422 B, sig 256..384 B). */
export const ALLOWED_MODULUS_BITS: readonly number[] = [2048, 3072];
export const SPKI_LEN: Readonly<Record<number, number>> = { 2048: 294, 3072: 422 };

let _suite: BlindRSA | undefined;
function suite(): BlindRSA {
  _suite ??= RSABSSA.SHA384.PSS.Randomized();
  if (_suite.toString() !== VARIANT) throw new Error(`unexpected variant ${_suite.toString()}`);
  return _suite;
}

/** A parsed, validated issuer public key. */
export interface IssuerKey {
  spki: Uint8Array;
  /** SHA256(spki), always derived locally, never taken from the issuer or a document. */
  keyId: Uint8Array;
  cryptoKey: CryptoKey;
  modulusBytes: number;
  n: bigint;
}

export interface ImportOptions {
  /** Tests only (the RFC vectors use a 4096-bit key). */
  allowedModulusBits?: readonly number[];
}

const SMALL_PRIMES = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n];

/**
 * Import an issuer SPKI (rsaEncryption OID). Enforces e = 65537, an exact modulus bit length in the allowed set, an odd
 * modulus without tiny factors (cheap sanity, not a primality test), and canonical DER (re-export must be byte-identical),
 * so keyId = SHA256(spki) names exactly one encoding of one key.
 */
export async function importIssuerKey(spki: Uint8Array, opts: ImportOptions = {}): Promise<IssuerKey> {
  const allowed = opts.allowedModulusBits ?? ALLOWED_MODULUS_BITS;
  const cryptoKey = await crypto.subtle.importKey('spki', copy(spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
  if (jwk.e !== PUBLIC_EXPONENT_B64) throw new Error('issuer key: public exponent must be 65537');
  const bits = (cryptoKey.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (!allowed.includes(bits)) throw new Error(`issuer key: modulus ${bits} bits not allowed`);
  const n = bytesToBigInt(base64ToBytes(jwk.n!));
  if (n.toString(2).length !== bits) throw new Error('issuer key: modulus bit length mismatch');
  if (n % 2n === 0n || SMALL_PRIMES.some((p) => n % p === 0n)) throw new Error('issuer key: modulus has a tiny factor');
  const canonical = new Uint8Array(await crypto.subtle.exportKey('spki', cryptoKey));
  if (!equalBytes(canonical, spki)) throw new Error('issuer key: SPKI is not canonical DER');
  return { spki: copy(spki), keyId: await deriveKeyId(spki), cryptoKey, modulusBytes: bits / 8, n };
}

/** Randomized prepare: a fresh CSPRNG 32-byte msgPrefix; preparedMsg = msgPrefix || msg. */
export function prepare(msg: Uint8Array): { msgPrefix: Uint8Array; preparedMsg: Uint8Array } {
  const preparedMsg = suite().prepare(copy(msg));
  if (preparedMsg.length !== MSG_PREFIX_LEN + msg.length) throw new Error('internal: unexpected prepare output');
  return { msgPrefix: preparedMsg.slice(0, MSG_PREFIX_LEN), preparedMsg };
}

/**
 * Blind. The library draws the PSS salt and r from crypto.getRandomValues on every call, so two calls never share r.
 * `inv` is the secret that links blindedMsg to the final signature: never send it anywhere, never reuse it.
 * Heavy (16-40 ms of JS bignum): run it in a Worker.
 */
export async function blind(key: IssuerKey, preparedMsg: Uint8Array): Promise<{ blindedMsg: Uint8Array; inv: Uint8Array }> {
  const out = await suite().blind(key.cryptoKey, copy(preparedMsg));
  if (out.blindedMsg.length !== key.modulusBytes || out.inv.length !== key.modulusBytes) throw new Error('internal: unexpected blind output');
  return out;
}

/** Finalize and verify. Throws when the issuer's answer is malformed or does not verify (flag the issuer). */
export async function finalize(key: IssuerKey, preparedMsg: Uint8Array, blindSig: Uint8Array, inv: Uint8Array): Promise<Uint8Array> {
  if (blindSig.length !== key.modulusBytes) throw new Error('blind signature has wrong length');
  if (bytesToBigInt(blindSig) >= key.n) throw new Error('blind signature >= modulus');
  // The library ends with crypto.subtle.verify (RSA-PSS) and throws 'invalid signature'; we verify again with our own checks.
  const sig = await suite().finalize(key.cryptoKey, copy(preparedMsg), copy(blindSig), copy(inv));
  if (!(await verify(key, sig, preparedMsg))) throw new Error('finalized signature does not verify');
  return sig;
}

/** RSABSSA verify with explicit length and s < n checks (reader rules §8.6). Never throws. */
export async function verify(key: IssuerKey, sig: Uint8Array, preparedMsg: Uint8Array): Promise<boolean> {
  try {
    if (sig.length !== key.modulusBytes) return false;
    if (bytesToBigInt(sig) >= key.n) return false;
    return await suite().verify(key.cryptoKey, copy(sig), copy(preparedMsg));
  } catch {
    return false;
  }
}

// ---- badge level ---------------------------------------------------------------------------------------------------------

/**
 * Everything the badge message commits to besides the owner. Readers take issuerId and epoch from the PROVED issuerKey
 * document (its $ownerId and epoch) and net/contractId from their own config, never from the mnBadge document.
 */
export type KeyBinding = Omit<BadgeFields, 'keyId' | 'ownerId'>;

export interface BoundIssuerKey extends IssuerKey {
  readonly binding: Readonly<KeyBinding>;
}

export function bindIssuerKey(key: IssuerKey, binding: KeyBinding): BoundIssuerKey {
  buildBadgeMessage({ ...binding, keyId: key.keyId, ownerId: new Uint8Array(32) }); // validates the field shapes
  return { ...key, binding: Object.freeze({ ...binding, contractId: copy(binding.contractId), issuerId: copy(binding.issuerId) }) };
}

export interface PreparedBadge {
  message: Uint8Array;
  msgPrefix: Uint8Array;
  preparedMsg: Uint8Array;
}

/** Build the badge message for `ownerId` (keyId from the key itself) and prepare it with a fresh prefix. */
export function prepareBadge(key: BoundIssuerKey, ownerId: Uint8Array): PreparedBadge {
  const message = buildBadgeMessage({ ...key.binding, keyId: key.keyId, ownerId });
  return { message, ...prepare(message) };
}

export interface BadgeSignature {
  /** $ownerId of the mnBadge document */
  ownerId: Uint8Array;
  msgPrefix: Uint8Array;
  sig: Uint8Array;
}

/** Rebuilds the message from the bound key and $ownerId and verifies. Never throws. */
export async function verifyBadgeSignature(key: BoundIssuerKey, b: BadgeSignature): Promise<boolean> {
  try {
    if (b.msgPrefix.length !== MSG_PREFIX_LEN) return false;
    const message = buildBadgeMessage({ ...key.binding, keyId: key.keyId, ownerId: b.ownerId });
    return await verify(key, b.sig, concat(b.msgPrefix, message));
  } catch {
    return false;
  }
}
