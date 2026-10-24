import { describe, expect, it } from 'vitest';
import { issueBadge, randomCtx, setup, verifyIssued } from './flow.js';

describe.each([2048, 3072] as const)('round trip, %i-bit key', (bits) => {
  const N = 1000;

  it(`blind -> sign -> finalize -> verify for ${N} random messages`, async () => {
    const { key, issuer } = await setup(bits);
    let bad = 0;
    const t = performance.now();
    for (let i = 0; i < N; i++) {
      const ctx = randomCtx();
      const b = await issueBadge(key, issuer, ctx);
      if (b.sig.length !== bits / 8 || b.msgPrefix.length !== 32) bad++;
      if (!(await verifyIssued(key, b))) bad++;
    }
    console.log(`[roundtrip ${bits}] ${N} full round trips in ${(performance.now() - t).toFixed(0)} ms`);
    expect(bad).toBe(0);
  });
});
