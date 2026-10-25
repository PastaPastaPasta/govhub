// The pre-mainnet cost pass on the read side: slim `proposal` documents (fields re-derived from dataHex), the packed `talliesSet`
// document, and how `tallies()` merges it with per-proposal `tally` documents (older testnet contracts, ended proposals).
import { encodeTallySetStream, splitTallySetStream, tallySetFields, type TallySetEntry } from '@govhub/verify';
import { base64 } from '@scure/base';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { profileRegistry } from '../config/registry.ts';
import { hexToB64 } from '../lib/bytes.ts';
import { checkContent } from '../verify/collateral.ts';
import { loadFixtures, type FixtureSnapshot } from './fixtures.ts';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import type { Proposal, Tally } from './types.ts';

// Platform is faked below the data layer: govDocTypes / queryDocs answer from these.
const platform = vi.hoisted(() => ({ types: new Set<string>(), docs: new Map<string, Record<string, unknown>[]>(), queries: [] as string[] }));
vi.mock('./platform.ts', async (orig) => {
  const real = await orig<typeof import('./platform.ts')>();
  return {
    ...real,
    govDocTypes: async () => platform.types,
    queryDocs: async (_r: unknown, q: DocQuery) => {
      platform.queries.push(q.documentTypeName);
      return { docs: platform.docs.get(q.documentTypeName) ?? [], height: 777 };
    },
  };
});
const { docToProposal, docToTallySet } = await import('./platform.ts');
const { liveSource } = await import('./repo.ts');

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
});

/** A proposal as the slim mainnet document stores it (JSON of a proved read: byte arrays base64). */
const slimDoc = (p: Proposal): Record<string, unknown> => ({
  $id: 'GiCkEzSnk6SCCbXgjCnPYtvviYiRS5Vnbu7AcpAMUPFE',
  $createdAt: p.createdAt,
  govHash: hexToB64(p.govHash),
  parentHash: hexToB64(p.parentHash),
  revision: p.revision,
  time: p.time,
  dataHex: p.dataHex,
  name: p.name,
  endEpoch: p.endEpoch,
  collateralTxid: hexToB64(p.collateralTxid),
  collateralHeight: p.collateralHeight,
});
const fullDoc = (p: Proposal) => ({ ...slimDoc(p), url: p.url, paymentAddress: p.paymentAddress, paymentAmount: p.paymentAmount, startEpoch: p.startEpoch });
const failed = (p: Proposal) => checkContent(p).steps.filter((s) => s.status === 'fail').map((s) => `${s.id}: ${s.detail}`);

describe('slim proposal documents', () => {
  it('re-derive url, payment address, amount and start from dataHex: the same Proposal as the full document, and it checks out', () => {
    for (const p of snap.proposals) {
      const { docId: _d, ...want } = p;
      const slim = docToProposal(slimDoc(p));
      expect({ ...slim, docId: undefined }).toEqual({ ...want, docId: undefined });
      expect(docToProposal(fullDoc(p))).toEqual(slim);
      expect(failed(slim)).toEqual([]);
    }
  });

  it('still fail the content check when the stored (indexed) name or end differs from the hashed data', () => {
    const p = snap.proposals[0]!;
    expect(failed(docToProposal({ ...slimDoc(p), name: 'someone-else' }))).toEqual([expect.stringMatching(/^fields: .*name/)]);
    expect(failed(docToProposal({ ...slimDoc(p), endEpoch: p.endEpoch + 86_400 }))).toEqual([expect.stringMatching(/^fields: .*end/)]);
  });

  it('with dataHex that does not parse: empty derived fields and a failed content check, never a guess', () => {
    const p = snap.proposals[0]!;
    const d = docToProposal({ ...slimDoc(p), dataHex: '7b7d' });
    expect([d.url, d.paymentAddress, d.paymentAmount, d.startEpoch]).toEqual(['', '', 0, 0]);
    expect(failed(d).join(' ')).toMatch(/does not parse/);
  });

  it('old-shape documents (existing testnet contracts) are read as stored, so a stored field that lies still fails', () => {
    const p = snap.proposals[0]!;
    expect(failed(docToProposal({ ...fullDoc(p), url: 'https://evil.example' }))).toEqual([expect.stringMatching(/^fields: .*url/)]);
    expect(failed(docToProposal({ ...fullDoc(p), paymentAmount: p.paymentAmount + 1 }))).toEqual([expect.stringMatching(/^fields: .*payment amount/)]);
  });
});

const entryOf = (t: Tally): TallySetEntry => {
  const { asOfHeight: _a, ...e } = t;
  return e;
};
/** A talliesSet page document (proved-read JSON). */
const setDoc = (page: number, asOfHeight: number, tallies: Tally[]): Record<string, unknown> => {
  const f = tallySetFields(tallies.map(entryOf));
  return { $id: 'GiCkEzSnk6SCCbXgjCnPYtvviYiRS5Vnbu7AcpAMUPFE', page, asOfHeight, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, base64.encode(v!)])) };
};
const tallyDoc = (t: Tally) => ({ ...t, govHash: hexToB64(t.govHash), voteSetHash: hexToB64(t.voteSetHash) });

describe('talliesSet documents', () => {
  it('decode to one Tally per entry at the page height', () => {
    const ts = [...snap.tallies.values()].slice(0, 6);
    const set = docToTallySet(setDoc(0, 2_560_400, ts));
    expect(set.page).toBe(0);
    expect(set.tallies).toHaveLength(6);
    for (const t of ts) expect(set.tallies.find((x) => x.govHash === t.govHash)).toEqual({ ...t, asOfHeight: 2_560_400 });
  });

  it('throw on bytes that are not a set (the reader then has no tally for those proposals)', () => {
    const doc = setDoc(0, 1, [...snap.tallies.values()].slice(0, 2));
    const b = base64.decode(doc.b0 as string);
    expect(() => docToTallySet({ ...doc, b0: base64.encode(b.slice(0, -1)) })).toThrow(/bytes for 2 entries/);
    b[0] = 9;
    expect(() => docToTallySet({ ...doc, b0: base64.encode(b) })).toThrow(/version 9/);
  });

  it('a 161-entry set spans b0..b2', () => {
    const t = [...snap.tallies.values()][0]!;
    const many = Array.from({ length: 161 }, (_, i) => ({ ...t, govHash: i.toString(16).padStart(64, '0') }));
    const [b0, b1, b2] = splitTallySetStream(encodeTallySetStream(many.map(entryOf)));
    const set = docToTallySet({ page: 0, asOfHeight: 5, b0: base64.encode(b0!), b1: base64.encode(b1!), b2: base64.encode(b2!) });
    expect(set.tallies).toHaveLength(161);
  });
});

describe('tallies(): packed set first, per-proposal documents as the fallback', () => {
  const source = () => liveSource(profileRegistry('testnet'));
  let a: Tally, b: Tally, c: Tally;
  beforeEach(() => {
    [a, b, c] = [...snap.tallies.values()] as [Tally, Tally, Tally];
    platform.types = new Set(['proposal', 'tally', 'talliesSet', 'cycle', 'claimAttestation']);
    platform.docs.clear();
    platform.queries.length = 0;
  });

  it('active proposals come from the packed set; an ended one from its final per-proposal tally', async () => {
    platform.docs.set('talliesSet', [setDoc(0, 900, [a, b])]);
    platform.docs.set('tally', [tallyDoc({ ...c, asOfHeight: 500, rank: 0, inNextBudget: false })]);
    const out = await source().tallies([a.govHash, b.govHash, c.govHash]);
    expect(out.get(a.govHash)!.value).toEqual({ ...a, asOfHeight: 900 });
    expect(out.get(a.govHash)!.prov).toMatchObject({ kind: 'proof', detail: expect.stringContaining('packed tally set page 0') });
    expect(out.get(c.govHash)!.value.asOfHeight).toBe(500);
    expect(out.get(c.govHash)!.prov.detail).not.toContain('packed');
  });

  it('whichever is newer wins; the packed entry on a tie (testnet: per-proposal documents from before the update)', async () => {
    platform.docs.set('talliesSet', [setDoc(0, 900, [a, b])]);
    platform.docs.set('tally', [tallyDoc({ ...a, asOfHeight: 950, yesWeighted: a.yesWeighted + 4 }), tallyDoc({ ...b, asOfHeight: 900, yesWeighted: 1 })]);
    const out = await source().tallies([a.govHash, b.govHash]);
    expect(out.get(a.govHash)!.value).toMatchObject({ asOfHeight: 950, yesWeighted: a.yesWeighted + 4 });
    expect(out.get(b.govHash)!.value).toMatchObject({ asOfHeight: 900, yesWeighted: b.yesWeighted });
  });

  it('on a tie a final per-proposal tally (rank 0, not in the next budget) wins over the entry the set has not dropped yet', async () => {
    platform.docs.set('talliesSet', [setDoc(0, 900, [{ ...a, rank: 3, inNextBudget: true }])]);
    platform.docs.set('tally', [tallyDoc({ ...a, asOfHeight: 900, rank: 0, inNextBudget: false })]);
    expect((await source().tallies([a.govHash])).get(a.govHash)!.value).toMatchObject({ rank: 0, inNextBudget: false });
  });

  it('only the asked proposals are returned; a page that does not decode contributes nothing', async () => {
    const broken = setDoc(1, 900, [c]);
    platform.docs.set('talliesSet', [setDoc(0, 900, [a, b]), { ...broken, b0: base64.encode(base64.decode(broken.b0 as string).slice(1)) }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await source().tallies([a.govHash, c.govHash]);
    expect([...out.keys()]).toEqual([a.govHash]);
  });

  it('a contract without talliesSet (older testnet) is read through per-proposal tallies only, without a talliesSet query', async () => {
    platform.types = new Set(['proposal', 'tally', 'cycle', 'claimAttestation']);
    platform.docs.set('tally', [tallyDoc(a)]);
    const out = await source().tallies([a.govHash]);
    expect(out.get(a.govHash)!.value).toEqual(a);
    expect(platform.queries).toEqual(['tally']);
  });
});
