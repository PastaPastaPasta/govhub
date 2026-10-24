// OpenSSL raw-RSA blind signer: RFC 9474 vector, fault check, input validation, key checks.
import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bigIntToBytes, fromHex, toHex } from '@govhub/badge';
import { BlindSigner, generateIssuerKey, SignerError } from '../src/signer.ts';
import { loadVector, rnd, vectorPrivateKey } from './helpers.ts';

describe('BlindSigner', () => {
  it('RFC 9474 A.1: blind_sig of blinded_msg', () => {
    const v = loadVector();
    const s = new BlindSigner(vectorPrivateKey(v), { allowedModulusBits: [4096] });
    expect(toHex(s.sign(fromHex(v.blinded_msg!)))).toBe(v.blind_sig);
  });

  it('refuses the 4096-bit vector key by default (2048/3072 only)', () => {
    expect(() => new BlindSigner(vectorPrivateKey(loadVector()))).toThrow(/4096 bits not allowed/);
  });

  it.each([2048, 3072] as const)('%i: rejects wrong length, >= n, 0, 1; signs n-1', (bits) => {
    const kp = generateIssuerKey(bits);
    const s = new BlindSigner(kp.privateKey);
    const k = bits / 8;
    const code = (x: Uint8Array) => {
      try {
        s.sign(x);
        return 'signed';
      } catch (e) {
        return (e as SignerError).code;
      }
    };
    expect(code(new Uint8Array(0))).toBe('bad-length');
    expect(code(rnd(k - 1))).toBe('bad-length'); // OpenSSL itself would left-pad this
    expect(code(rnd(k + 1))).toBe('bad-length');
    expect(code(bigIntToBytes(s.n, k))).toBe('out-of-range');
    expect(code(new Uint8Array(k).fill(0xff))).toBe('out-of-range');
    expect(code(new Uint8Array(k))).toBe('out-of-range');
    expect(code(bigIntToBytes(1n, k))).toBe('out-of-range');
    expect(code(bigIntToBytes(s.n - 1n, k))).toBe('signed');
    expect(kp.spki.length).toBe(bits === 2048 ? 294 : 422);
  });

  it('never returns a faulty signature (simulated CRT fault, short and out-of-range outputs)', () => {
    const kp = generateIssuerKey(2048);
    const raw = (m: Uint8Array) => new Uint8Array(privateDecrypt({ key: kp.privateKey, padding: constants.RSA_NO_PADDING }, m));
    const m = bigIntToBytes(123456789123456789n, 256);
    const flip = new BlindSigner(kp.privateKey, { rawSign: (x) => { const s = raw(x); s[100]! ^= 1; return s; } });
    expect(() => flip.sign(m)).toThrow(/does not verify/);
    expect(() => new BlindSigner(kp.privateKey, { rawSign: () => new Uint8Array(255) }).sign(m)).toThrow(SignerError);
    expect(() => new BlindSigner(kp.privateKey, { rawSign: () => new Uint8Array(256).fill(0xff) }).sign(m)).toThrow(SignerError);
    expect(() => new BlindSigner(kp.privateKey, { rawSign: () => { throw new Error('x'); } }).sign(m)).toThrow(/raw RSA operation failed/);
  });

  it('key checks: exponent, size, and the published SPKI', () => {
    expect(() => new BlindSigner(generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 }).privateKey)).toThrow(/65537/);
    expect(() => new BlindSigner(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey)).toThrow(/not allowed/);
    const kp = generateIssuerKey(2048);
    expect(() => new BlindSigner(kp.privateKey, { expectedSpki: kp.spki })).not.toThrow();
    expect(() => new BlindSigner(kp.privateKey, { expectedSpki: generateIssuerKey(2048).spki })).toThrow(/published SPKI/);
    expect(() => new BlindSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).toThrow(/RSA/);
  });

  it('signing is deterministic (an idempotent retry gets the same signature back)', () => {
    const s = new BlindSigner(generateIssuerKey(2048).privateKey);
    const m = bigIntToBytes(987654321n, 256);
    expect(toHex(s.sign(m))).toBe(toHex(s.sign(m)));
  });
});
