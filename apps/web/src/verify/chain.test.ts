// Chain facts from recorded mainnet data (packages/dapi/test/fixtures/anchor-mainnet.json.gz: the full proven SML at 2,560,773 and
// superblock 2,558,864), with the network calls (ProRegTx lookups, block fetches) stubbed.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeCbor, parseBlock, parseSmlDecoded, proveSml, type AnchoredChain, type Dapi } from '@govhub/dapi';
import { parseProposalData } from '@govhub/verify';
import { payments, scheduleAndBudget, threshold } from './chain.ts';
import { budgetFact, deadlineFact, fundedFact, paymentsFact, thresholdFact } from './facts.ts';
import { rankRecounts, type RecountedProposal } from './ranking.ts';

const fx = JSON.parse(gunzipSync(readFileSync(new URL('../../../../packages/dapi/test/fixtures/anchor-mainnet.json.gz', import.meta.url))).toString('utf8'));
const smlDecoded = decodeCbor(new Uint8Array(Buffer.from(fx.smlB64, 'base64')));
const sbBlock = new Uint8Array(Buffer.from(fx.superblock.blockB64, 'base64'));
const proposals = JSON.parse(readFileSync(new URL('../../../../packages/verify/test/fixtures/mainnet-proposals.json', import.meta.url), 'utf8')).proposals as Array<{ dataHex: string }>;
const TIP = 2_560_773;

/** Just the parts of an anchored chain the chain facts read. */
const anchor = {
  tip: TIP,
  chain: { lo: 2_558_834 },
  sml: { ...parseSmlDecoded(smlDecoded), proof: proveSml(smlDecoded as Record<string, unknown>), node: 'n:443' },
} as unknown as AnchoredChain;
const nopCache = { load: async () => new Map(), save: async () => {} };

describe('funding threshold from the proven masternode list', () => {
  it('counts version-2+ types from the list and proves the 1,048 older valid entries by their ProRegTxs: 332, as getgovernanceinfo says', async () => {
    const asked: string[][] = [];
    const dapi = { getProRegInfo: vi.fn(async (hs: string[]) => { asked.push(hs); return new Map(hs.map((h) => [h, { type: 0, collateral: { txid: h, index: 1 } }])); }) } as unknown as Dapi;
    const t = await threshold(dapi, anchor, 'mainnet', nopCache, () => {});
    expect(asked[0]!.length).toBe(1_048);
    expect(t).toMatchObject({ status: 'verified', validWeighted: 3_324, value: 332, height: TIP, legacy: { valid: 1_048, proven: 1_048 } });
  });

  it('a registration that turns out to be an evonode moves the count; a failed lookup is "reported", never "verified"', async () => {
    const evo = { getProRegInfo: async (hs: string[]) => new Map(hs.map((h, i) => [h, { type: i < 10 ? 1 : 0, collateral: { txid: h, index: 1 } }])) } as unknown as Dapi;
    expect((await threshold(evo, anchor, 'mainnet', nopCache, () => {})).validWeighted).toBe(3_324 + 30);
    const down = { getProRegInfo: async () => { throw new Error('all nodes failed'); } } as unknown as Dapi;
    const t = await threshold(down, anchor, 'mainnet', nopCache, () => {});
    expect(t.status).toBe('reported');
    expect(t.reason).toContain('could not be proven');
    expect(thresholdFact({ threshold: t } as never, null)!.prov.kind).toBe('reported');
  });
});

describe('payments read from superblock coinbases of the verified chain', () => {
  const dcg = proposals.map((p) => parseProposalData(p.dataHex).fields!).find((f) => f.name === 'DCG-Operations-Aug-Nov-26')!;
  const prop = { collateralHeight: 2_540_000, paymentAddress: dcg.paymentAddress, paymentAmount: Math.round(dcg.paymentAmount * 1e8), startEpoch: dcg.startEpoch, endEpoch: dcg.endEpoch };
  const dapi = (blocks: Record<number, Uint8Array>) => ({ getAnchoredBlock: vi.fn(async (_a: unknown, h: number) => { const b = blocks[h]; if (!b) throw new Error('unreadable'); return { block: parseBlock(b), raw: b, node: 'n' }; }) }) as unknown as Dapi;

  it('finds the payment in superblock 2,558,864 and estimates what is left', async () => {
    const a = { ...anchor, chain: { lo: 2_540_000 } } as unknown as AnchoredChain;
    const p = await payments(dapi({ 2_558_864: sbBlock, 2_542_248: sbBlock }), a, prop, [], 'mainnet', 2_545_000, fx.now);
    expect(p.checked).toEqual([2_558_864]);
    expect(p.paid).toEqual([{ height: 2_558_864, output: expect.any(Number), time: parseBlock(sbBlock).header.time }]);
    const f = paymentsFact({ payments: p } as never)!;
    expect(f.made).toMatchObject({ text: '1', prov: { kind: 'verified' } });
    expect(f.remaining.prov.kind).toBe('reported'); // the future is an estimate
  });

  it('a payment outside the window is not this proposal\'s, and one another listed proposal could account for is ambiguous', async () => {
    const a = { ...anchor, chain: { lo: 2_540_000 } } as unknown as AnchoredChain;
    const sbTime = parseBlock(sbBlock).header.time;
    const late = await payments(dapi({ 2_558_864: sbBlock }), a, { ...prop, startEpoch: sbTime + 3 * 86_400, endEpoch: sbTime + 90 * 86_400 }, [], 'mainnet', 2_545_000, fx.now);
    expect(late).toMatchObject({ checked: [], paid: [] });
    const twin = { ...prop, govHash: 'ee'.repeat(32) };
    const amb = await payments(dapi({ 2_558_864: sbBlock }), a, prop, [twin], 'mainnet', 2_545_000, fx.now);
    expect(amb.paid).toEqual([]);
    expect(amb.ambiguous).toEqual([{ height: 2_558_864, with: twin.govHash }]);
    const f = paymentsFact({ payments: amb } as never)!;
    expect(f.made).toMatchObject({ text: '0 or more', prov: { kind: 'reported' } });
  });

  it('an unreadable superblock makes the count a lower bound, and another address is not a payment', async () => {
    const a = { ...anchor, chain: { lo: 2_540_000 } } as unknown as AnchoredChain;
    const p = await payments(dapi({}), a, prop, [], 'mainnet', 2_545_000, fx.now);
    expect(p.unread.map((u) => u.height)).toEqual([2_558_864]);
    expect(paymentsFact({ payments: p } as never)!.made).toMatchObject({ text: '0 or more', prov: { kind: 'reported' } });
    const other = await payments(dapi({ 2_558_864: sbBlock }), a, { ...prop, paymentAmount: prop.paymentAmount + 1 }, [], 'mainnet', 2_545_000, fx.now);
    expect(other.paid).toEqual([]);
  });
});

describe('payments of an old proposal: superblocks below the contiguous run', () => {
  const dcg = proposals.map((p) => parseProposalData(p.dataHex).fields!).find((f) => f.name === 'DCG-Operations-Aug-Nov-26')!;
  const prop = { paymentAddress: dcg.paymentAddress, paymentAmount: Math.round(dcg.paymentAmount * 1e8), startEpoch: dcg.startEpoch, endEpoch: dcg.endEpoch };
  const hash = 'ab'.repeat(32);

  it('has each verified first and reads it through the anchor that covers it; one that cannot be reached is unread', async () => {
    // as in the worker: reaching further down from the ChainLock hands out a NEW anchor; the old one never covers more
    const a = { ...anchor, weak: null, chain: { lo: 2_560_000, hashHexAt: (h: number) => (h >= 2_560_000 ? hash : null) } } as unknown as AnchoredChain;
    const deeper = { ...anchor, weak: null, chain: { lo: 2_550_000, hashHexAt: (h: number) => (h >= 2_550_000 ? hash : null) } } as unknown as AnchoredChain;
    const reached: number[] = [];
    const reach = vi.fn(async (h: number) => { reached.push(h); return deeper; });
    const read: Array<[unknown, number]> = [];
    const dapi = { getAnchoredBlock: vi.fn(async (x: unknown, h: number) => { read.push([x, h]); return { block: parseBlock(sbBlock), raw: sbBlock, node: 'n' }; }) } as unknown as Dapi;
    const p = await payments(dapi, a, prop, [], 'mainnet', 2_545_000, fx.now, { reach });
    expect(reached).toEqual([2_558_864]); // below lo: reached before it is read, once
    expect(read).toEqual([[deeper, 2_558_864]]);
    expect(p.checked).toEqual([2_558_864]);
    expect(p.anchor).toEqual({ tip: TIP, weak: null });
    // the anchor that reached further fell back to weak proof of work (testnet, a proof source refusing): the result says so
    const weakDeeper = { ...deeper, weak: 'testnet difficulty is too low' } as unknown as AnchoredChain;
    const w = await payments(dapi, a, prop, [], 'testnet' as never, 2_545_000, fx.now, { reach: async () => weakDeeper });
    expect(w.anchor?.weak).toBe('testnet difficulty is too low');
    // a pinned block that disagrees with the verified chain fails the whole check, not one superblock
    const conflict = Object.assign(new Error('the pinned chain and the verified chain disagree'), { code: 'pin-conflict' });
    await expect(payments(dapi, a, prop, [], 'mainnet', 2_545_000, fx.now, { reach: async () => { throw conflict; } })).rejects.toThrow(/disagree/);
    // a superblock the pins cannot reach is reported unread (a lower bound), never read unverified
    const none = { ...anchor, chain: { lo: 2_560_000, hashHexAt: () => null } } as unknown as AnchoredChain;
    const fail = await payments(dapi, none, prop, [], 'mainnet', 2_545_000, fx.now, { reach: async () => { throw new Error('too old to verify here'); } });
    expect(fail.unread).toEqual([{ height: 2_558_864, error: 'too old to verify here' }]);
  });
});

describe('schedule, budget and their labels', () => {
  it('heights are consensus facts at the verified tip; times are estimates', () => {
    const sb = scheduleAndBudget(anchor, 'mainnet', fx.now);
    expect(sb.schedule).toMatchObject({ last: 2_558_864, next: 2_575_480, votingDeadline: 2_573_818, tip: TIP });
    expect(sb.budget).toEqual({ height: 2_575_480, limit: '682826378160' });
    const d = deadlineFact(sb as never, null, fx.now, undefined, null)!;
    expect(d.text).toMatch(/^block 2,573,818, in \d+ days \(estimated\)$/);
    expect(d.prov!.kind).toBe('verified');
    expect(budgetFact(sb as never, { superblockHeight: 2_575_480, budget: 682_826_378_160 } as never)).toEqual({ text: '6,828.2637816 DASH for superblock 2,575,480; the bridge reports the same', ok: true });
    expect(budgetFact(sb as never, { superblockHeight: 2_575_480, budget: 1 } as never).ok).toBe(false);
  });
});

describe('funding order (GetApprovedProposals order, greedy fill)', () => {
  const th = { status: 'verified' as const, value: 332, validWeighted: 3_324, height: TIP, legacy: { valid: 0, proven: 0 } };
  const budget = { height: 2_575_480, limit: String(1_000e8) };
  const sbTime = 1_800_000_000;
  const r = (name: string, absYes: number, amount: number, over: Partial<RecountedProposal> = {}): RecountedProposal => ({
    govHash: name.padEnd(64, '0'), name, absYes, amount: amount * 1e8, startEpoch: sbTime - 86_400 * 30, endEpoch: sbTime + 86_400 * 30, proven: true, ...over,
  });

  it('ranks by net yes, skips what does not fit or is outside its window, and is verified only when every input is', () => {
    const res = rankRecounts([r('a', 900, 600), r('b', 800, 500), r('c', 700, 300), r('d', 100, 1), r('e', 600, 50, { endEpoch: sbTime - 3 * 86_400 })], th, budget, sbTime);
    expect(res.entries.map((e) => [e.name, e.rank, e.funded])).toEqual([['a', 1, true], ['b', 2, false], ['c', 3, true], ['e', 4, false], ['d', null, false]]);
    expect(res.verified).toBe(true);
    expect(fundedFact(res, r('a', 0, 0).govHash)).toMatchObject({ text: 'Yes, in the next superblock (rank 1)', prov: { kind: 'verified' } });
    expect(fundedFact(res, r('b', 0, 0).govHash)!.text).toBe('Passing (rank 2), but not in the next superblock');
  });

  it('one unproven recount, an unproven threshold or a window edge near the superblock time makes it "reported"', () => {
    expect(rankRecounts([r('a', 900, 1, { proven: false, problem: '3 votes not proven' })], th, budget, sbTime).reasons[0]).toContain('3 votes not proven');
    expect(rankRecounts([r('a', 900, 1)], { ...th, status: 'reported', reason: 'x' }, budget, sbTime).verified).toBe(false);
    const edge = rankRecounts([r('a', 900, 1, { startEpoch: sbTime + 3600 })], th, budget, sbTime);
    expect(edge.verified).toBe(false);
    expect(fundedFact(edge, r('a', 0, 0).govHash)!.prov.kind).toBe('reported');
  });
});
