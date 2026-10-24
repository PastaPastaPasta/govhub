import { describe, expect, it } from 'vitest';
import { Challenges, NONCE_LEN } from '../src/challenge.ts';
import { rnd } from './helpers.ts';

describe('challenges', () => {
  const c = new Challenges(rnd(32), 'testnet|issuer', 600);
  it('valid until expiry', () => {
    const { nonce, expiresAt } = c.issue(1000);
    expect(nonce.length).toBe(NONCE_LEN);
    expect(expiresAt).toBe(1600);
    expect(c.check(nonce, 1000)).toBe(true);
    expect(c.check(nonce, 1600)).toBe(true);
    expect(c.check(nonce, 1601)).toBe(false);
  });
  it('tampering, other secret, other domain, far-future expiry', () => {
    const { nonce } = c.issue(1000);
    for (const i of [0, 16, 23, 24, 39]) {
      const t = nonce.slice();
      t[i]! ^= 1;
      expect(c.check(t, 1000), `byte ${i}`).toBe(false);
    }
    expect(new Challenges(rnd(32), 'testnet|issuer', 600).check(nonce, 1000)).toBe(false);
    const sameSecret = rnd(32);
    const a = new Challenges(sameSecret, 'testnet|A', 600);
    const b = new Challenges(sameSecret, 'testnet|B', 600);
    expect(b.check(a.issue(1000).nonce, 1000)).toBe(false);
    const long = new Challenges(sameSecret, 'testnet|A', 100_000).issue(1000).nonce;
    expect(a.check(long, 1000)).toBe(false); // issued with a longer TTL than this server allows
    expect(c.check(rnd(39), 1000)).toBe(false);
  });
  it('refuses a short secret', () => {
    expect(() => new Challenges(rnd(16), 'x', 600)).toThrow();
  });
});
