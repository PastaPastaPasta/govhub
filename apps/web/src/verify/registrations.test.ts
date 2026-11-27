// The build's registration table: a round trip, refusal of anything else, and the cache that answers from it before this browser's own.
import { describe, expect, it } from 'vitest';
import type { ProRegInfo } from '@govhub/dapi';
import { decodeRegistrations, encodeRegistrations, withShippedRegistrations } from './registrations.ts';

const a = 'ab'.repeat(32), b = 'cd'.repeat(32), c = 'ef'.repeat(32);
const facts = new Map<string, ProRegInfo>([
  [a, { type: 1, collateral: { txid: '01'.repeat(32), index: 7 } }],
  [b, { type: 0, collateral: { txid: b, index: 0xfffffffe } }],
]);

describe('registration table', () => {
  it('round-trips the facts and the list height', () => {
    const t = decodeRegistrations(encodeRegistrations('mainnet', 2_567_252, facts), 'mainnet')!;
    expect(t.height).toBe(2_567_252);
    expect(t.entries).toEqual(facts);
  });
  it("refuses another network's table, a truncated one and other bytes", () => {
    const bytes = encodeRegistrations('mainnet', 1, facts);
    expect(decodeRegistrations(bytes, 'testnet')).toBeNull();
    expect(decodeRegistrations(bytes.subarray(0, bytes.length - 1), 'mainnet')).toBeNull();
    expect(decodeRegistrations(new TextEncoder().encode('<!doctype html>'), 'mainnet')).toBeNull();
  });
  it("answers from the table first and asks this browser's cache only for the rest", async () => {
    const asked: string[][] = [];
    const inner = { load: async (h: readonly string[]) => (asked.push([...h]), new Map([[c, { type: 0, collateral: { txid: c, index: 1 } }]])), save: async () => {} };
    const cache = withShippedRegistrations('mainnet', inner, async () => facts);
    const got = await cache.load([a, c]);
    expect(asked).toEqual([[c]]);
    expect([...got.keys()].sort()).toEqual([a, c].sort());
    expect(got.get(a)?.type).toBe(1);
  });
});
