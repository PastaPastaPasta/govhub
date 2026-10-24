import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/bytes.js';
import { bindIssuerKey, importIssuerKey, prepare, prepareBadge } from '../src/client.js';
import { BADGE_MESSAGE_LEN, buildBadgeMessage, parseBadgeMessage } from '../src/format.js';
import { generateIssuerKey } from '../src/issuer.js';
import { rnd } from './helpers.js';

const fields = () => ({ net: 2, contractId: rnd(32), issuerId: rnd(32), keyId: rnd(32), epoch: 0x01020304, ownerId: rnd(32) });

describe('badge message format (PLAN §8.3)', () => {
  it('is fixed-width: tag(15) net(1) contractId(32) issuerId(32) keyId(32) epoch(4 BE) ownerId(32) = 148 B', () => {
    const f = fields();
    const m = buildBadgeMessage(f);
    expect(m.length).toBe(148);
    expect(BADGE_MESSAGE_LEN).toBe(148);
    expect(new TextDecoder().decode(m.slice(0, 15))).toBe('govhub-badge:v2');
    expect(m[15]).toBe(2);
    expect(toHex(m.slice(16, 48))).toBe(toHex(f.contractId));
    expect(toHex(m.slice(48, 80))).toBe(toHex(f.issuerId));
    expect(toHex(m.slice(80, 112))).toBe(toHex(f.keyId));
    expect(toHex(m.slice(112, 116))).toBe('01020304');
    expect(toHex(m.slice(116, 148))).toBe(toHex(f.ownerId));
    expect(parseBadgeMessage(m)).toEqual(f);
  });

  it('rejects malformed fields', () => {
    expect(() => buildBadgeMessage({ ...fields(), ownerId: rnd(31) })).toThrow();
    expect(() => buildBadgeMessage({ ...fields(), epoch: -1 })).toThrow();
    expect(() => buildBadgeMessage({ ...fields(), epoch: 2 ** 32 })).toThrow();
    expect(() => buildBadgeMessage({ ...fields(), net: 256 })).toThrow();
    expect(() => parseBadgeMessage(new Uint8Array(147))).toThrow();
  });

  it('prepared message = 32-byte random prefix || badge message; keyId = SHA256(SPKI)', async () => {
    const kp = generateIssuerKey(2048);
    const key = await importIssuerKey(kp.spki);
    expect(toHex(key.keyId)).toBe(toHex(await sha256(kp.spki)));
    const ctx = { net: 1, contractId: rnd(32), issuerId: rnd(32), epoch: 9, ownerId: rnd(32) };
    const { ownerId, ...binding } = ctx;
    const p = prepareBadge(bindIssuerKey(key, binding), ownerId);
    expect(p.preparedMsg.length).toBe(32 + 148);
    expect(toHex(p.preparedMsg.slice(0, 32))).toBe(toHex(p.msgPrefix));
    expect(toHex(p.preparedMsg.slice(32))).toBe(toHex(p.message));
    expect(parseBadgeMessage(p.message).keyId).toEqual(key.keyId);
    // the prefix is fresh randomness per prepare()
    expect(toHex(prepare(p.message).msgPrefix)).not.toBe(toHex(p.msgPrefix));
  });
});
