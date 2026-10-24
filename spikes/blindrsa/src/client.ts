// Client-side wrappers around @cloudflare/blindrsa-ts for RSABSSA-SHA384-PSS-Randomized (RFC 9474).
// Browser-safe: only uses globalThis.crypto (WebCrypto), no Node imports.

import { RSABSSA, type BlindRSA } from '@cloudflare/blindrsa-ts';
import { base64ToBytes, bytesToBigInt, copy, equalBytes } from './bytes.js';
import { buildBadgeMessage, deriveKeyId, MSG_PREFIX_LEN, type BadgeFields } from './format.js';

export const VARIANT = 'RSABSSA-SHA384-PSS-Randomized';
export const PUBLIC_EXPONENT_B64 = 'AQAB'; // 65537

let _suite: BlindRSA | undefined;
export function suite(): BlindRSA {
  _suite ??= RSABSSA.SHA384.PSS.Randomized();
  if (_suite.toString() !== VARIANT) throw new Error(`unexpected variant ${_suite.toString()}`);
  return _suite;
}

/** A parsed, validated issuer public key ready for blind/finalize/verify. */
export interface IssuerKey {
  spki: Uint8Array;
  /** SHA256(spki) — always derived locally, never taken from the issuer. */
  keyId: Uint8Array;
  cryptoKey: CryptoKey;
  modulusBytes: number;
  n: bigint;
}

export interface ImportOptions {
  allowedModulusBits?: readonly number[];
}

const SMALL_PRIMES = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n];

/**
 * Import an issuer SPKI. Enforces: e = 65537, exact modulus bit length in the allowed set,
 * odd modulus without tiny factors (cheap sanity only), and that the SPKI bytes are the canonical
 * re-encoding (so keyId = SHA256(spki) is unambiguous per key).
 */
export async function importIssuerKey(spki: Uint8Array, opts: ImportOptions = {}): Promise<IssuerKey> {
  const allowed = opts.allowedModulusBits ?? [2048, 3072];
  const cryptoKey = await crypto.subtle.importKey('spki', copy(spki), { name: 'RSA-PSS', hash: 'SHA-384' }, true, [
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
  if (jwk.e !== PUBLIC_EXPONENT_B64) throw new Error('issuer key: public exponent must be 65537');
  const bits = (cryptoKey.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (!allowed.includes(bits)) throw new Error(`issuer key: modulus ${bits} bits not allowed`);
  const nBytes = base64ToBytes(jwk.n!);
  const n = bytesToBigInt(nBytes);
  if (n.toString(2).length !== bits) throw new Error('issuer key: modulus bit length mismatch');
  if (n % 2n === 0n || SMALL_PRIMES.some((p) => n % p === 0n)) throw new Error('issuer key: modulus has a tiny factor');
  const canonical = new Uint8Array(await crypto.subtle.exportKey('spki', cryptoKey));
  if (!equalBytes(canonical, spki)) throw new Error('issuer key: SPKI is not canonical DER');
  return { spki: copy(spki), keyId: await deriveKeyId(spki), cryptoKey, modulusBytes: bits / 8, n };
}

/** randomized prepare: returns msgPrefix(32) and preparedMsg = msgPrefix || msg. */
export function prepare(msg: Uint8Array): { msgPrefix: Uint8Array; preparedMsg: Uint8Array } {
  const preparedMsg = suite().prepare(copy(msg));
  // The library exposes no separate accessor: the 32-byte prefix is the first 32 bytes.
  return { msgPrefix: preparedMsg.slice(0, MSG_PREFIX_LEN), preparedMsg };
}

// NB: the library does `x.slice().buffer` on its inputs; on a Node Buffer that is the whole pool, not
// the view. Every wrapper therefore copies its inputs into plain Uint8Arrays first.

export async function blind(
  key: IssuerKey,
  preparedMsg: Uint8Array,
): Promise<{ blindedMsg: Uint8Array; inv: Uint8Array }> {
  return suite().blind(key.cryptoKey, copy(preparedMsg));
}

/** Finalize. The library verifies via WebCrypto RSA-PSS; we also pin lengths and s < N. */
export async function finalize(
  key: IssuerKey,
  preparedMsg: Uint8Array,
  blindSig: Uint8Array,
  inv: Uint8Array,
): Promise<Uint8Array> {
  if (blindSig.length !== key.modulusBytes) throw new Error('blind signature has wrong length');
  // Explicit range check: the library's finalize reduces z mod n silently (z >= n is accepted).
  if (bytesToBigInt(blindSig) >= key.n) throw new Error('blind signature >= modulus');
  // Library finalize ends with crypto.subtle.verify (RSA-PSS) and throws 'invalid signature';
  // sig = z * inv mod n is < n by construction.
  return suite().finalize(key.cryptoKey, copy(preparedMsg), copy(blindSig), copy(inv));
}

/** Verify with explicit length and s < N pre-checks (reader rules §8.6). */
export async function verify(key: IssuerKey, sig: Uint8Array, preparedMsg: Uint8Array): Promise<boolean> {
  if (sig.length !== key.modulusBytes) return false;
  if (bytesToBigInt(sig) >= key.n) return false;
  return suite().verify(key.cryptoKey, copy(sig), copy(preparedMsg));
}

// ---------------------------------------------------------------------------
// Badge-level helpers

/**
 * Everything the badge message commits to besides the owner. The blind issuer never sees the message,
 * so these values are NOT authenticated by the signature: they must come from the proved `issuerKey`
 * document (issuerId = its $ownerId, epoch = its epoch) and from the app config (net, contractId),
 * never from the `mnBadge` document being checked. Readers verify against a BoundIssuerKey only.
 */
export interface KeyBinding {
  net: number;
  contractId: Uint8Array;
  issuerId: Uint8Array;
  epoch: number;
}
export interface BoundIssuerKey extends IssuerKey {
  binding: Readonly<KeyBinding>;
}

export function bindIssuerKey(key: IssuerKey, binding: KeyBinding): BoundIssuerKey {
  buildBadgeMessage({ ...binding, keyId: key.keyId, ownerId: new Uint8Array(32) }); // validates field shapes
  return { ...key, binding: { ...binding } };
}

/** Build the badge message (keyId from the key), then prepare (adds the random 32-byte prefix). */
export function prepareBadge(key: BoundIssuerKey, ownerId: Uint8Array) {
  const message = buildBadgeMessage({ ...key.binding, keyId: key.keyId, ownerId });
  return { message, ...prepare(message) };
}

export interface BadgeToVerify {
  /** $ownerId of the mnBadge document. */
  ownerId: Uint8Array;
  msgPrefix: Uint8Array;
  sig: Uint8Array;
  /** Fields of the mnBadge document, if present; each must equal what the bound key implies. */
  keyId?: Uint8Array;
  issuerId?: Uint8Array;
  epoch?: number;
}

/**
 * Reader-side check: rebuilds the message from the bound key + $ownerId and verifies. Returns false
 * (never throws) on any malformed or mismatching input.
 */
export async function verifyBadge(key: BoundIssuerKey, b: BadgeToVerify): Promise<boolean> {
  try {
    if (b.msgPrefix.length !== MSG_PREFIX_LEN) return false;
    if (b.keyId && !equalBytes(b.keyId, key.keyId)) return false;
    if (b.issuerId && !equalBytes(b.issuerId, key.binding.issuerId)) return false;
    if (b.epoch !== undefined && b.epoch !== key.binding.epoch) return false;
    const message = buildBadgeMessage({ ...key.binding, keyId: key.keyId, ownerId: b.ownerId });
    const preparedMsg = new Uint8Array(MSG_PREFIX_LEN + message.length);
    preparedMsg.set(b.msgPrefix, 0);
    preparedMsg.set(message, MSG_PREFIX_LEN);
    return await verify(key, b.sig, preparedMsg);
  } catch {
    return false;
  }
}
