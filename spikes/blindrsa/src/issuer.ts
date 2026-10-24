// Node 22 issuer: raw RSA blind signing through OpenSSL.
//
// crypto.privateDecrypt({key, padding: RSA_NO_PADDING}, x) computes x^d mod n inside OpenSSL
// (rsa_ossl_private_decrypt / the OpenSSL 3 default provider). For a key that carries p,q,dP,dQ,qInv
// (PKCS#8 from generateKeyPairSync always does) OpenSSL uses CRT, constant-time modexp and RSA base
// blinding (BN_BLINDING), and its CRT path re-checks the result with the public exponent and falls
// back to the non-CRT computation on mismatch. Those are properties of the OpenSSL source, not
// something this code can observe; bench/ and test/issuer.test.ts check the observable part
// (output equals the library's non-CRT result, and is ~4-8x faster than non-CRT bigint modexp).
// We still verify s^e == blindedMsg ourselves before returning: that check is mandatory.

import { constants, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { bytesToBigInt } from './bytes.js';

export class IssuerError extends Error {
  constructor(
    public code: 'bad-length' | 'out-of-range' | 'bad-key' | 'signing-failure',
    msg: string,
  ) {
    super(msg);
  }
}

export interface IssuerKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  spki: Uint8Array;
}

/** RSA key with e = 65537. SPKI uses the rsaEncryption OID (what WebCrypto exports). */
export function generateIssuerKey(modulusLength: 2048 | 3072): IssuerKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength, publicExponent: 65537 });
  return { privateKey, publicKey, spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })) };
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export type RawSigner = (blindedMsg: Uint8Array) => Uint8Array;

export interface IssuerOptions {
  allowedModulusBits?: readonly number[];
  /** Refuse to start unless the loaded private key matches the SPKI published on Platform for this epoch. */
  expectedSpki?: Uint8Array;
  /** TEST ONLY: replace the raw RSA private operation (used to simulate a faulty CRT signature). */
  rawSign?: RawSigner;
}

export class BlindIssuer {
  readonly modulusBytes: number;
  readonly n: bigint;
  private readonly publicKey: KeyObject;
  private readonly rawSign: RawSigner;

  constructor(
    private readonly privateKey: KeyObject,
    opts: IssuerOptions = {},
  ) {
    this.publicKey = createPublicKey(privateKey);
    const jwk = this.publicKey.export({ format: 'jwk' });
    const e = Buffer.from(jwk.e!, 'base64url');
    if (bytesToBigInt(e) !== 65537n) throw new IssuerError('bad-key', 'public exponent must be 65537');
    const nBytes = Buffer.from(jwk.n!, 'base64url');
    const n = bytesToBigInt(nBytes);
    const bits = n.toString(2).length;
    if (!(opts.allowedModulusBits ?? [2048, 3072]).includes(bits)) {
      throw new IssuerError('bad-key', `modulus ${bits} bits not allowed`);
    }
    if (opts.expectedSpki) {
      const spki = this.publicKey.export({ type: 'spki', format: 'der' });
      if (!timingSafeEqualBytes(spki, opts.expectedSpki)) throw new IssuerError('bad-key', 'private key does not match expectedSpki');
    }
    this.modulusBytes = bits / 8;
    this.n = n;
    this.rawSign =
      opts.rawSign ??
      ((m) =>
        new Uint8Array(privateDecrypt({ key: this.privateKey, padding: constants.RSA_NO_PADDING }, m)));
  }

  /** blind_sig = blindedMsg^d mod n, checked: length, range, and s^e == blindedMsg before returning. */
  blindSign(blindedMsg: Uint8Array): Uint8Array {
    if (!(blindedMsg instanceof Uint8Array) || blindedMsg.length !== this.modulusBytes) {
      throw new IssuerError('bad-length', `blinded message must be ${this.modulusBytes} bytes`);
    }
    const m = bytesToBigInt(blindedMsg);
    if (m >= this.n) throw new IssuerError('out-of-range', 'blinded message >= modulus');
    if (m < 2n) throw new IssuerError('out-of-range', 'blinded message must be > 1');

    const s = this.rawSign(blindedMsg);

    // Mandatory fault check (a single faulty CRT signature leaks the factorization).
    if (s.length !== this.modulusBytes || bytesToBigInt(s) >= this.n) {
      throw new IssuerError('signing-failure', 'bad signature representative');
    }
    let back: Buffer;
    try {
      back = publicEncrypt({ key: this.publicKey, padding: constants.RSA_NO_PADDING }, s);
    } catch {
      throw new IssuerError('signing-failure', 'verification failed');
    }
    if (back.length !== blindedMsg.length || !timingSafeEqual(back, blindedMsg)) {
      throw new IssuerError('signing-failure', 'signature does not verify (possible fault)');
    }
    return s;
  }
}
