// Test helpers. The issuer's real signer (OpenSSL raw RSA with verify-before-return) is services/issuer/src/signer.ts;
// here a bare raw RSA private operation stands in for it.
import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bigIntToBytes } from '../src/bytes.ts';
import { bindIssuerKey, blind, finalize, importIssuerKey, prepareBadge, type BoundIssuerKey, type IssuerKey } from '../src/client.ts';
import type { BadgeFields } from '../src/format.ts';

export const rnd = (n: number) => new Uint8Array(randomBytes(n));

export function loadVector(name = 'RSABSSA-SHA384-PSS-Randomized'): Record<string, string> {
  const path = fileURLToPath(new URL('./vectors/rfc9474-appendix-a.json', import.meta.url));
  const all = JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string; fields: Record<string, string> }>;
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

const b64u = (v: bigint, len: number) => Buffer.from(bigIntToBytes(v, len)).toString('base64url');

/** Private key from RFC test vector parameters (p, q, n, e, d as hex). */
export function vectorPrivateKey(v: Record<string, string>): KeyObject {
  const [p, q, n, e, d] = ['p', 'q', 'n', 'e', 'd'].map((k) => BigInt('0x' + v[k]!)) as [bigint, bigint, bigint, bigint, bigint];
  const nLen = v.n!.length / 2;
  const half = nLen / 2;
  return createPrivateKey({
    key: { kty: 'RSA', n: b64u(n, nLen), e: b64u(e, 3), d: b64u(d, nLen), p: b64u(p, half), q: b64u(q, half), dp: b64u(d % (p - 1n), half), dq: b64u(d % (q - 1n), half), qi: b64u(modInv(q, p), half) },
    format: 'jwk',
  });
}

export const spkiOf = (priv: KeyObject) => new Uint8Array(createPublicKey(priv).export({ type: 'spki', format: 'der' }));
export const rawSign = (priv: KeyObject, m: Uint8Array) => new Uint8Array(privateDecrypt({ key: priv, padding: constants.RSA_NO_PADDING }, m));

const cache = new Map<number, { priv: KeyObject; spki: Uint8Array; key: IssuerKey }>();
export async function testKey(bits: 2048 | 3072) {
  let k = cache.get(bits);
  if (!k) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
    const spki = spkiOf(privateKey);
    k = { priv: privateKey, spki, key: await importIssuerKey(spki) };
    cache.set(bits, k);
  }
  return k;
}

export type BadgeContext = Omit<BadgeFields, 'keyId'>;
const NETS = ['mainnet', 'testnet', 'devnet', 'regtest'] as const;

export function randomCtx(epoch?: number): BadgeContext {
  return { net: NETS[rnd(1)[0]! % 4]!, contractId: rnd(32), issuerId: rnd(32), epoch: epoch ?? 1 + (new DataView(rnd(4).buffer).getUint32(0) >>> 1), ownerId: rnd(32) };
}

export const bind = (key: IssuerKey, c: Omit<BadgeContext, 'ownerId'>): BoundIssuerKey =>
  bindIssuerKey(key, { net: c.net, contractId: c.contractId, issuerId: c.issuerId, epoch: c.epoch });

export interface IssuedBadge {
  ctx: BadgeContext;
  msgPrefix: Uint8Array;
  sig: Uint8Array;
  preparedMsg: Uint8Array;
}

/** Client -> (raw) issuer -> client round trip. */
export async function issueBadge(k: { priv: KeyObject; key: IssuerKey }, ctx: BadgeContext): Promise<IssuedBadge> {
  const { msgPrefix, preparedMsg } = prepareBadge(bind(k.key, ctx), ctx.ownerId);
  const { blindedMsg, inv } = await blind(k.key, preparedMsg);
  const sig = await finalize(k.key, preparedMsg, rawSign(k.priv, blindedMsg), inv);
  return { ctx, msgPrefix, sig, preparedMsg };
}
