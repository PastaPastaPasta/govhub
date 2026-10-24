// Round trips and negative cases for blind / finalize / verify and the badge-level binding.
import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { bigIntToBytes, bytesToBigInt, concat, toHex } from '../src/bytes.ts';
import { blind, finalize, importIssuerKey, prepare, prepareBadge, verify, verifyBadgeSignature, type IssuerKey } from '../src/client.ts';
import { buildBadgeMessage } from '../src/format.ts';
import { bind, issueBadge, randomCtx, rawSign, rnd, testKey, type IssuedBadge } from './helpers.ts';

describe.each([2048, 3072] as const)('%i-bit key', (bits) => {
  let k: Awaited<ReturnType<typeof testKey>>;
  let other: IssuerKey;
  let badge: IssuedBadge;
  const check = (over: Partial<IssuedBadge['ctx']> & { msgPrefix?: Uint8Array; sig?: Uint8Array } = {}, key: IssuerKey = k.key) => {
    const c = { ...badge.ctx, ...over };
    return verifyBadgeSignature(bind(key, c), { ownerId: c.ownerId, msgPrefix: over.msgPrefix ?? badge.msgPrefix, sig: over.sig ?? badge.sig });
  };

  beforeAll(async () => {
    k = await testKey(bits);
    other = await importIssuerKey(new Uint8Array(generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ type: 'spki', format: 'der' })));
    badge = await issueBadge(k, randomCtx(41));
  });

  it('sizes: spki, signature, prefix', () => {
    expect(k.spki.length).toBe(bits === 2048 ? 294 : 422);
    expect(badge.sig.length).toBe(bits / 8);
    expect(badge.msgPrefix.length).toBe(32);
    expect(badge.preparedMsg.length).toBe(180);
  });

  it('round trips (50 random badges) verify', async () => {
    for (let i = 0; i < 50; i++) {
      const b = await issueBadge(k, randomCtx());
      expect(await verifyBadgeSignature(bind(k.key, b.ctx), { ownerId: b.ctx.ownerId, msgPrefix: b.msgPrefix, sig: b.sig })).toBe(true);
    }
  });

  it('baseline verifies; every bound field matters', async () => {
    expect(await check()).toBe(true);
    expect(await check({ ownerId: rnd(32) })).toBe(false); // copied to another identity
    expect(await check({ epoch: badge.ctx.epoch + 1 })).toBe(false);
    expect(await check({ epoch: badge.ctx.epoch - 1 })).toBe(false);
    expect(await check({ net: badge.ctx.net === 'mainnet' ? 'testnet' : 'mainnet' })).toBe(false);
    expect(await check({ contractId: rnd(32) })).toBe(false);
    expect(await check({ issuerId: rnd(32) })).toBe(false);
    expect(await check({}, other)).toBe(false); // the same signature under another issuer key
    const msg = buildBadgeMessage({ ...badge.ctx, keyId: other.keyId }); // a foreign keyId in the message
    expect(await verify(k.key, badge.sig, concat(badge.msgPrefix, msg))).toBe(false);
  });

  it('the blind issuer cannot see the message: a client-chosen issuer/epoch verifies only under that (wrong) binding', async () => {
    const forged = await issueBadge(k, { ...badge.ctx, issuerId: rnd(32), epoch: 999 });
    expect(await verifyBadgeSignature(bind(k.key, forged.ctx), { ownerId: forged.ctx.ownerId, msgPrefix: forged.msgPrefix, sig: forged.sig })).toBe(true);
    expect(await verifyBadgeSignature(bind(k.key, badge.ctx), { ownerId: forged.ctx.ownerId, msgPrefix: forged.msgPrefix, sig: forged.sig })).toBe(false);
  });

  it('malformed inputs return false instead of throwing', async () => {
    expect(await check({ ownerId: rnd(31) })).toBe(false);
    expect(await check({ ownerId: new Uint8Array(0) })).toBe(false);
    for (const len of [0, 31, 33, 64]) expect(await check({ msgPrefix: rnd(len) })).toBe(false);
    expect(await check({ sig: badge.sig.slice(1) })).toBe(false);
    expect(await check({ sig: concat(badge.sig, Uint8Array.of(0)) })).toBe(false);
    expect(await check({ sig: new Uint8Array(0) })).toBe(false);
  });

  it('tampered prefix (every byte) and signature fail', async () => {
    for (let i = 0; i < 32; i++) {
      const p = badge.msgPrefix.slice();
      p[i]! ^= 1;
      expect(await check({ msgPrefix: p })).toBe(false);
    }
    for (const i of [0, 1, bits / 16, bits / 8 - 1]) {
      const s = badge.sig.slice();
      s[i]! ^= 0x80;
      expect(await check({ sig: s })).toBe(false);
    }
  });

  it('s >= n is refused (n, 2^k-1, and the non-reduced twin sig + n)', async () => {
    const len = bits / 8;
    expect(await check({ sig: bigIntToBytes(k.key.n, len) })).toBe(false);
    expect(await check({ sig: new Uint8Array(len).fill(0xff) })).toBe(false);
    for (let i = 0; i < 40; i++) {
      const b = await issueBadge(k, randomCtx());
      const twin = bytesToBigInt(b.sig) + k.key.n;
      if (twin >= 1n << BigInt(bits)) continue;
      expect(await verifyBadgeSignature(bind(k.key, b.ctx), { ownerId: b.ctx.ownerId, msgPrefix: b.msgPrefix, sig: bigIntToBytes(twin, len) })).toBe(false);
      return;
    }
    throw new Error('no twin candidate found');
  });

  it('finalize refuses malformed or wrong blind signatures', async () => {
    const c = randomCtx();
    const { preparedMsg } = prepareBadge(bind(k.key, c), c.ownerId);
    const { blindedMsg, inv } = await blind(k.key, preparedMsg);
    const good = rawSign(k.priv, blindedMsg);
    await expect(finalize(k.key, preparedMsg, good.slice(1), inv)).rejects.toThrow();
    await expect(finalize(k.key, preparedMsg, concat(good, Uint8Array.of(0)), inv)).rejects.toThrow();
    await expect(finalize(k.key, preparedMsg, new Uint8Array(bits / 8).fill(0xff), inv)).rejects.toThrow(/modulus/);
    await expect(finalize(k.key, preparedMsg, bigIntToBytes(k.key.n, bits / 8), inv)).rejects.toThrow(/modulus/);
    const twin = bytesToBigInt(good) + k.key.n;
    if (twin < 1n << BigInt(bits)) await expect(finalize(k.key, preparedMsg, bigIntToBytes(twin, bits / 8), inv)).rejects.toThrow(/modulus/);
    await expect(finalize(k.key, preparedMsg, good, inv.slice(1))).rejects.toThrow();
    const evil = good.slice();
    evil[10]! ^= 1;
    await expect(finalize(k.key, preparedMsg, evil, inv)).rejects.toThrow();
    // a valid signature for a DIFFERENT blinded message (the issuer answering someone else's request)
    const { blindedMsg: b2 } = await blind(k.key, preparedMsg);
    await expect(finalize(k.key, preparedMsg, rawSign(k.priv, b2), inv)).rejects.toThrow();
    expect((await finalize(k.key, preparedMsg, good, inv)).length).toBe(bits / 8);
  });
});

describe('blinding', () => {
  it('fresh r and salt on every blind() call', async () => {
    const { key } = await testKey(2048);
    const { preparedMsg } = prepare(rnd(10));
    const a = await blind(key, preparedMsg);
    const b = await blind(key, preparedMsg);
    expect(toHex(a.blindedMsg)).not.toBe(toHex(b.blindedMsg));
    expect(toHex(a.inv)).not.toBe(toHex(b.inv));
  });

  it('the blinded message is unlinkable to the final signature by value (no byte overlap in the first 16 bytes)', async () => {
    const k = await testKey(2048);
    const b = await issueBadge(k, randomCtx());
    const { blindedMsg } = await blind(k.key, b.preparedMsg);
    expect(toHex(blindedMsg).slice(0, 32)).not.toBe(toHex(b.sig).slice(0, 32));
  });
});

describe('issuer key import', () => {
  const spki = (o: { modulusLength: number; publicExponent?: number }) => new Uint8Array(generateKeyPairSync('rsa', o).publicKey.export({ type: 'spki', format: 'der' }));
  it('rejects e != 65537, disallowed sizes and non-canonical SPKI', async () => {
    await expect(importIssuerKey(spki({ modulusLength: 2048, publicExponent: 3 }))).rejects.toThrow(/65537/);
    await expect(importIssuerKey(spki({ modulusLength: 2047 }))).rejects.toThrow(/2047 bits not allowed/);
    await expect(importIssuerKey(spki({ modulusLength: 3071 }))).rejects.toThrow(/bits not allowed|mismatch/);
    await expect(importIssuerKey(spki({ modulusLength: 1024 }))).rejects.toThrow(/not allowed/);
    await expect(importIssuerKey(spki({ modulusLength: 4096 }))).rejects.toThrow(/not allowed/);
    const good = (await testKey(2048)).spki;
    await expect(importIssuerKey(concat(good, Uint8Array.of(0)))).rejects.toThrow(/canonical/);
    expect((await importIssuerKey(good)).keyId.length).toBe(32);
  });
  it('rejects an RSASSA-PSS-OID SPKI (WebCrypto cannot import it)', async () => {
    const pss = new Uint8Array((generateKeyPairSync as (t: string, o: object) => { publicKey: import('node:crypto').KeyObject })('rsa-pss', { modulusLength: 2048, hashAlgorithm: 'sha384', mgf1HashAlgorithm: 'sha384', saltLength: 48 }).publicKey.export({ type: 'spki', format: 'der' }));
    await expect(importIssuerKey(pss)).rejects.toThrow();
  });
});
