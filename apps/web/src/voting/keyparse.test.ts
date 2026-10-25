// D-068: a refused pasted key leaves no copy of its bytes behind.
import { describe, expect, it, vi } from 'vitest';

const made: Uint8Array[] = [];
vi.mock('@govhub/auth', async (orig) => {
  const m = await orig<typeof import('@govhub/auth')>();
  return { ...m, hexToBytes: (h: string) => (made.push(m.hexToBytes(h)), made[made.length - 1]!) };
});
const { parseVotingKey } = await import('./masternodes.ts');

describe('D-068: leftover copies of key material', () => {
  it('wipes the bytes of a 64-hex input that is not a valid private key', () => {
    expect(() => parseVotingKey('ff'.repeat(32), 'testnet')).toThrow(/not a valid private key/);
    expect(made).toHaveLength(1);
    expect(made[0]!.every((b) => b === 0)).toBe(true);
  });
});
