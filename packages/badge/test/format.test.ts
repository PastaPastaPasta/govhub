import { describe, expect, it } from 'vitest';
import { toHex } from '../src/bytes.ts';
import { BADGE_MESSAGE_LEN, buildBadgeMessage, NET_BYTE, parseBadgeMessage } from '../src/format.ts';
import { rnd } from './helpers.ts';

describe('badge message', () => {
  it('is 148 bytes with the PLAN §8.3 layout and round trips', () => {
    const f = { net: 'testnet' as const, contractId: rnd(32), issuerId: rnd(32), keyId: rnd(32), epoch: 0x01020304, ownerId: rnd(32) };
    const m = buildBadgeMessage(f);
    expect(m.length).toBe(BADGE_MESSAGE_LEN);
    expect(BADGE_MESSAGE_LEN).toBe(148);
    expect(new TextDecoder().decode(m.subarray(0, 15))).toBe('govhub-badge:v2');
    expect(m[15]).toBe(NET_BYTE.testnet);
    expect(toHex(m.subarray(16, 48))).toBe(toHex(f.contractId));
    expect(toHex(m.subarray(48, 80))).toBe(toHex(f.issuerId));
    expect(toHex(m.subarray(80, 112))).toBe(toHex(f.keyId));
    expect(toHex(m.subarray(112, 116))).toBe('01020304');
    expect(toHex(m.subarray(116, 148))).toBe(toHex(f.ownerId));
    expect(parseBadgeMessage(m)).toEqual(f);
  });
  it('rejects bad shapes', () => {
    const f = { net: 'mainnet' as const, contractId: rnd(32), issuerId: rnd(32), keyId: rnd(32), epoch: 1, ownerId: rnd(32) };
    expect(() => buildBadgeMessage({ ...f, ownerId: rnd(31) })).toThrow();
    expect(() => buildBadgeMessage({ ...f, epoch: -1 })).toThrow();
    expect(() => buildBadgeMessage({ ...f, epoch: 2 ** 32 })).toThrow();
    expect(() => buildBadgeMessage({ ...f, net: 'toString' as never })).toThrow();
    const m = buildBadgeMessage(f);
    m[15] = 9;
    expect(() => parseBadgeMessage(m)).toThrow(/network/);
  });
});
