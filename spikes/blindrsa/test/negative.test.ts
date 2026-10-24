import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bigIntToBytes, bytesToBigInt, concat, copy, toHex } from '../src/bytes.js';
import {
  blind,
  finalize,
  importIssuerKey,
  prepare,
  prepareBadge,
  suite,
  verify,
  verifyBadge,
  type BadgeToVerify,
  type IssuerKey,
} from '../src/client.js';
import { buildBadgeMessage } from '../src/format.js';
import { BlindIssuer, IssuerError, generateIssuerKey } from '../src/issuer.js';
import { bind, issueBadge, randomCtx, setup, type BadgeContext, type IssuedBadge } from './flow.js';
import { rnd } from './helpers.js';

describe.each([2048, 3072] as const)('negative cases, %i-bit key', (bits) => {
  let key: IssuerKey;
  let issuer: BlindIssuer;
  let other: IssuerKey;
  let badge: IssuedBadge;
  /**
   * `over` may change (a) what the reader derives from the proved issuerKey doc / app config (binding:
   * net, contractId, issuerId, epoch), and (b) fields of the mnBadge document being checked.
   */
  const check = (
    over: Partial<Omit<BadgeContext, 'ownerId'>> & Partial<BadgeToVerify> = {},
    k: IssuerKey = key,
  ) => {
    const c = badge.ctx;
    const bound = bind(k, {
      net: over.net ?? c.net,
      contractId: over.contractId ?? c.contractId,
      issuerId: over.issuerId ?? c.issuerId,
      epoch: over.epoch ?? c.epoch,
    });
    return verifyBadge(bound, {
      ownerId: over.ownerId ?? c.ownerId,
      msgPrefix: over.msgPrefix ?? badge.msgPrefix,
      sig: over.sig ?? badge.sig,
    });
  };

  beforeAll(async () => {
    ({ key, issuer } = await setup(bits));
    other = await importIssuerKey(generateIssuerKey(bits).spki);
    badge = await issueBadge(key, issuer, randomCtx(41));
  });

  it('baseline verifies', async () => {
    expect(await check()).toBe(true);
  });

  it('wrong ownerId fails (badge copied to another identity)', async () => {
    expect(await check({ ownerId: rnd(32) })).toBe(false);
  });

  it('wrong epoch fails', async () => {
    expect(await check({ epoch: badge.ctx.epoch + 1 })).toBe(false);
    expect(await check({ epoch: badge.ctx.epoch - 1 })).toBe(false);
  });

  it('wrong keyId fails (claimed keyId in the document, and verifying under another key)', async () => {
    const bound = bind(key, badge.ctx);
    const doc = { ownerId: badge.ctx.ownerId, msgPrefix: badge.msgPrefix, sig: badge.sig };
    expect(await verifyBadge(bound, { ...doc, keyId: key.keyId })).toBe(true);
    expect(await verifyBadge(bound, { ...doc, keyId: rnd(32) })).toBe(false); // document keyId != SHA256(spki)
    expect(await check({}, other)).toBe(false); // same sig under a different issuer key
    // message built with a foreign keyId, verified under the real key
    const msg = buildBadgeMessage({ ...badge.ctx, keyId: other.keyId });
    expect(await verify(key, badge.sig, concat(badge.msgPrefix, msg))).toBe(false);
  });

  it('wrong net / contractId / issuerId fail', async () => {
    expect(await check({ net: badge.ctx.net === 1 ? 2 : 1 })).toBe(false);
    expect(await check({ contractId: rnd(32) })).toBe(false);
    expect(await check({ issuerId: rnd(32) })).toBe(false);
  });

  it('doc-claimed issuerId/epoch must equal the bound key; a self-chosen issuerId/epoch is not authenticated by the signature', async () => {
    const bound = bind(key, badge.ctx);
    const doc = { ownerId: badge.ctx.ownerId, msgPrefix: badge.msgPrefix, sig: badge.sig };
    expect(await verifyBadge(bound, { ...doc, issuerId: badge.ctx.issuerId, epoch: badge.ctx.epoch })).toBe(true);
    expect(await verifyBadge(bound, { ...doc, issuerId: rnd(32) })).toBe(false);
    expect(await verifyBadge(bound, { ...doc, epoch: badge.ctx.epoch + 1 })).toBe(false);
    // The blind issuer cannot see what the client put in the message: a badge minted under key K claiming
    // issuer B / epoch 999 verifies under K's *attacker-chosen* binding, but NOT under K's real binding.
    const forged = await issueBadge(key, issuer, { ...badge.ctx, issuerId: rnd(32), epoch: 999 });
    expect(await verifyBadge(bind(key, forged.ctx), { ownerId: forged.ctx.ownerId, msgPrefix: forged.msgPrefix, sig: forged.sig })).toBe(true);
    expect(await verifyBadge(bound, { ownerId: forged.ctx.ownerId, msgPrefix: forged.msgPrefix, sig: forged.sig })).toBe(false);
  });

  it('malformed document fields return false instead of throwing', async () => {
    expect(await check({ ownerId: rnd(31) })).toBe(false);
    expect(await check({ ownerId: new Uint8Array(0) })).toBe(false);
  });

  it('tampered msgPrefix fails (every byte position)', async () => {
    for (let i = 0; i < 32; i++) {
      const p = badge.msgPrefix.slice();
      p[i]! ^= 0x01;
      expect(await check({ msgPrefix: p })).toBe(false);
    }
  });

  it('tampered signature fails', async () => {
    for (const i of [0, 1, bits / 16, bits / 8 - 1]) {
      const s = badge.sig.slice();
      s[i]! ^= 0x80;
      expect(await check({ sig: s })).toBe(false);
    }
  });

  it('wrong-length msgPrefix rejected (31, 33, 0, 64 bytes)', async () => {
    for (const len of [0, 31, 33, 64]) {
      expect(await check({ msgPrefix: rnd(len) })).toBe(false);
    }
    expect(await check({ msgPrefix: badge.msgPrefix.slice(0, 31) })).toBe(false);
  });

  it('wrong-length signature rejected (short, long, empty)', async () => {
    expect(await check({ sig: badge.sig.slice(1) })).toBe(false);
    expect(await check({ sig: concat(badge.sig, Uint8Array.of(0)) })).toBe(false);
    expect(await check({ sig: concat(Uint8Array.of(0), badge.sig) })).toBe(false);
    expect(await check({ sig: new Uint8Array(0) })).toBe(false);
  });

  it('signature >= N rejected by the wrapper itself, even if the underlying verify would accept it', async () => {
    const spy = vi.spyOn(suite(), 'verify').mockResolvedValue(true);
    try {
      const k = bits / 8;
      expect(await check()).toBe(true); // mock really returns true...
      expect(await check({ sig: bigIntToBytes(key.n, k) })).toBe(false); // ...but s == N is refused,
      expect(await check({ sig: new Uint8Array(k).fill(0xff) })).toBe(false); // s > N,
      expect(await check({ sig: badge.sig.slice(1) })).toBe(false); // and a wrong length.
    } finally {
      spy.mockRestore();
    }
  });

  it('signature >= N rejected (sig + N, N, 2^k - 1)', async () => {
    const k = bits / 8;
    expect(await check({ sig: bigIntToBytes(key.n, k) })).toBe(false);
    expect(await check({ sig: new Uint8Array(k).fill(0xff) })).toBe(false);
    // Malleability probe: a non-reduced twin sig+N is only representable when sig < 2^bits - N.
    let twinChecked = false;
    for (let i = 0; i < 40 && !twinChecked; i++) {
      const b = await issueBadge(key, issuer, randomCtx());
      const twin = bytesToBigInt(b.sig) + key.n;
      if (twin >= 1n << BigInt(bits)) continue;
      const twinBytes = bigIntToBytes(twin, k);
      expect(twinBytes.length).toBe(k);
      expect(await verifyBadge(bind(key, b.ctx), { ownerId: b.ctx.ownerId, msgPrefix: b.msgPrefix, sig: twinBytes })).toBe(false);
      // What bare WebCrypto does with the same twin is informational: Node/OpenSSL rejects (RSAVP1 range check).
      const raw = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key.cryptoKey, copy(twinBytes), copy(b.preparedMsg));
      console.log(`[s>=N] bare Node WebCrypto verify(sig+N) = ${raw}`);
      twinChecked = true;
    }
    expect(twinChecked).toBe(true);
  });

  it('finalize rejects blind signatures of wrong length or >= N', async () => {
    const c = randomCtx();
    const { preparedMsg } = prepareBadge(bind(key, c), c.ownerId);
    const { blindedMsg, inv } = await blind(key, preparedMsg);
    const good = issuer.blindSign(blindedMsg);
    await expect(finalize(key, preparedMsg, good.slice(1), inv)).rejects.toThrow();
    await expect(finalize(key, preparedMsg, concat(good, Uint8Array.of(0)), inv)).rejects.toThrow();
    // the library itself accepts good + N (it reduces mod n silently); the wrapper must refuse
    const twin = bytesToBigInt(good) + key.n;
    if (twin < 1n << BigInt(bits)) {
      const twinBytes = bigIntToBytes(twin, bits / 8);
      expect((await suite().finalize(key.cryptoKey, copy(preparedMsg), copy(twinBytes), copy(inv))).length).toBe(bits / 8);
      await expect(finalize(key, preparedMsg, twinBytes, inv)).rejects.toThrow(/modulus/);
    }
    await expect(finalize(key, preparedMsg, new Uint8Array(bits / 8).fill(0xff), inv)).rejects.toThrow(/modulus/);
    await expect(finalize(key, preparedMsg, bigIntToBytes(key.n, bits / 8), inv)).rejects.toThrow(/modulus/);
    await expect(finalize(key, preparedMsg, good, inv.slice(1))).rejects.toThrow();
    // and a corrupted blind signature fails library verification
    const evil = good.slice();
    evil[10]! ^= 1;
    await expect(finalize(key, preparedMsg, evil, inv)).rejects.toThrow();
    // sanity: the good one finalizes
    expect((await finalize(key, preparedMsg, good, inv)).length).toBe(bits / 8);
  });

  it('a signature does not verify for a different message of the same issuer', async () => {
    const other2 = await issueBadge(key, issuer, randomCtx());
    expect(await verify(key, badge.sig, other2.preparedMsg)).toBe(false);
  });
});

describe('blinding-factor reuse (documented client rule, not detectable by issuer)', () => {
  it('library draws a fresh r and PSS salt on every blind() call', async () => {
    const { key } = await setup(2048);
    const { preparedMsg } = prepare(rnd(10));
    const a = await blind(key, preparedMsg);
    const b = await blind(key, preparedMsg);
    expect(toHex(a.blindedMsg)).not.toBe(toHex(b.blindedMsg));
    expect(toHex(a.inv)).not.toBe(toHex(b.inv));
  });

  it('a repeated blindedMsg gets the same signature back (idempotent retry; reuse of r looks identical to the issuer)', async () => {
    // RFC 9474 gives the issuer no way to tell reuse of r from a retry. PLAN §8.4 rule 4 therefore makes a
    // repeated H(blindedMsg) idempotent (same signature back). Reuse of r is a client-side rule (CSPRNG per
    // blind() call; the browser build never persists inv/r) and is enforced only by using the library as is.
    const { key, issuer } = await setup(2048);
    const { preparedMsg } = prepare(rnd(10));
    const { blindedMsg } = await blind(key, preparedMsg);
    expect(toHex(issuer.blindSign(blindedMsg))).toBe(toHex(issuer.blindSign(blindedMsg)));
  });
});

describe('issuer input validation', () => {
  it.each([2048, 3072] as const)('%i-bit: rejects wrong length, >= n, 0, 1', async (bits) => {
    const { key, issuer } = await setup(bits);
    const k = bits / 8;
    const reject = (x: Uint8Array, code: string) => {
      try {
        issuer.blindSign(x);
      } catch (e) {
        expect(e).toBeInstanceOf(IssuerError);
        expect((e as IssuerError).code).toBe(code);
        return;
      }
      throw new Error('expected rejection');
    };
    reject(new Uint8Array(0), 'bad-length');
    reject(rnd(k - 1), 'bad-length');
    reject(rnd(k + 1), 'bad-length');
    reject(bigIntToBytes(key.n, k), 'out-of-range'); // == n
    reject(bigIntToBytes(key.n + 5n, k), 'out-of-range'); // > n (fits as k bytes)
    reject(new Uint8Array(k).fill(0xff), 'out-of-range');
    reject(new Uint8Array(k), 'out-of-range'); // 0
    reject(bigIntToBytes(1n, k), 'out-of-range'); // 1
    // n - 1 is in range and must be signed (and verified) successfully
    expect(issuer.blindSign(bigIntToBytes(key.n - 1n, k)).length).toBe(k);
  });

  it('refuses to return a faulty signature (simulated CRT fault)', async () => {
    const kp = generateIssuerKey(2048);
    const real = new BlindIssuer(kp.privateKey);
    const faulty = new BlindIssuer(kp.privateKey, {
      rawSign: (m) => {
        const s = real.blindSign(m).slice();
        s[100]! ^= 1; // flip one bit: models a transient fault in one CRT half
        return s;
      },
    });
    const m = bigIntToBytes(123456789123456789n, 256);
    expect(() => faulty.blindSign(m)).toThrow(/does not verify/);
    // wrong-length / >= n outputs from the raw signer are also refused
    const short = new BlindIssuer(kp.privateKey, { rawSign: () => new Uint8Array(255) });
    expect(() => short.blindSign(m)).toThrow(IssuerError);
    const big = new BlindIssuer(kp.privateKey, { rawSign: () => new Uint8Array(256).fill(0xff) });
    expect(() => big.blindSign(m)).toThrow(IssuerError);
  });

  it('rejects unsupported key sizes and exponents at construction', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const k1024 = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(() => new BlindIssuer(k1024)).toThrow(/not allowed/);
    const k2047 = generateKeyPairSync('rsa', { modulusLength: 2047 }).privateKey;
    expect(() => new BlindIssuer(k2047)).toThrow(/2047 bits not allowed/);
    // epoch-key mismatch guard: the loaded private key must match the SPKI published for this epoch
    const kp = generateIssuerKey(2048);
    expect(() => new BlindIssuer(kp.privateKey, { expectedSpki: kp.spki })).not.toThrow();
    expect(() => new BlindIssuer(kp.privateKey, { expectedSpki: generateIssuerKey(2048).spki })).toThrow(/expectedSpki/);
    const k3 = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 }).privateKey;
    expect(() => new BlindIssuer(k3)).toThrow(/65537/);
  });
});

describe('client issuer-key import', () => {
  it('rejects e != 65537, disallowed sizes, and non-canonical SPKI', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const spki = (o: { modulusLength: number; publicExponent?: number }) =>
      new Uint8Array(generateKeyPairSync('rsa', o).publicKey.export({ type: 'spki', format: 'der' }));
    await expect(importIssuerKey(spki({ modulusLength: 2048, publicExponent: 3 }))).rejects.toThrow(/65537/);
    await expect(importIssuerKey(spki({ modulusLength: 2047 }))).rejects.toThrow(/2047 bits not allowed/);
    await expect(importIssuerKey(spki({ modulusLength: 3071 }))).rejects.toThrow(/modulus 30\d\d bits not allowed/);
    await expect(importIssuerKey(spki({ modulusLength: 1024 }))).rejects.toThrow(/not allowed/);
    const good = generateIssuerKey(2048).spki;
    // trailing garbage / non-canonical encodings must not produce a second valid keyId for one key
    await expect(importIssuerKey(concat(good, Uint8Array.of(0)))).rejects.toThrow(/canonical/);
    expect((await importIssuerKey(good)).keyId.length).toBe(32);
  });
});
