import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bigIntToBytes, bytesToBigInt, fromHex } from '../src/bytes.js';
import { generateIssuerKey, type IssuerKeyPair } from '../src/issuer.js';

export interface RfcVector {
  name: string;
  fields: Record<string, string>;
}

export function loadVector(name = 'RSABSSA-SHA384-PSS-Randomized'): Record<string, string> {
  const path = fileURLToPath(new URL('./vectors/rfc9474-appendix-a.json', import.meta.url));
  const all = JSON.parse(readFileSync(path, 'utf8')) as RfcVector[];
  const v = all.find((x) => x.name === name);
  if (!v) throw new Error(`vector ${name} not found`);
  return v.fields;
}

export function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1] = [m, ((a % m) + m) % m];
  let [t0, t1] = [0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  if (r0 !== 1n) throw new Error('not invertible');
  return ((t0 % m) + m) % m;
}

const b64u = (v: bigint | Uint8Array, len?: number) =>
  Buffer.from(typeof v === 'bigint' ? bigIntToBytes(v, len!) : v).toString('base64url');

/** Private key from RFC test vector parameters (p, q, n, e, d as hex). */
export function vectorPrivateKey(v: Record<string, string>): KeyObject {
  const [p, q, n, e, d] = ['p', 'q', 'n', 'e', 'd'].map((k) => BigInt('0x' + v[k]!)) as [bigint, bigint, bigint, bigint, bigint];
  const nLen = v.n!.length / 2;
  const half = nLen / 2;
  return createPrivateKey({
    key: {
      kty: 'RSA',
      n: b64u(n, nLen),
      e: b64u(e, 3),
      d: b64u(d, nLen),
      p: b64u(p, half),
      q: b64u(q, half),
      dp: b64u(d % (p - 1n), half),
      dq: b64u(d % (q - 1n), half),
      qi: b64u(modInv(q, p), half),
    },
    format: 'jwk',
  });
}

export function spkiOf(priv: KeyObject): Uint8Array {
  return new Uint8Array(createPublicKey(priv).export({ type: 'spki', format: 'der' }));
}

export function pkcs8Of(priv: KeyObject): Uint8Array {
  return new Uint8Array(priv.export({ type: 'pkcs8', format: 'der' }));
}

const keyCache = new Map<number, IssuerKeyPair>();
export function cachedIssuerKey(bits: 2048 | 3072): IssuerKeyPair {
  let k = keyCache.get(bits);
  if (!k) keyCache.set(bits, (k = generateIssuerKey(bits)));
  return k;
}

export const rnd = (n: number) => new Uint8Array(randomBytes(n));
export { bytesToBigInt, fromHex };
