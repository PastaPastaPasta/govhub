// Checks of the claims behind "issuer signing uses Node/OpenSSL raw RSA" (PLAN §8.1).
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { constants, privateDecrypt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bigIntToBytes, bytesToBigInt, copy, toHex } from '../src/bytes.js';
import { IssuerError } from '../src/issuer.js';
import { setup } from './flow.js';
import { rnd } from './helpers.js';

function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}

describe.each([2048, 3072] as const)('Node issuer, %i-bit key', (bits) => {
  const k = bits / 8;

  it('PKCS#8 key from generateKeyPairSync carries CRT parameters (p, q, dP, dQ, qInv)', async () => {
    const { kp } = await setup(bits);
    const jwk = kp.privateKey.export({ format: 'jwk' });
    for (const f of ['p', 'q', 'dp', 'dq', 'qi'] as const) expect(jwk[f], f).toBeTruthy();
  });

  it('issuer output == blinded^d mod n (bigint) == library blindSign (sjcl, non-CRT) on random inputs', async () => {
    const { kp, key, issuer } = await setup(bits);
    const d = bytesToBigInt(Buffer.from(kp.privateKey.export({ format: 'jwk' }).d!, 'base64url'));
    const lib = RSABSSA.SHA384.PSS.Randomized();
    const sk = await crypto.subtle.importKey(
      'pkcs8',
      copy(new Uint8Array(kp.privateKey.export({ type: 'pkcs8', format: 'der' }))),
      { name: 'RSA-PSS', hash: 'SHA-384' },
      true,
      ['sign'],
    );
    for (let i = 0; i < 4; i++) {
      const x = rnd(k);
      x[0] = 0x3f; // < n
      const mine = issuer.blindSign(x);
      expect(toHex(mine)).toBe(toHex(bigIntToBytes(modpow(bytesToBigInt(x), d, key.n), k)));
      expect(toHex(mine)).toBe(toHex(await lib.blindSign(sk, x)));
    }
  });

  it('raw OpenSSL RSA_NO_PADDING left-pads short input silently: the issuer must (and does) check length itself', async () => {
    const { kp, issuer } = await setup(bits);
    const short = rnd(k - 1);
    expect(() => privateDecrypt({ key: kp.privateKey, padding: constants.RSA_NO_PADDING }, short)).not.toThrow();
    expect(() => issuer.blindSign(short)).toThrow(IssuerError);
    // >= n is rejected by OpenSSL itself too; the issuer rejects it before calling OpenSSL
    expect(() => privateDecrypt({ key: kp.privateKey, padding: constants.RSA_NO_PADDING }, new Uint8Array(k).fill(0xff))).toThrow();
  });
});
