// Tamper cases from the QA defect ledger (verification group): each pins a way a lying node or bridge could get a "verified" claim,
// or a mislabelled verdict, to what the page may actually claim. The Playwright suite (e2e/tamper.spec.ts) replays the same
// scenarios through the real worker and UI.
import { createDapi, GrpcError, type AnchoredChain, type Dapi } from '@govhub/dapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { lookupCollateral, secondOpinion } from '../data/dapi.ts';
import { FixtureBridge, loadFixtures, type FixtureSnapshot } from '../data/fixtures.ts';
import { createSource } from '../data/repo.ts';
import { profileRegistry } from '../config/registry.ts';
import type { Proposal, Tally } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import { aggregate, collateralComponent, fundingComponent, votesComponent, type ComponentState } from './aggregate.ts';
import { MAX_SUPERBLOCK_READS, payments, type SuperblockCache, type SuperblockCoinbase } from './chain.ts';
import { verdictFailure, verifyCollateral, type TxLookup } from './collateral.ts';
import { paymentsFact } from './facts.ts';
import type { VotesDone } from './protocol.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET, voteVerdict } from './verdict.ts';
import { verifyVotes } from './votes.ts';

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
  await installRecordedDapi();
});
const byName = (n: string): Proposal => snap.proposals.find((p) => p.name === n)!;
const recorded = (txid: string): Promise<TxLookup> => lookupCollateral(createDapi({ network: 'mainnet', nodes: [RECORDED_NODE] }), txid, { verify: false });
const stepOf = (v: ReturnType<typeof verifyCollateral>, id: string) => v.steps.find((s) => s.id === id);
/** Anchored in the verified chain and final: the only collateral path that may be proven. */
const anchoredTx = (tx: TxLookup, weak: string | null = null): TxLookup => ({
  ...tx, confirmations: 760, chainLocked: 'verified',
  proof: {
    merkle: true, blockHash: 'verified', notes: [],
    anchor: { tip: tx.height + 999, confirmations: 1000, chainLockHeight: tx.height + 998, weak, trust: 'proof-of-work' },
    chainLock: { height: tx.height + 998, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 999 },
  },
});

describe('D-003: node-claimed confirmations and a second node\'s NOT_FOUND never yield verified', () => {
  /** A client whose first node claims the transaction (1,000 confirmations, ChainLocked) and whose second node answers `second`. */
  const twoNodes = (tx: TxLookup, second: () => Promise<unknown>) =>
    ({
      call: vi.fn(async (fn: (core: unknown) => Promise<unknown>) => ({
        value: await fn({ getTransaction: async () => ({ raw: tx.raw, blockHash: 'cc'.repeat(32), height: tx.height, confirmations: 1000, isChainLocked: true, isInstantLocked: false }) }),
        node: 'a:443',
      })),
      pool: { pick: () => ['b:443'], charge: () => {} },
      core: () => ({ getTransaction: second }),
    }) as unknown as Dapi;

  it('a second node answering NOT_FOUND is a contradiction (crosscheck fails), not a missing answer', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const lookup = await lookupCollateral(twoNodes(tx, () => Promise.reject(new GrpcError(5, 'Transaction not found'))), p.collateralTxid, { verify: false });
    expect(lookup.second).toEqual({ node: 'b:443', height: 0, sameBytes: false, notFound: true });
    const v = verifyCollateral(p, lookup, 'mainnet');
    // a node's word against another's: drawn as "reported", never as a mismatch of the proposal
    expect(stepOf(v, 'crosscheck')).toMatchObject({ status: 'fail', basis: 'reported' });
    expect(stepOf(v, 'crosscheck')!.detail).toContain('NOT_FOUND');
    expect(v.ok).toBe(false);
    const c = collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight });
    expect(c.status).toBe('error');
    // a contradiction between two nodes says nothing about the proposal: it is never hidden as failed either
    expect(c.status).not.toBe('failed');
  });

  it('a second node that cannot be reached is no answer (warn), and the claimed confirmations stay "reported"', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const lookup = await lookupCollateral(twoNodes(tx, () => Promise.reject(new GrpcError(14, 'unavailable', { network: true }))), p.collateralTxid, { verify: false });
    expect(lookup.second).toBeNull();
    const v = verifyCollateral(p, lookup, 'mainnet');
    expect(stepOf(v, 'crosscheck')!.status).toBe('warn');
    expect(stepOf(v, 'confirmations')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
  });

  it('secondOpinion reports which node said NOT_FOUND', async () => {
    const dapi = { pool: { pick: () => ['z:443'], charge: () => {} }, core: () => ({ getTransaction: () => Promise.reject(new GrpcError(5, 'nope')) }) } as unknown as Dapi;
    expect(await secondOpinion(dapi, 'ab'.repeat(32), { node: 'a:443', raw: new Uint8Array(1) })).toMatchObject({ node: 'z:443', notFound: true });
  });
});

describe('D-009: on proof of work that protects nothing (testnet), the row text never says "verified"', () => {
  it('block, ChainLock, confirmations and height say "checked", and carry "not secure"', async () => {
    const p = byName('OrchardPay');
    const v = verifyCollateral(p, anchoredTx(await recorded(p.collateralTxid), 'testnet difficulty is too low'), 'testnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) {
      const s = stepOf(v, id)!;
      expect(s.basis, id).toBe('reported');
      expect(`${s.detail} ${s.more ?? ''}`, id).not.toMatch(/verified in this browser|BLS-verified|verified block|verified tip|verified headers/);
      expect(s.more, id).toContain('not secure');
    }
    expect(stepOf(v, 'block')!.detail).toContain('checked in this browser');
    expect(collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
  });
});

describe('D-010: the fallback ChainLock (an SML 2 of 3 nodes agree on) is reported on every network', () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    it(network, async () => {
      const p = byName('OrchardPay');
      const tx = await recorded(p.collateralTxid);
      const fallback: TxLookup = { ...anchoredTx(tx), proof: { ...anchoredTx(tx).proof, anchor: null } };
      const v = verifyCollateral(p, fallback, network);
      for (const id of ['block', 'confirmations', 'chainlock', 'height']) expect(stepOf(v, id)!.basis, id).toBe('reported');
      expect(v.steps.map((s) => s.detail).join(' ')).not.toMatch(/BLS-verified|final:/);
      expect(v.chain!.provenConfirmations).toBeNull();
      expect(collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
    });
  }
});

describe('D-011: a collateral height mismatch is a failure', () => {
  it('proven chain: the published height fails; no step shows the contradicted height as ok', async () => {
    const p = byName('OrchardPay');
    const wrong = { ...p, collateralHeight: p.collateralHeight - 7 };
    const v = verifyCollateral(wrong, anchoredTx(await recorded(p.collateralTxid)), 'mainnet');
    expect(stepOf(v, 'height')).toMatchObject({ status: 'fail', basis: 'verified' });
    expect(stepOf(v, 'height')!.detail).toContain(`published as block ${(wrong.collateralHeight).toLocaleString('en-US')}`);
    expect(v.ok).toBe(false);
    const c = collateralComponent({ verdict: v, error: null, publishedHeight: wrong.collateralHeight });
    expect(c.status).toBe('failed');
    expect(aggregate([{ id: 'content', state: { status: 'proven', summary: '' } }, { id: 'collateral', state: c }]).level).toBe('failed');
    // ...and the lists treat it like any proven failure (hidden, banner); one only a node contradicts is not
    expect(verdictFailure(v)).toContain('Collateral height');
    expect(verdictFailure(verifyCollateral(wrong, await recorded(p.collateralTxid), 'mainnet'))).toBeNull();
  });
});

describe('D-007 / D-002: a tampered tally or vote set reads as a mismatch, never as verified', () => {
  const bridge = new FixtureBridge();
  let p: Proposal;
  let tally: Tally;
  let base: Parameters<typeof verifyVotes>[0];
  beforeAll(async () => {
    p = byName('dash-intents');
    tally = snap.tallies.get(p.govHash)!;
    const votes = (await bridge.votes(p.govHash, { height: tally.asOfHeight })).votes;
    const mns = (await bridge.mnlist(tally.asOfHeight)).masternodes;
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: m.type === 'evo' ? 1 : 0, typeProven: true }]));
    const proReg = new Map(mns.map((m) => [m.proTxHash.toLowerCase(), { type: m.type === 'evo' ? 1 : 0, collateral: { txid: m.collateralTxid, index: m.collateralIndex } }]));
    base = { govHash: p.govHash, votes, masternodes: mns, network: 'mainnet', now: snap.now, targets: [{ name: PLATFORM_TARGET, tally }], sml, proReg };
  }, 30_000);
  const done = (targets: Parameters<typeof verifyVotes>[0]['targets'], votes = base.votes, asOf = tally.asOfHeight): VotesDone => ({
    id: 1, kind: 'votes', bridge: 'fixture',
    runs: [{ result: verifyVotes({ ...base, votes, targets }), votesAsOf: asOf, mnlistHeight: asOf, listMatches: null }],
    sml: { height: 1, blockHash: 'x', node: 'n', validWeighted: 1, weak: null },
  });
  const comp = (d: VotesDone, shown: { name: string; tally: Tally } = { name: PLATFORM_TARGET, tally }) =>
    votesComponent({ shown, talliesLoading: false, bridge: true, result: d, error: null });

  it('a tally number changed by 100 (same block): mismatch, with the field named; never "proven"', () => {
    const tampered = { ...tally, yesWeighted: tally.yesWeighted + 100 };
    const d = done([{ name: PLATFORM_TARGET, tally: tampered }]);
    const c = comp(d, { name: PLATFORM_TARGET, tally: tampered });
    expect(c).toMatchObject({ status: 'error', mismatch: true });
    expect(c.status === 'error' && c.reason).toMatch(/^Mismatch: .*Yes \(weighted\)/);
    expect(voteVerdict(d.runs).level).toBe('mismatch');
  });

  it('the set "in force" at the tally\'s height (the bridge\'s newest record below it, asked for that height) is compared: a tamper there is a mismatch', () => {
    // the bridge stores a tally record only when it changes: asked for block H it serves the record of block H - 8, the set in force at H
    const tampered = { ...tally, yesWeighted: tally.yesWeighted + 100 };
    const run = (asked: number | null): VotesDone => ({
      ...done([]),
      runs: [{ result: verifyVotes({ ...base, targets: [{ name: PLATFORM_TARGET, tally: tampered }] }), votesAsOf: tally.asOfHeight - 8, asked, mnlistHeight: tally.asOfHeight - 8, listMatches: null }],
    });
    expect(comp(run(tally.asOfHeight), { name: PLATFORM_TARGET, tally: tampered })).toMatchObject({ status: 'error', mismatch: true });
    expect(voteVerdict(run(tally.asOfHeight).runs).level).toBe('mismatch');
    // the live set the bridge fell back to (it no longer held that height's set) says nothing about that tally
    const fellBack = comp(run(null), { name: PLATFORM_TARGET, tally: tampered });
    expect(fellBack.status).toBe('reported');
    expect(voteVerdict(run(null).runs).level).toBe('different-height');
  });

  it('a tampered vote (outcome flipped: its signature fails) or dropped votes: mismatch', () => {
    const flipped = base.votes.map((v, i) => (i === 0 ? { ...v, outcome: v.outcome === 1 ? 2 : 1 } : v));
    expect(comp(done([{ name: PLATFORM_TARGET, tally }], flipped))).toMatchObject({ status: 'error', mismatch: true });
    const dropped = base.votes.filter((v) => v.outcome !== 2).concat(base.votes.filter((v) => v.outcome === 2).slice(5));
    expect(comp(done([{ name: PLATFORM_TARGET, tally }], dropped))).toMatchObject({ status: 'error', mismatch: true });
  });

  it('D-002: a bridge that withholds votes and serves a live tally matching them is not verified against the Platform tally', () => {
    const dropped = base.votes.filter((v) => v.outcome !== 2).concat(base.votes.filter((v) => v.outcome === 2).slice(5));
    const consistent = verifyVotes({ ...base, votes: dropped, targets: [] });
    const lie: Tally = { ...tally, asOfHeight: tally.asOfHeight + 20, yesWeighted: consistent.weighted.yes, noWeighted: consistent.weighted.no, abstainWeighted: consistent.weighted.abstain, yesCount: consistent.unweighted.yes, noCount: consistent.unweighted.no, abstainCount: consistent.unweighted.abstain, voteSetHash: consistent.voteSetHash };
    // the bridge's live run matches its own tally; the Platform tally's run (the votes it served for that block) does not
    const d: VotesDone = {
      ...done([]),
      runs: [
        { result: verifyVotes({ ...base, votes: dropped, targets: [{ name: PLATFORM_TARGET, tally }] }), votesAsOf: tally.asOfHeight, mnlistHeight: tally.asOfHeight, listMatches: null },
        { result: verifyVotes({ ...base, votes: dropped, targets: [{ name: BRIDGE_TARGET, tally: lie }] }), votesAsOf: lie.asOfHeight, mnlistHeight: lie.asOfHeight, listMatches: null },
      ],
    };
    expect(d.runs[1]!.result.targets[0]!.matches).toBe(true);
    const c = comp(d);
    expect(c.status).not.toBe('proven');
    expect(c).toMatchObject({ status: 'error', mismatch: true });
    // shown the bridge's own (matching) live tally instead, it is still not the proven record
    expect(comp(d, { name: BRIDGE_TARGET, tally: lie }).status).not.toBe('proven');
  });
});

describe('D-013: payments read only the proposal\'s window, at most MAX_SUPERBLOCK_READS blocks per run, cached', () => {
  // testnet: a superblock every 24 blocks; 13,300 of them between the collateral and the tip (the "testing" proposal's case)
  const LO = 1_258_497, TIP = 1_578_000, T0 = 1_749_337_898, SPACING = 150;
  const timeOf = (h: number) => T0 + (h - LO) * SPACING;
  const a = { tip: TIP, chain: { lo: LO, hashHexAt: (h: number) => h.toString(16).padStart(64, '0') } } as unknown as AnchoredChain;
  const address = 'yNPbcFfabtNmmxKdGwhHomdYfVs6gikbPf';
  const amount = 5e8;
  const blocks = () => {
    const asked: number[] = [];
    const dapi = {
      getAnchoredBlock: vi.fn(async (_a: unknown, h: number) => {
        asked.push(h);
        return { block: { header: { time: timeOf(h) }, txs: [{ outputs: [{ value: 1n, script: new Uint8Array([0x6a]) }] }] }, raw: new Uint8Array(0), node: 'n' };
      }),
    } as unknown as Dapi;
    return { dapi, asked };
  };
  const memoryCache = (): SuperblockCache & { m: Map<string, SuperblockCoinbase> } => {
    const m = new Map<string, SuperblockCoinbase>();
    return { m, get: async (h) => m.get(`testnet:${h}`), put: async (h, v) => void m.set(`testnet:${h}`, v) };
  };

  it('a proposal whose window is a fraction of the range reads O(log n) blocks outside it, and nothing before its start', async () => {
    const { dapi, asked } = blocks();
    // a 2-day window in the middle: 48 superblocks
    const start = timeOf(1_400_000), end = start + 2 * 86_400;
    const p = { paymentAddress: address, paymentAmount: amount, startEpoch: start, endEpoch: end };
    const r = await payments(dapi, a, p, [], 'testnet', LO, timeOf(TIP));
    expect(asked.length).toBeLessThan(48 + 2 * 24 + 2 * 15);
    expect(r.skipped ?? 0).toBe(0);
    expect(r.checked.length).toBeGreaterThanOrEqual(48);
    // only binary-search probes land outside the window (with its day of slack)
    const outside = asked.filter((h) => timeOf(h) < start - 2 * 3600 - 86_400 || timeOf(h) > end + 2 * 3600 + 86_400);
    expect(outside.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(13_300)) + 2);
  });

  it('a window of thousands of superblocks finishes in bounded reads, says how many are left, and the next run continues from the cache', async () => {
    const p = { paymentAddress: address, paymentAmount: amount, startEpoch: T0, endEpoch: T0 + 600 * 86_400 };
    const cache = memoryCache();
    const first = blocks();
    const r1 = await payments(first.dapi, a, p, [], 'testnet', LO, timeOf(TIP), { cache });
    // the window reads, plus the binary search for its edges
    const bound = MAX_SUPERBLOCK_READS + 2 * Math.ceil(Math.log2(13_300)) + 2;
    expect(first.asked.length).toBeLessThanOrEqual(bound);
    expect(r1.skipped).toBeGreaterThan(10_000);
    expect(paymentsFact({ payments: r1 } as never)!.made.prov.kind).toBe('reported');
    expect(paymentsFact({ payments: r1 } as never)!.made.text).toContain('or more');
    const second = blocks();
    const r2 = await payments(second.dapi, a, p, [], 'testnet', LO, timeOf(TIP), { cache });
    expect(second.asked.length).toBeLessThanOrEqual(bound);
    // nothing read twice: the second run fetched only blocks the first did not
    expect(second.asked.filter((h) => first.asked.includes(h))).toEqual([]);
    expect(r2.skipped).toBeLessThan(r1.skipped!);
    expect(r2.checked.length).toBeGreaterThan(r1.checked.length);
    // a cache entry for another block hash (a reorg, or a forged entry) is not used
    const h = second.asked[0]!;
    cache.m.set(`testnet:${h}`, { ...cache.m.get(`testnet:${h}`)!, blockHash: 'ff'.repeat(32) });
    const third = blocks();
    await payments(third.dapi, a, p, [], 'testnet', LO, timeOf(TIP), { cache });
    expect(third.asked).toContain(h);
  });

  it('a superblock that cannot be read is reported unread, and the count is only a lower bound', async () => {
    const { dapi, asked } = blocks();
    const failing = 1_400_016; // a superblock height (multiple of 24)
    const real = dapi.getAnchoredBlock;
    (dapi as { getAnchoredBlock: unknown }).getAnchoredBlock = vi.fn(async (x: unknown, h: number) => (h === failing ? Promise.reject(new Error('unreadable')) : real.call(dapi, x as never, h)));
    const start = timeOf(1_400_000), end = start + 2 * 86_400;
    const r = await payments(dapi, a, { paymentAddress: address, paymentAmount: amount, startEpoch: start, endEpoch: end }, [], 'testnet', LO, timeOf(TIP));
    expect(r.unread.map((u) => u.height)).toContain(failing);
    expect(paymentsFact({ payments: r } as never)!.made.prov.kind).toBe('reported');
    expect(asked.length).toBeGreaterThan(0);
  });

  it('payments read from a chain only weak proof of work protects are not proven, whatever the chain facts\' anchor', () => {
    const proven: ComponentState = { status: 'proven', summary: '' };
    const payments = { checked: [1], paid: [], ambiguous: [], unread: [], remainingEstimate: 0, othersComplete: true, anchor: { tip: 1, weak: 'testnet difficulty is too low' } };
    const report = { payments, threshold: { value: 1 }, anchor: { weak: null } } as never;
    expect(fundingComponent({ proposal: { govHash: 'x', endEpoch: 0 }, nowS: 10, chain: proven, votes: proven, report, netYes: 5, ranking: null }).status).toBe('reported');
    expect(paymentsFact(report)!.made.prov.kind).toBe('reported');
  });

  it('left superblocks keep the funding check from "proven"', () => {
    const proven: ComponentState = { status: 'proven', summary: '' };
    const report = { payments: { checked: [1], paid: [], ambiguous: [], unread: [], remainingEstimate: 0, othersComplete: true, skipped: 12 }, threshold: { value: 1 } } as never;
    const f = fundingComponent({ proposal: { govHash: 'x', endEpoch: 0 }, nowS: 10, chain: proven, votes: proven, report, netYes: 5, ranking: null });
    expect(f.status).toBe('reported');
    // and while the payments are still being read the check is pending, not settled
    const pending = fundingComponent({ proposal: { govHash: 'x', endEpoch: 0 }, nowS: 10, chain: proven, votes: proven, report: { payments: null, threshold: { value: 1 } } as never, payments: { pending: true, error: null }, netYes: 5, ranking: null });
    expect(pending.status).toBe('pending');
  });
});

describe('D-014: governance parameters are consensus constants, never a bridge\'s report', () => {
  it('a bridge reporting other getgovernanceinfo values does not change them', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ network: 'testnet', governance: { superblockcycle: 8000, superblockmaturitywindow: 100, governanceminquorum: 500 } }), { status: 200 }),
    );
    for (const id of ['testnet', 'dev'] as const) {
      const r = profileRegistry(id);
      const s = createSource('live', r);
      expect((await s.params()).value).toEqual(GOV_PARAMS[r.coreNetwork]);
    }
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/cycle'))).toEqual([]);
    fetchSpy.mockRestore();
  });
});
