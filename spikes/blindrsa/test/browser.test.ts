// Headless Chromium (Playwright) running the same client bundle from a file:// page.
// The issuer stays in Node; blinded messages / blind signatures cross the page boundary as hex.
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bigIntToBytes, bytesToBigInt, fromHex, toHex } from '../src/bytes.js';
import { buildBrowserBundle, launch } from './browser-helper.js';
import { bind, ctxHex, issueBadge, randomCtx, setup } from './flow.js';
import { verifyBadge } from '../src/client.js';

let browser: Browser;
let call: Awaited<ReturnType<typeof launch>>['call'];

beforeAll(async () => {
  buildBrowserBundle();
  ({ browser, call } = await launch());
});
afterAll(async () => {
  await browser?.close();
});

describe('Chromium client', () => {
  it('runs in a secure context with WebCrypto', async () => {
    const s = await call('secure');
    expect(s).toEqual({ isSecureContext: true, subtle: true });
    console.log('[browser]', await call('ua'));
  });

  describe.each([2048, 3072] as const)('%i-bit key', (bits) => {
    it('browser blind/finalize/verify against the Node issuer (25 round trips)', async () => {
      const { key, issuer, kp } = await setup(bits);
      const imp = await call('importKey', toHex(kp.spki));
      expect(imp.keyIdHex).toBe(toHex(key.keyId)); // browser derives the same keyId as Node
      for (let i = 0; i < 25; i++) {
        const ctx = randomCtx();
        const s = await call('start', ctxHex(ctx));
        const blindSig = issuer.blindSign(fromHex(s.blindedHex));
        const f = await call('finish', toHex(blindSig));
        expect(f.ok).toBe(true);
        // and Node (OpenSSL RSA-PSS verify) accepts what the browser produced
        expect(await verifyBadge(bind(key, ctx), { ownerId: ctx.ownerId, msgPrefix: fromHex(f.msgPrefixHex), sig: fromHex(f.sigHex) })).toBe(true);
      }
    });

    it('browser verifies badges issued by the Node-side client (20 badges, incl. tampered)', async () => {
      const { key, issuer, kp } = await setup(bits);
      await call('importKey', toHex(kp.spki));
      const badges = [];
      for (let i = 0; i < 20; i++) {
        const ctx = randomCtx();
        const b = await issueBadge(key, issuer, ctx);
        badges.push({ ctx: ctxHex(ctx), msgPrefixHex: toHex(b.msgPrefix), sigHex: toHex(b.sig), preparedHex: toHex(b.preparedMsg) });
      }
      const r = await call('benchVerify', badges, 1);
      expect(r.allOk).toBe(true);
      // wrong-owner and flipped-sig variants fail in the browser too
      const b0 = badges[0]!;
      const wrongOwner = { ...b0, ctx: { ...b0.ctx, ownerId: toHex(new Uint8Array(32).fill(7)) } };
      expect((await call('benchVerify', [wrongOwner], 1)).allOk).toBe(false);
      const sig = fromHex(b0.sigHex);
      sig[5]! ^= 1;
      expect(await call('rawVerify', toHex(sig), b0.preparedHex)).toBe(false);
      expect(await call('rawVerify', b0.sigHex, b0.preparedHex)).toBe(true);
    });

    it('browser rejects s >= N (reader rule), and records what bare Chromium WebCrypto does', async () => {
      const { key, issuer, kp } = await setup(bits);
      await call('importKey', toHex(kp.spki));
      for (let i = 0; i < 60; i++) {
        const b = await issueBadge(key, issuer, randomCtx());
        const twin = bytesToBigInt(b.sig) + key.n;
        if (twin >= 1n << BigInt(bits)) continue;
        const r = await call('verifyRawVsWrapper', toHex(bigIntToBytes(twin, bits / 8)), toHex(b.preparedMsg));
        console.log(`[browser s>=N ${bits}] bare Chromium WebCrypto accepts sig+N: ${r.rawWebCryptoAccepts}`);
        expect(r.wrapperAccepts).toBe(false);
        return;
      }
      throw new Error('no sig small enough to build sig+N');
    });
  });
});
