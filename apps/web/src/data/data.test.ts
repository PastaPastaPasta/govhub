import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import openapi from '../../../../services/bridge/openapi.json';
import { BridgeError, HttpBridge, parseCycle, parseMasternode, parseMnList, parseProposal, parseTally, parseVote, parseVotes } from './bridge.ts';
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

describe('bridge client against services/bridge/openapi.json (untrusted input)', () => {
  const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
  type Schema = { $ref?: string; type?: string | string[]; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema> };
  const schemas = openapi.components.schemas as unknown as Record<string, Schema>;

  /** An instance holding ONLY the fields the spec marks required, so a parser that needs more than the spec promises fails here. */
  function sample(s: Schema, over: Record<string, unknown> = {}): unknown {
    if (s.$ref) return s.$ref.endsWith('/Hex32') ? 'ab'.repeat(32) : sample(schemas[s.$ref.split('/').pop()!]!);
    if (s.enum) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
    if (t === 'integer') return 1;
    if (t === 'boolean') return true;
    if (t === 'array') return [];
    if (t === 'object' || s.properties) {
      const o: Record<string, unknown> = {};
      for (const k of s.required ?? []) o[k] = k in over ? over[k] : sample(s.properties?.[k] ?? { type: 'string' });
      return o;
    }
    return 'x';
  }

  it('parses instances that carry only the required fields of Tally, Vote, masternode, MnList and Cycle', () => {
    expect(parseTally(sample(schemas.Tally!)).voteSetHash).toBe('ab'.repeat(32));
    expect(parseVote(sample(schemas.Vote!)).signal).toBe(1);
    const mnSchema = (schemas.MnList!.properties!.masternodes as unknown as { items: Schema }).items;
    // the spec types these ids as plain strings; real ones are 64 hex chars, which the client insists on
    const entry = { ...(sample(mnSchema) as object), proTxHash: H, collateralTxid: H };
    expect(parseMasternode(entry).type).toBe('regular');
    const mn = sample(schemas.MnList!, { masternodes: [entry] });
    expect(parseMnList(mn).masternodes).toHaveLength(1);
    expect(parseCycle(sample(schemas.Cycle!)).paid).toBe(1);
    const votes = parseVotes(sample(schemas.VoteSet!, { votes: [sample(schemas.Vote!)], govHash: H }), H);
    expect(votes.votes).toHaveLength(1);
    expect(votes.asOfHeight).toBe(0); // optional / nullable in the spec
  });

  it('uses the spec\'s field names and enums', () => {
    expect(Object.keys(schemas.VoteSet!.properties!)).toEqual(expect.arrayContaining(['asOfHeight', 'tallyHeight', 'mnListHash', 'voteSetHash', 'votes']));
    expect(parseMasternode({ proTxHash: H, collateralTxid: H, collateralIndex: 0, votingAddress: 'X', type: 'evo', valid: false }).type).toBe('evo');
    const vs = parseVotes({ govHash: H, asOfHeight: 7, tallyHeight: 5, mnListHash: 'beef', voteSetHash: H, votes: [] }, H);
    expect([vs.asOfHeight, vs.tallyHeight, vs.mnListHash, vs.voteSetHash]).toEqual([7, 5, 'beef', H]);
    expect(parseVotes({ asOfHeight: null, voteSetHash: null, votes: [] }, H)).toMatchObject({ asOfHeight: 0, tallyHeight: 0, voteSetHash: null });
    expect(parseTally({ govHash: H, asOfHeight: 1, yesWeighted: 1, noWeighted: 0, abstainWeighted: 0, yesCount: 1, noCount: 0, abstainCount: 0, voteSetHash: H, rank: 2, inNextBudget: false, margin: -5, passing: false }).margin).toBe(-5);
  });

  it('rejects what the spec does not allow', () => {
    const vote = { collateralTxid: H, collateralIndex: 1, signal: 1, outcome: 1, time: 5, sig: 'x' };
    expect(parseVote(vote).outcome).toBe(1);
    expect(() => parseVote({ ...vote, collateralTxid: 'zz' })).toThrow(BridgeError);
    expect(() => parseVote({ ...vote, outcome: 9 })).toThrow(/outcome/);
    expect(() => parseVote({ ...vote, outcome: 'yes' })).toThrow(BridgeError); // integers on the wire
    expect(() => parseVote({ ...vote, signal: undefined })).toThrow(BridgeError);
    expect(() => parseMasternode({ proTxHash: H, collateralTxid: H, collateralIndex: 0, votingAddress: 'X', type: 'Evo', valid: true })).toThrow(/type/);
    expect(() => parseProposal({ govHash: H })).toThrow(BridgeError);
    expect(() => parseProposal({ ...(sample(schemas.Proposal!) as object), name: null })).toThrow(BridgeError); // data Core could not parse
    expect(() => parseTally({ govHash: H, asOfHeight: -1 })).toThrow(BridgeError);
  });

  describe('HttpBridge', () => {
    const responses = new Map<string, unknown>();
    const urls: string[] = [];
    const base = 'https://bridge.test';
    beforeEach(() => {
      responses.clear();
      urls.length = 0;
      vi.stubGlobal('fetch', async (u: string) => {
        urls.push(u.replace(base, ''));
        const body = responses.get(u.replace(base, ''));
        return body === undefined ? new Response('{"error":"not found"}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
      });
    });
    afterEach(() => vi.unstubAllGlobals());
    const bridge = new HttpBridge('test bridge', base);
    const voteSet = { govHash: H, network: 'mainnet', voteSetHashVersion: 'govhub-voteset-v1', asOfHeight: 100, tallyHeight: 98, mnListHash: 'l1', voteSetHash: H, count: 0, votes: [] };

    it('asks for the vote set behind a tally with ?height=, and the masternode list at that height', async () => {
      responses.set(`/v1/proposals/${H}/votes?height=100`, voteSet);
      responses.set(`/v1/proposals/${H}/votes`, { ...voteSet, asOfHeight: 120, tallyHeight: 120 });
      responses.set('/v1/mnlist/98', { height: 97, listHash: 'l1', masternodes: [] });
      expect((await bridge.votes(H, { height: 100 })).tallyHeight).toBe(98);
      expect((await bridge.votes(H)).asOfHeight).toBe(120);
      expect((await bridge.mnlist(98)).listHash).toBe('l1');
      expect(urls).toEqual([`/v1/proposals/${H}/votes?height=100`, `/v1/proposals/${H}/votes`, '/v1/mnlist/98']);
    });

    it('turns a 404 for a height into a BridgeError with status 404 (the caller falls back to the live set)', async () => {
      await expect(bridge.votes(H, { height: 5 })).rejects.toMatchObject({ name: 'BridgeError', status: 404 });
      await expect(bridge.mnlist(5)).rejects.toMatchObject({ status: 404 });
    });

    it('lists active proposals, skipping those whose data Core could not parse, and unwraps the cycle envelope', async () => {
      const good = { ...(sample(schemas.Proposal!) as object), name: 'a', url: 'https://a', paymentAddress: 'X', paymentAmount: 1, startEpoch: 1, endEpoch: 2 };
      responses.set('/v1/proposals?state=active', { state: 'active', count: 2, proposals: [good, { ...good, govHash: 'cd'.repeat(32), name: null }] });
      responses.set('/v1/cycle', { asOfHeight: 5, cycle: sample(schemas.Cycle!), last: null });
      expect((await bridge.proposals()).map((p) => p.name)).toEqual(['a']);
      expect((await bridge.cycle())?.superblockHeight).toBe(1);
    });
  });
});
