// Blind signing with OpenSSL raw RSA (PLAN §8.1, spikes/blindrsa).
//
// crypto.privateDecrypt({key, padding: RSA_NO_PADDING}, x) computes x^d mod n inside OpenSSL. For a key with CRT parameters
// (every PKCS#8 key from generateKeyPairSync) OpenSSL uses CRT, constant-time modexp and RSA base blinding. A single faulty
// CRT signature leaks the factorization, so every signature is checked (s^e == m) before it leaves this class.
// OpenSSL silently left-pads a short input, so the length check is explicit.

import { constants, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, timingSafeEqual, type KeyObject } from 'node:crypto';
import { bytesToBigInt } from '@govhub/badge';

export type SignerErrorCode = 'bad-length' | 'out-of-range' | 'bad-key' | 'signing-failure';

export class SignerError extends Error {
  readonly code: SignerErrorCode;
  constructor(code: SignerErrorCode, msg: string) {
    super(msg);
    this.code = code;
    this.name = 'SignerError';
  }
}

export interface IssuerKeyPair {
  privateKey: KeyObject;
  /** rsaEncryption SPKI DER (what WebCrypto imports; 294 B for 2048, 422 B for 3072) */
  spki: Uint8Array;
}

/** A JWK integer member (base64url, big-endian) as a bigint. */
const jwkInt = (v: string): bigint => bytesToBigInt(Buffer.from(v, 'base64url'));

/** RSA key, e = 65537. OpenSSL may produce a modulus one bit short for odd sizes; 2048/3072 are exact. */
export function generateIssuerKey(modulusLength: 2048 | 3072): IssuerKeyPair {
  for (;;) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength, publicExponent: 65537 });
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const n = jwkInt(publicKey.export({ format: 'jwk' }).n!);
    if (n.toString(2).length === modulusLength) return { privateKey, spki };
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

export type RawSigner = (blindedMsg: Uint8Array) => Uint8Array;

export interface SignerOptions {
  /** Refuse to start unless the private key matches this SPKI (the one published on Platform for the epoch). */
  expectedSpki?: Uint8Array;
  /** TEST ONLY: replaces the raw RSA private operation (simulates a faulty CRT signature). */
  rawSign?: RawSigner;
  /** TEST ONLY: the RFC vectors use 4096 bits. */
  allowedModulusBits?: readonly number[];
}

export class BlindSigner {
  readonly modulusBytes: number;
  readonly n: bigint;
  readonly spki: Uint8Array;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #rawSign: RawSigner;

  constructor(privateKey: KeyObject, opts: SignerOptions = {}) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'rsa') throw new SignerError('bad-key', 'not an RSA private key');
    this.#privateKey = privateKey;
    this.#publicKey = createPublicKey(privateKey);
    const jwk = this.#publicKey.export({ format: 'jwk' });
    if (jwkInt(jwk.e!) !== 65537n) throw new SignerError('bad-key', 'public exponent must be 65537');
    const n = jwkInt(jwk.n!);
    const bits = n.toString(2).length;
    if (!(opts.allowedModulusBits ?? [2048, 3072]).includes(bits)) throw new SignerError('bad-key', `modulus ${bits} bits not allowed`);
    this.spki = new Uint8Array(this.#publicKey.export({ type: 'spki', format: 'der' }));
    if (opts.expectedSpki && !sameBytes(this.spki, opts.expectedSpki)) throw new SignerError('bad-key', 'private key does not match the published SPKI');
    this.modulusBytes = bits / 8;
    this.n = n;
    this.#rawSign = opts.rawSign ?? ((m) => new Uint8Array(privateDecrypt({ key: this.#privateKey, padding: constants.RSA_NO_PADDING }, m)));
  }

  /** blind_sig = blindedMsg^d mod n; checks length, 1 < m < n, and s^e == m before returning. */
  sign(blindedMsg: Uint8Array): Uint8Array {
    if (!(blindedMsg instanceof Uint8Array) || blindedMsg.length !== this.modulusBytes) throw new SignerError('bad-length', `blinded message must be ${this.modulusBytes} bytes`);
    const m = bytesToBigInt(blindedMsg);
    if (m >= this.n) throw new SignerError('out-of-range', 'blinded message >= modulus');
    if (m < 2n) throw new SignerError('out-of-range', 'blinded message must be > 1');
    let s: Uint8Array;
    try {
      s = this.#rawSign(blindedMsg);
    } catch {
      throw new SignerError('signing-failure', 'raw RSA operation failed');
    }
    if (s.length !== this.modulusBytes || bytesToBigInt(s) >= this.n) throw new SignerError('signing-failure', 'bad signature representative');
    let back: Buffer;
    try {
      back = publicEncrypt({ key: this.#publicKey, padding: constants.RSA_NO_PADDING }, s);
    } catch {
      throw new SignerError('signing-failure', 'verification failed');
    }
    if (!sameBytes(back, blindedMsg)) throw new SignerError('signing-failure', 'signature does not verify (possible fault)');
    return s;
  }
}
