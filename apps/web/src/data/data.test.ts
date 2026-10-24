import { describe, expect, it } from 'vitest';
import { BridgeError, parseMasternode, parseProposal, parseTally, parseVote } from './bridge.ts';
import { loadFixtures } from './fixtures.ts';
import { docToProposal, docToTally } from './platform.ts';
import { GOV_PARAMS, absoluteYes, fundingThreshold } from '../lib/governance.ts';

describe('fixture snapshot', () => {
  it('shapes the 28 mainnet proposals like gov documents', async () => {
    const s = await loadFixtures();
    expect(s.proposals).toHaveLength(28);
    expect(s.height).toBe(2_560_391);
    for (const p of s.proposals) {
      expect(p.govHash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.collateralTxid).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(p.paymentAmount)).toBe(true);
    }
  });

  it('cycle and tallies follow Core rules', async () => {
    const s = await loadFixtures();
    const threshold = fundingThreshold(s.cycle.validWeighted, GOV_PARAMS.mainnet);
    expect(threshold).toBe(332);
    expect(s.cycle.allocated).toBeLessThanOrEqual(s.cycle.budget);
    const funded = [...s.tallies.values()].filter((t) => t.inNextBudget);
    expect(funded.length).toBeGreaterThan(0);
    for (const t of funded) expect(absoluteYes(t)).toBeGreaterThanOrEqual(threshold);
    const ranks = [...s.tallies.values()].map((t) => t.rank).sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(s.tallies.get(s.proposals[0]!.govHash)!.margin).toBe(348 - 332);
  });
});

describe('Platform document JSON -> domain', () => {
  // Shape of a real testnet document (toJSON of a queryWithProof result).
  const doc = {
    $id: 'GiCkEzSnk6SCCbXgjCnPYtvviYiRS5Vnbu7AcpAMUPFE',
    $createdAt: 1792800000000,
    govHash: 'ZFSRN5FFs1hwAgXik28A4GANN5FMwiMFpqJH5GQjtWA=',
    parentHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    revision: 1,
    time: 1792790000,
    dataHex: '7b7d',
    name: 'govhub-spike-1',
    url: 'https://example.org',
    paymentAddress: 'yMbJNiVrPFaPJjCsomething',
    paymentAmount: 100000000,
    startEpoch: 1,
    endEpoch: 2,
    collateralTxid: 'Ul7PZL0SUjKxDYTtAU7fn6e7PpB5WldsFg3ReVz+YT8=',
    collateralHeight: 1578000,
  };
  it('decodes byte arrays from base64 to hex without reordering', () => {
    const p = docToProposal(doc);
    expect(p.govHash).toBe('645491379145b358700205e2936f00e0600d37914cc22305a6a247e46423b560'); // Buffer.from(b64, 'base64').toString('hex')
    expect(p.parentHash).toBe('0'.repeat(64));
    expect(p.docId).toBe(doc.$id);
    expect(p.createdAt).toBe(doc.$createdAt);
  });
  it('tally integers and booleans', () => {
    const t = docToTally({ govHash: doc.govHash, voteSetHash: doc.govHash, asOfHeight: 5, yesWeighted: 10, noWeighted: 2, abstainWeighted: 0, yesCount: 7, noCount: 2, abstainCount: 0, rank: 1, inNextBudget: true, margin: -3 });
    expect(absoluteYes(t)).toBe(8);
    expect(t.inNextBudget).toBe(true);
  });
  it('throws on a missing field instead of rendering garbage', () => {
    expect(() => docToProposal({ ...doc, name: undefined })).toThrow(/name/);
  });
});

describe('bridge response parsing (untrusted input)', () => {
  const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
  it('accepts the documented shapes and string outcomes', () => {
    expect(parseVote({ collateralTxid: H, collateralIndex: 1, outcome: 'yes', time: 5, sig: 'x' }).outcome).toBe(1);
    expect(parseMasternode({ proTxHash: H, collateralTxid: H, collateralIndex: 0, votingAddress: 'X', type: 'Evo' }).type).toBe('evo');
    expect(parseTally({ govHash: H, asOfHeight: 1, yesWeighted: 1, noWeighted: 0, abstainWeighted: 0, yesCount: 1, noCount: 0, abstainCount: 0, margin: -5 }).margin).toBe(-5);
  });
  it('rejects malformed values', () => {
    expect(() => parseVote({ collateralTxid: 'zz', collateralIndex: 1, outcome: 1, time: 5, sig: 'x' })).toThrow(BridgeError);
    expect(() => parseVote({ collateralTxid: H, collateralIndex: 1, outcome: 9, time: 5, sig: 'x' })).toThrow(/outcome/);
    expect(() => parseProposal({ govHash: H })).toThrow(BridgeError);
    expect(() => parseTally({ govHash: H, asOfHeight: -1 })).toThrow(BridgeError);
  });
});
