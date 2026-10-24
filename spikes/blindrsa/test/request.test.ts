import { describe, expect, it } from 'vitest';
import { sha256, toHex } from '../src/bytes.js';
import {
  base58Decode,
  base58Encode,
  buildTokenRequest,
  buildTokenRequestFor,
  parseTokenRequest,
  requestBindsBlindedMsg,
  type TokenRequest,
} from '../src/request.js';
import { rnd } from './helpers.js';

const sample = (): TokenRequest => ({
  net: 'mainnet',
  issuerId: rnd(32),
  epoch: 7,
  keyId: rnd(32),
  proTxHash: rnd(32),
  nonce: rnd(32),
  blindedMsgSha256: rnd(32),
});

describe('token request message', () => {
  it('base58 round trips, including leading zero bytes', () => {
    for (const b of [new Uint8Array(32), Uint8Array.of(0, 0, 1), rnd(32), rnd(32)]) {
      expect(base58Decode(base58Encode(b))).toEqual(b);
    }
    expect(base58Encode(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV'); // well-known vector
  });

  it('builds the PLAN §8.3 shape and parses back', () => {
    const r = sample();
    const s = buildTokenRequest(r);
    const f = s.split('|');
    expect(f).toHaveLength(8);
    expect(f[0]).toBe('govhub-badge-req:v2');
    expect(f[1]).toBe('mainnet');
    expect(f[3]).toBe('7');
    expect(f[4]).toBe(toHex(r.keyId));
    expect(f[5]).toBe(toHex(r.proTxHash));
    expect(f[7]).toBe(toHex(r.blindedMsgSha256));
    expect(parseTokenRequest(s)).toEqual(r);
  });

  it('includes SHA256(blindedMsg) and the issuer can check the binding', async () => {
    const blinded = rnd(256);
    const { blindedMsgSha256: _, ...rest } = sample();
    const s = await buildTokenRequestFor(rest, blinded);
    const req = parseTokenRequest(s);
    expect(toHex(req.blindedMsgSha256)).toBe(toHex(await sha256(blinded)));
    expect(await requestBindsBlindedMsg(req, blinded)).toBe(true);
    const other = blinded.slice();
    other[0]! ^= 1;
    expect(await requestBindsBlindedMsg(req, other)).toBe(false);
  });

  it('parser is strict', () => {
    const s = buildTokenRequest(sample());
    const f = s.split('|');
    const mut = (i: number, v: string) => f.map((x, j) => (j === i ? v : x)).join('|');
    expect(() => parseTokenRequest(s + '|x')).toThrow();
    expect(() => parseTokenRequest(f.slice(0, 7).join('|'))).toThrow();
    expect(() => parseTokenRequest(mut(0, 'govhub-badge-req:v1'))).toThrow(/tag/);
    expect(() => parseTokenRequest(mut(1, 'Mainnet'))).toThrow(/net/);
    expect(() => parseTokenRequest(mut(2, base58Encode(rnd(31))))).toThrow(/32 bytes/);
    expect(() => parseTokenRequest(mut(2, '0OIl'))).toThrow(/base58/);
    expect(() => parseTokenRequest(mut(3, '07'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(3, '-1'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(3, '4294967296'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(4, f[4]!.toUpperCase()))).toThrow(/keyId/);
    expect(() => parseTokenRequest(mut(5, f[5]!.slice(2)))).toThrow(/proTxHash/);
    expect(() => parseTokenRequest(mut(6, 'ab'))).toThrow(/nonce/);
    expect(() => parseTokenRequest(mut(7, f[7]!.slice(0, 62) + 'zz'))).toThrow(/blindedMsgSha256/);
    expect(() => parseTokenRequest(' ' + s)).toThrow();
    expect(() => parseTokenRequest(s + '\n')).toThrow();
  });

  it('net must be one of the four names (not inherited object keys)', () => {
    const f = buildTokenRequest(sample()).split('|');
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'MAINNET', '']) {
      expect(() => parseTokenRequest(f.map((x, j) => (j === 1 ? bad : x)).join('|')), bad).toThrow(/net/);
      expect(() => buildTokenRequest({ ...sample(), net: bad as never }), bad).toThrow(/net/);
    }
    for (const ok of ['mainnet', 'testnet', 'devnet', 'regtest'] as const) {
      expect(parseTokenRequest(buildTokenRequest({ ...sample(), net: ok })).net).toBe(ok);
    }
  });

  it('bounded work on hostile input; the longest legal request parses', () => {
    const f = buildTokenRequest(sample()).split('|');
    const huge = f.map((x, j) => (j === 2 ? '1'.repeat(100_000) : x)).join('|');
    const t = performance.now();
    expect(() => parseTokenRequest(huge)).toThrow(/too long/);
    expect(() => parseTokenRequest('1'.repeat(1_000_000))).toThrow(/too long/);
    expect(performance.now() - t).toBeLessThan(50);
    const longest = buildTokenRequest({ ...sample(), net: 'mainnet', issuerId: new Uint8Array(32).fill(0xff), epoch: 0xffffffff, nonce: rnd(64) });
    expect(longest.length).toBeLessThanOrEqual(407);
    expect(parseTokenRequest(longest).epoch).toBe(0xffffffff);
  });

  it('epoch bounds', () => {
    expect(parseTokenRequest(buildTokenRequest({ ...sample(), epoch: 0 })).epoch).toBe(0);
    expect(parseTokenRequest(buildTokenRequest({ ...sample(), epoch: 0xffffffff })).epoch).toBe(0xffffffff);
    expect(() => buildTokenRequest({ ...sample(), epoch: 0x1_0000_0000 })).toThrow();
  });
});
