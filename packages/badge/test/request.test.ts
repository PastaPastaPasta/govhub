import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { bytesToId, sha256, toHex } from '../src/bytes.ts';
import { buildTokenRequest, buildTokenRequestFor, parseTokenRequest, requestBindsBlindedMsg, type TokenRequest } from '../src/request.ts';
import { rnd } from './helpers.ts';

const sample = (): TokenRequest => ({ net: 'mainnet', issuerId: rnd(32), epoch: 7, keyId: rnd(32), proTxHash: rnd(32), nonce: rnd(32), blindedMsgSha256: rnd(32) });

describe('token request', () => {
  it('builds the PLAN §8.3 shape and parses back', () => {
    const r = sample();
    const s = buildTokenRequest(r);
    const f = s.split('|');
    expect(f).toEqual(['govhub-badge-req:v2', 'mainnet', bytesToId(r.issuerId), '7', toHex(r.keyId), toHex(r.proTxHash), toHex(r.nonce), toHex(r.blindedMsgSha256)]);
    expect(parseTokenRequest(s)).toEqual(r);
  });

  it('binds SHA256(blindedMsg)', async () => {
    const blinded = rnd(256);
    const { blindedMsgSha256: _, ...rest } = sample();
    const req = parseTokenRequest(await buildTokenRequestFor(rest, blinded));
    expect(toHex(req.blindedMsgSha256)).toBe(toHex(await sha256(blinded)));
    expect(await requestBindsBlindedMsg(req, blinded)).toBe(true);
    const other = blinded.slice();
    other[0]! ^= 1;
    expect(await requestBindsBlindedMsg(req, other)).toBe(false);
  });

  it('parser is strict and canonical', () => {
    const s = buildTokenRequest(sample());
    const f = s.split('|');
    const mut = (i: number, v: string) => f.map((x, j) => (j === i ? v : x)).join('|');
    expect(() => parseTokenRequest(s + '|x')).toThrow();
    expect(() => parseTokenRequest(f.slice(0, 7).join('|'))).toThrow();
    expect(() => parseTokenRequest(mut(0, 'govhub-badge-req:v1'))).toThrow(/tag/);
    expect(() => parseTokenRequest(mut(1, 'Mainnet'))).toThrow(/net/);
    expect(() => parseTokenRequest(mut(2, base58.encode(rnd(31))))).toThrow();
    expect(() => parseTokenRequest(mut(2, '0OIl'))).toThrow();
    expect(() => parseTokenRequest(mut(3, '07'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(3, '-1'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(3, '4294967296'))).toThrow(/epoch/);
    expect(() => parseTokenRequest(mut(4, f[4]!.toUpperCase()))).toThrow(/keyId/);
    expect(() => parseTokenRequest(mut(5, f[5]!.slice(2)))).toThrow(/proTxHash/);
    expect(() => parseTokenRequest(mut(6, 'ab'))).toThrow(/nonce/);
    expect(() => parseTokenRequest(mut(6, 'ab'.repeat(65)))).toThrow(/nonce/);
    expect(() => parseTokenRequest(mut(7, f[7]!.slice(0, 62) + 'zz'))).toThrow(/blindedMsgSha256/);
    expect(() => parseTokenRequest(' ' + s)).toThrow();
    expect(() => parseTokenRequest(s + '\n')).toThrow();
  });

  it('net names only, never inherited object keys', () => {
    const f = buildTokenRequest(sample()).split('|');
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'MAINNET', '']) {
      expect(() => parseTokenRequest(f.map((x, j) => (j === 1 ? bad : x)).join('|')), bad).toThrow(/net/);
      expect(() => buildTokenRequest({ ...sample(), net: bad as never }), bad).toThrow(/net/);
    }
    for (const ok of ['mainnet', 'testnet', 'devnet', 'regtest'] as const) expect(parseTokenRequest(buildTokenRequest({ ...sample(), net: ok })).net).toBe(ok);
  });

  it('bounded work on hostile input; the longest legal request parses', () => {
    const f = buildTokenRequest(sample()).split('|');
    const t = performance.now();
    expect(() => parseTokenRequest(f.map((x, j) => (j === 2 ? '1'.repeat(100_000) : x)).join('|'))).toThrow(/too long/);
    expect(performance.now() - t).toBeLessThan(50);
    const longest = buildTokenRequest({ ...sample(), issuerId: new Uint8Array(32).fill(0xff), epoch: 0xffffffff, nonce: rnd(64) });
    expect(longest.length).toBeLessThanOrEqual(407);
    expect(parseTokenRequest(longest).epoch).toBe(0xffffffff);
  });
});
