import { describe, expect, it } from 'vitest';
import { bytesToHex, governanceObjectHash, governanceObjectPreimage, hexToBytes, sha256d, uint256ToDisplay } from '../src/index.ts';
import { fixture } from './helpers.ts';

const props = fixture('proposals.regtest.json').proposals as Array<any>;
const scenarios = fixture('collateral.regtest.json').scenarios as Array<any>;

describe('governance object hash vs Dash Core (regtest gobject prepare / list-prepared)', () => {
  for (const p of props) {
    it(`matches Core: ${p.label}`, () => {
      expect(p.coreDataHex).toBe(p.dataHex);
      const h = governanceObjectHash({ parentHash: p.parent, revision: p.revision, time: p.time, dataHex: p.dataHex });
      expect(h.display).toBe(p.coreHash);
      // internal byte order is the reverse of the display order
      expect(uint256ToDisplay(h.raw)).toBe(p.coreHash);
      expect(bytesToHex(h.raw)).toBe(p.coreHash.match(/../g).reverse().join(''));
    });
  }
  for (const s of scenarios) {
    it(`matches Core: collateral scenario ${s.label}`, () => {
      expect(governanceObjectHash({ parentHash: s.parent, revision: s.revision, time: s.time, dataHex: s.dataHex }).display).toBe(s.coreHash);
    });
  }

  it('non-zero parent changes the hash and is hashed as raw (reversed) bytes', () => {
    const p = props.find((x) => x.label === 'nonzero-parent');
    const pre = governanceObjectPreimage({ parentHash: p.parent, revision: p.revision, time: p.time, dataHex: p.dataHex });
    const parentRaw = hexToBytes(p.parent.match(/../g).reverse().join(''));
    expect(bytesToHex(pre.subarray(0, 32))).toBe(bytesToHex(parentRaw));
    expect(governanceObjectHash({ parentHash: p.parent, revision: p.revision, time: p.time, dataHex: p.dataHex }).display).toBe(p.coreHash);
  });

  it('preimage layout is documented layout (lengths and tail)', () => {
    const dataHex = '7b7d'; // "{}"
    const pre = governanceObjectPreimage({ parentHash: '0', revision: 1, time: 0x0102030405060708n, dataHex });
    // 32 parent + 4 rev + 8 time + (1 + 4 hex chars) + 36 null outpoint + 1 + 4 + 1
    expect(pre.length).toBe(32 + 4 + 8 + 1 + 4 + 36 + 1 + 4 + 1);
    expect(bytesToHex(pre.subarray(32, 36))).toBe('01000000');
    expect(bytesToHex(pre.subarray(36, 44))).toBe('0807060504030201');
    expect(bytesToHex(pre.subarray(44, 49))).toBe('04' + Buffer.from('7b7d').toString('hex'));
    expect(bytesToHex(pre.subarray(49))).toBe('00'.repeat(32) + 'ffffffff' + '00' + 'ffffffff' + '00');
    expect(governanceObjectHash({ parentHash: '0', revision: 1, time: 0x0102030405060708n, dataHex }).raw).toEqual(sha256d(pre));
  });

  it('is case-insensitive on the data hex and rejects malformed input', () => {
    const a = governanceObjectHash({ parentHash: '0', revision: 1, time: 5, dataHex: '7B7D' });
    const b = governanceObjectHash({ parentHash: '0', revision: 1, time: 5, dataHex: '7b7d' });
    expect(a.display).toBe(b.display);
    expect(() => governanceObjectHash({ parentHash: '0', revision: 1, time: 5, dataHex: '7b7' })).toThrow();
    expect(() => governanceObjectHash({ parentHash: 'zz', revision: 1, time: 5, dataHex: '7b7d' })).toThrow();
    expect(() => governanceObjectHash({ parentHash: '0', revision: 2 ** 31, time: 5, dataHex: '7b7d' })).toThrow();
  });
});
