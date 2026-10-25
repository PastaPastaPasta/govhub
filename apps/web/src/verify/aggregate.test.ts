// The aggregate trust signal. A false "Verified" is the worst bug this app can have: every combination of check states is
// enumerated, and every known false-verified path (node-reported confirmations, the fallback ChainLock, a height mismatch, fixture
// data, a missing second node, testnet proof of work, bridge-only keys) is pinned to "not verified" on real verdicts.
import { createDapi } from '@govhub/dapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { lookupCollateral } from '../data/dapi.ts';
import { FixtureBridge, loadFixtures, type FixtureSnapshot } from '../data/fixtures.ts';
import type { Proposal, Tally } from '../data/types.ts';
import {
  aggregate, chainComponent, collateralComponent, contentComponent, fundingComponent, needsRanking, provenFunded, provenNetYes, REQUIRED, votesComponent,
  type CheckId, type Component, type ComponentState, type TrustLevel,
} from './aggregate.ts';
import type { ChainReport } from './chain.ts';
import { verifyCollateral, type TxLookup } from './collateral.ts';
import type { RankingDone, VotesDone } from './protocol.ts';
import type { RankingResult } from './ranking.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET } from './verdict.ts';
import { verifyVotes, type VoteCheckResult } from './votes.ts';

// ---- exhaustive aggregation ----------------------------------------------------------------------------------------------------

type S = ComponentState['status'] | 'missing';
const STATES: readonly S[] = ['pending', 'proven', 'reported', 'error', 'failed', 'missing'];
const stateOf = (s: Exclude<S, 'missing'>, id: string): ComponentState =>
  s === 'pending' ? { status: 'pending', note: `running ${id}` } : s === 'proven' ? { status: 'proven', summary: `${id} ok` } : { status: s, reason: `${id} ${s}` };

/** The rule, written independently of the implementation's control flow. */
function expected(states: readonly S[], demo: boolean): TrustLevel {
  if (demo) return 'demo';
  if (states.includes('failed')) return 'failed';
  if (states.includes('pending') || states.includes('missing')) return 'checking';
  if (states.includes('error')) return 'error';
  if (states.includes('reported')) return 'partial';
  return 'verified';
}

describe('aggregate: every combination of check states', () => {
  it(`all ${STATES.length ** REQUIRED.length * 2} combinations of ${REQUIRED.length} checks x demo map to the documented level`, () => {
    let verified = 0;
    let n = 0;
    const walk = (i: number, acc: S[]) => {
      if (i === REQUIRED.length) {
        for (const demo of [false, true]) {
          const cs: Component[] = acc.flatMap((s, j) => (s === 'missing' ? [] : [{ id: REQUIRED[j]!, state: stateOf(s, REQUIRED[j]!) }]));
          const a = aggregate(cs, { demo });
          const want = expected(acc, demo);
          expect(a.level, `${acc.join(',')} demo=${demo}`).toBe(want);
          // the iff: verified exactly when all five are present and proven, never in demo
          expect(a.level === 'verified').toBe(!demo && acc.every((s) => s === 'proven'));
          if (a.level === 'verified') {
            verified++;
            expect(a.reason).toBeNull();
          } else expect(a.reason, `${acc.join(',')}`).toBeTruthy();
          // the headline reason is the first component of the deciding status, in check order
          if (!demo && ['failed', 'error', 'partial'].includes(a.level)) {
            const status = a.level === 'partial' ? 'reported' : a.level;
            const j = acc.indexOf(status as S);
            expect(a.reason).toBe(`${REQUIRED[j]} ${status}`);
          }
          n++;
        }
        return;
      }
      for (const s of STATES) walk(i + 1, [...acc, s]);
    };
    walk(0, []);
    expect(n).toBe(STATES.length ** REQUIRED.length * 2);
    expect(verified).toBe(1);
  });

  it('a duplicated check, or a check outside the required set, never makes up for a missing one', () => {
    const proven = (id: CheckId): Component => ({ id, state: { status: 'proven', summary: 'ok' } });
    const four = REQUIRED.slice(0, 4).map(proven);
    expect(aggregate([...four, proven('content')]).level).toBe('checking');
    expect(aggregate(four).level).toBe('checking');
    expect(aggregate([...four, proven('funding'), proven('funding')]).level).toBe('checking');
    expect(aggregate([]).level).toBe('checking');
    expect(aggregate(REQUIRED.map(proven)).level).toBe('verified');
  });

  it('the order of components does not matter for the level', () => {
    const cs: Component[] = REQUIRED.map((id) => ({ id, state: { status: 'proven', summary: 'ok' } }));
    cs[2] = { id: 'chain', state: { status: 'reported', reason: 'weak' } };
    expect(aggregate(cs).level).toBe('partial');
    expect(aggregate([...cs].reverse()).level).toBe('partial');
  });
});

// ---- the per-check mappings, on real verdicts ------------------------------------------------------------------------------------

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
  await installRecordedDapi();
});
const byName = (n: string): Proposal => snap.proposals.find((p) => p.name === n)!;
const recorded = (txid: string): Promise<TxLookup> => lookupCollateral(createDapi({ network: 'mainnet', nodes: [RECORDED_NODE] }), txid, { verify: false });

/** A lookup anchored in the verified chain and covered by a verified ChainLock: the only path that may be proven. */
const anchoredTx = (tx: TxLookup, o: { final?: boolean; weak?: string | null; trust?: 'quorum-proof' | 'proof-of-work' } = {}): TxLookup => {
  const final = o.final ?? true;
  return {
    ...tx, confirmations: 760, chainLocked: final ? 'verified' : 'claimed',
    proof: {
      merkle: true, blockHash: 'verified', notes: [],
      anchor: { tip: tx.height + 999, confirmations: 1000, chainLockHeight: final ? tx.height + 998 : tx.height - 1, weak: o.weak ?? null, trust: o.trust ?? 'proof-of-work' },
      chainLock: final ? { height: tx.height + 998, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 999 } : null,
    },
  };
};

describe('collateral: only an anchored, final, height-matching collateral is proven', () => {
  const comp = (p: Proposal, tx: TxLookup | { error: string; notFound?: boolean }, network: 'mainnet' | 'testnet' = 'mainnet', publishedHeight = p.collateralHeight) =>
    collateralComponent({ verdict: verifyCollateral(p, tx, network), error: null, publishedHeight });

  it('anchored on mainnet proof of work, final, same height: proven', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    expect(comp(p, anchoredTx(tx)).status).toBe('proven');
  });

  it('anchored on testnet quorum-proven ChainLocks: proven', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    expect(comp(p, anchoredTx(tx, { trust: 'quorum-proof' }), 'testnet').status).toBe('proven');
  });

  it('node-reported confirmations and ChainLock (the recorded replay, ok === true): partly verified, never proven', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, tx, 'mainnet');
    expect(v.ok).toBe(true); // the verdict alone would say "ok"
    const c = collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight });
    expect(c.status).toBe('reported');
  });

  it('a missing second node (crosscheck warn): partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, second: null }, 'mainnet');
    expect(v.steps.find((s) => s.id === 'crosscheck')!.status).toBe('warn');
    expect(collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
    // and with the second node agreeing it is still only reported
    const agree = verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height, sameBytes: true } }, 'mainnet');
    expect(agree.ok).toBe(true);
    expect(collateralComponent({ verdict: agree, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
  });

  it('the fallback per-transaction ChainLock proof (verified basis on mainnet, but not anchored): partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const fallback: TxLookup = {
      ...tx, confirmations: 760, chainLocked: 'verified',
      proof: { merkle: true, blockHash: 'verified', chainLock: { height: tx.height + 758, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 759 }, anchor: null, notes: [] },
    };
    const v = verifyCollateral(p, fallback, 'mainnet');
    expect(v.ok).toBe(true);
    expect(v.steps.find((s) => s.id === 'chainlock')!.basis).toBe('verified'); // the step itself says verified...
    const c = collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight });
    expect(c.status).toBe('reported'); // ...the aggregate does not take it
    expect(c.status === 'reported' && c.reason).toContain("couldn't be traced to the chain");
  });

  it('a published collateral height that differs from the chain, or none at all: partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const wrong = { ...p, collateralHeight: p.collateralHeight + 1 };
    const v = verifyCollateral(wrong, anchoredTx(tx), 'mainnet');
    expect(v.ok).toBe(true); // a height difference is only a warning in the verdict
    const c = collateralComponent({ verdict: v, error: null, publishedHeight: wrong.collateralHeight });
    expect(c.status).toBe('reported');
    expect(c.status === 'reported' && c.reason).toContain('height');
    const none = { ...p, collateralHeight: 0 };
    expect(collateralComponent({ verdict: verifyCollateral(none, anchoredTx(tx), 'mainnet'), error: null, publishedHeight: 0 }).status).toBe('reported');
  });

  it('not final yet (the block is above the newest verified ChainLock): partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const c = comp(p, anchoredTx(tx, { final: false }));
    expect(c.status).toBe('reported');
    expect(c.status === 'reported' && c.reason).toContain('not final');
  });

  it('anchored on testnet proof of work (weak): partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const c = comp(p, anchoredTx(tx, { weak: 'testnet difficulty is too low' }), 'testnet');
    expect(c.status).toBe('reported');
    expect(c.status === 'reported' && c.reason).toContain('Testnet');
  });

  it('tampered content fails; an unreachable network is "couldn\'t verify"; still running is pending', async () => {
    const orig = byName('OrchardPay');
    const tx = await recorded(orig.collateralTxid);
    const tampered = { ...orig, dataHex: orig.dataHex.replace('4f7263686172645061', '4f7263686172645062') };
    expect(comp(tampered, anchoredTx(tx)).status).toBe('failed');
    // D-104: DAPI down or lying (an inconclusive lookup) is "couldn't verify", never "failed"
    expect(comp(orig, { error: 'timeout' }).status).toBe('error');
    expect(comp(orig, { error: 'all nodes failed: node a returned a transaction that does not hash to its txid' }).status).toBe('error');
    expect(comp(orig, { error: 'NOT_FOUND', notFound: true }).status).toBe('failed');
    expect(collateralComponent({ verdict: null, error: null, publishedHeight: 1 }).status).toBe('pending');
    expect(collateralComponent({ verdict: null, error: 'worker crashed', publishedHeight: 1 }).status).toBe('error');
  });

  it('a second node that disagrees is not proven (and not a definite failure either)', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height + 1, sameBytes: true } }, 'mainnet');
    expect(collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight }).status).toBe('error');
  });

  it('every collateral step present and ok, but one chain step only node-reported: partly verified', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, anchoredTx(tx), 'mainnet');
    const forged = { ...v, steps: v.steps.map((s) => (s.id === 'confirmations' ? { ...s, basis: 'reported' as const } : s)) };
    expect(collateralComponent({ verdict: forged, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
    const missing = { ...v, steps: v.steps.filter((s) => s.id !== 'chainlock') };
    expect(collateralComponent({ verdict: missing, error: null, publishedHeight: p.collateralHeight }).status).toBe('reported');
  });
});

describe('content', () => {
  it('maps the synchronous content check', () => {
    expect(contentComponent(null).status).toBe('proven');
    expect(contentComponent('Displayed fields: differ').status).toBe('failed');
  });
});

// ---- chain --------------------------------------------------------------------------------------------------------------------

const report = (over: { weak?: string | null; threshold?: Partial<ChainReport['threshold']>; payments?: Partial<NonNullable<ChainReport['payments']>> | null; trust?: 'quorum-proof' | 'proof-of-work' } = {}): ChainReport => ({
  network: 'mainnet',
  anchor: {
    weak: over.weak ?? null, lo: 2_500_000, tip: 2_560_000, checkpoint: 2_400_000,
    trust: over.trust === 'quorum-proof'
      ? ({ kind: 'quorum-proof', checkpoint: { height: 1_560_000 }, from: { height: 1_560_000 }, source: 'q', links: 3, proofBytes: 1000 } as unknown as ChainReport['anchor']['trust'])
      : ({ kind: 'proof-of-work', checkpoint: { height: 2_400_000 } } as unknown as ChainReport['anchor']['trust']),
    chainLock: { height: 2_560_000, blockHash: 'aa', quorumHash: 'bb', exact: true, time: 0 },
    sml: { height: 2_560_000, blockHash: 'cc', entries: 3000, quorums: 50 }, headers: { cached: 1, fetched: 1 }, ms: { total: 1 },
  },
  schedule: { next: 2_575_480, votingDeadline: 2_573_818, inMaturityWindow: false, tip: 2_560_000, nextEstTime: 0, deadlineEstTime: 0 } as ChainReport['schedule'],
  budget: { height: 2_575_480, limit: '682800000000' },
  threshold: { status: 'verified', value: 332, validWeighted: 3324, height: 2_560_000, legacy: { valid: 0, proven: 0 }, ...over.threshold },
  payments: over.payments === null ? null : { checked: [2_550_000], paid: [{ height: 2_550_000, output: 3, time: 0 }], ambiguous: [], unread: [], remainingEstimate: 1, othersComplete: true, ...over.payments },
});

describe('chain', () => {
  it('proven only when anchored on a protected chain with a proven threshold', () => {
    expect(chainComponent({ report: report(), error: null, unavailable: null }).status).toBe('proven');
    expect(chainComponent({ report: report({ trust: 'quorum-proof' }), error: null, unavailable: null }).status).toBe('proven');
    expect(chainComponent({ report: report({ weak: 'testnet' }), error: null, unavailable: null }).status).toBe('reported');
    expect(chainComponent({ report: report({ threshold: { status: 'reported', reason: '3 entries unread' } }), error: null, unavailable: null }).status).toBe('reported');
    expect(chainComponent({ report: null, error: null, unavailable: 'needs live DAPI nodes' }).status).toBe('reported');
    expect(chainComponent({ report: null, error: 'all nodes failed', unavailable: null }).status).toBe('error');
    expect(chainComponent({ report: null, error: null, unavailable: null }).status).toBe('pending');
  });
});

// ---- votes --------------------------------------------------------------------------------------------------------------------

describe('votes', () => {
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
  const done = (r: VoteCheckResult, o: { asOf?: number; weak?: string | null } = {}): VotesDone => ({
    id: 1, kind: 'votes', bridge: 'fixture', runs: [{ result: r, votesAsOf: o.asOf ?? tally.asOfHeight, mnlistHeight: tally.asOfHeight, listMatches: null }],
    sml: { height: 1, blockHash: 'x', node: 'n', validWeighted: 1, weak: o.weak ?? null },
  });
  const comp = (d: VotesDone | null, shownName = PLATFORM_TARGET, over: Partial<Parameters<typeof votesComponent>[0]> = {}) =>
    votesComponent({ shown: { name: shownName, tally }, talliesLoading: false, bridge: true, result: d, error: null, ...over });

  it('keys, types and collateral proven, the shown tally matches: proven', () => {
    expect(comp(done(verifyVotes(base))).status).toBe('proven');
    expect(provenNetYes(done(verifyVotes(base)), { name: PLATFORM_TARGET, tally })).toBe(95 - 64);
  });

  it('keys only as the bridge reports them (no proven list or no registrations): partly verified', () => {
    const c = comp(done(verifyVotes({ ...base, sml: null, proReg: null })));
    expect(c.status).toBe('reported');
    expect(c.status === 'reported' && c.reason).toContain('bridge lists');
    expect(comp(done(verifyVotes({ ...base, proReg: null }))).status).toBe('reported');
    expect(provenNetYes(done(verifyVotes({ ...base, sml: null })), { name: PLATFORM_TARGET, tally })).toBeNull();
  });

  it('testnet list protected only by proof of work: partly verified even with every key matching', () => {
    const r = verifyVotes(base);
    expect(r.keysFrom).toBe('sml');
    expect(comp(done(r, { weak: 'testnet' })).status).toBe('reported');
  });

  it('a voter missing from the proven list: partly verified', () => {
    const sml = new Map([...base.sml!].slice(1));
    expect(comp(done(verifyVotes({ ...base, sml }))).status).toBe('reported');
  });

  it('a forged vote makes the recount contradict the tally at the same block: couldn\'t verify (the source is wrong, not the proposal)', () => {
    const forged = base.votes.map((v, i) => (i === 3 ? { ...v, sig: base.votes[4]!.sig } : v));
    const c = comp(done(verifyVotes({ ...base, votes: forged })));
    expect(c.status).toBe('error');
    expect(aggregate([{ id: 'votes', state: c }]).level).not.toBe('failed');
  });

  it('D-101: a bridge that withholds votes and serves a matching live tally is not verified while the Platform tally disagrees', () => {
    // the bridge recounts to its own live tally (newer block); the Platform tally of an older block has other counts
    const r0 = verifyVotes(base);
    const live: Tally = { ...tally, asOfHeight: tally.asOfHeight + 7, yesWeighted: r0.weighted.yes, noWeighted: r0.weighted.no, abstainWeighted: r0.weighted.abstain, voteSetHash: r0.voteSetHash };
    const platform: Tally = { ...tally, yesWeighted: tally.yesWeighted + 40, voteSetHash: 'ff'.repeat(32) };
    const r = verifyVotes({ ...base, targets: [{ name: PLATFORM_TARGET, tally: platform }, { name: BRIDGE_TARGET, tally: live }] });
    const d = done(r, { asOf: live.asOfHeight });
    expect(r.targets.find((t) => t.name === BRIDGE_TARGET)!.matches).toBe(true);
    // the page shows the Platform tally: not comparable (other block), not matching: partly verified
    const onPlatform = votesComponent({ shown: { name: PLATFORM_TARGET, tally: platform }, talliesLoading: false, bridge: true, result: d, error: null });
    expect(onPlatform.status).toBe('reported');
    // even if the page showed the bridge's matching live tally, it is not the proven record
    expect(votesComponent({ shown: { name: BRIDGE_TARGET, tally: live }, talliesLoading: false, bridge: true, result: d, error: null }).status).toBe('reported');
    expect(provenNetYes(d, { name: BRIDGE_TARGET, tally: live })).toBeNull();
    // and a Platform tally at the very block of the served votes that differs is a contradiction
    const same = done(verifyVotes({ ...base, targets: [{ name: PLATFORM_TARGET, tally: platform }] }));
    expect(votesComponent({ shown: { name: PLATFORM_TARGET, tally: platform }, talliesLoading: false, bridge: true, result: same, error: null }).status).toBe('error');
  });

  it('a match on a different tally than the one shown is not a proof of the shown one', () => {
    expect(comp(done(verifyVotes(base)), BRIDGE_TARGET).status).toBe('reported');
    const shownNewer = votesComponent({ shown: { name: PLATFORM_TARGET, tally: { ...tally, asOfHeight: tally.asOfHeight + 5 } }, talliesLoading: false, bridge: true, result: done(verifyVotes(base)), error: null });
    expect(shownNewer.status).toBe('reported');
  });

  it('no tally, no bridge, still running, an error', () => {
    expect(votesComponent({ shown: null, talliesLoading: true, bridge: true, result: null, error: null }).status).toBe('pending');
    expect(votesComponent({ shown: null, talliesLoading: false, bridge: true, result: null, error: null }).status).toBe('reported');
    expect(comp(null, PLATFORM_TARGET, { bridge: false }).status).toBe('reported');
    expect(comp(null).status).toBe('pending');
    expect(comp(null, PLATFORM_TARGET, { error: 'HTTP 500' }).status).toBe('error');
  });
});

// ---- funding ------------------------------------------------------------------------------------------------------------------

describe('funding', () => {
  const P = { govHash: 'ab'.repeat(32), endEpoch: 2_000_000_000 };
  const proven: ComponentState = { status: 'proven', summary: 'ok' };
  const rk = (over: Partial<RankingResult> = {}, entry: Partial<RankingResult['entries'][number]> = {}): RankingDone => ({
    id: 1, kind: 'ranking',
    result: {
      entries: [{ govHash: P.govHash, name: 'p', absYes: 400, amount: 1, startEpoch: 0, endEpoch: P.endEpoch, proven: true, rank: 1, funded: true, timeSensitive: false, ...entry }],
      verified: true, reasons: [], threshold: report().threshold, budget: { height: 1, limit: '1' }, superblockTime: 0, allocated: 1, ...over,
    },
  });
  const f = (o: Partial<Parameters<typeof fundingComponent>[0]> = {}) =>
    fundingComponent({ proposal: P, nowS: 1_800_000_000, chain: proven, votes: proven, report: report(), netYes: 400, ranking: { result: rk(), error: null }, ...o });

  it('passing and active: proven only with a fully proven, timing-independent funding order that includes it', () => {
    expect(f().status).toBe('proven');
    expect(f({ ranking: { result: rk({ verified: false, reasons: ['1 of 29 recounts are not fully proven'] }), error: null } }).status).toBe('reported');
    expect(f({ ranking: { result: rk({}, { timeSensitive: true }), error: null } }).status).toBe('reported');
    expect(f({ ranking: { result: rk({}, { govHash: 'cd'.repeat(32) }), error: null } }).status).toBe('reported');
    expect(f({ ranking: null }).status).toBe('pending');
    expect(f({ ranking: { result: null, error: null } }).status).toBe('pending');
    expect(f({ ranking: { result: null, error: 'bridge down' } }).status).toBe('error');
  });

  it('not passing on proven numbers: proven without the funding order', () => {
    const c = f({ netYes: 100, ranking: null });
    expect(c.status).toBe('proven');
    expect(needsRanking({ active: true, netYes: 100, report: report() })).toBe(false);
    expect(needsRanking({ active: true, netYes: 400, report: report() })).toBe(true);
    expect(needsRanking({ active: false, netYes: 400, report: report() })).toBe(false);
    expect(needsRanking({ active: true, netYes: 400, report: report({ threshold: { status: 'reported' } }) })).toBe(false);
  });

  it('never proven when its inputs are not', () => {
    expect(f({ votes: { status: 'reported', reason: 'x' } }).status).toBe('reported');
    expect(f({ chain: { status: 'error', reason: 'x' } }).status).toBe('reported');
    expect(f({ chain: { status: 'pending' } }).status).toBe('pending');
    expect(f({ netYes: null }).status).toBe('reported');
    expect(f({ report: null }).status).toBe('reported');
  });

  it('payments that are not exact (an unread superblock, an ambiguous twin, an incomplete list) block it', () => {
    expect(f({ report: report({ payments: { unread: [{ height: 1, error: 'x' }] } }) }).status).toBe('reported');
    expect(f({ report: report({ payments: { ambiguous: [{ height: 1, with: 'x' }] } }) }).status).toBe('reported');
    expect(f({ report: report({ payments: { othersComplete: false } }) }).status).toBe('reported');
  });

  it('D-100: a tally flag (inNextBudget, rank) never decides "in the next budget"; only proven numbers or the funding order do', () => {
    // not passing on proven numbers: "no", whatever a tally document claims
    const notPassing = f({ netYes: 100, ranking: null });
    expect(provenFunded({ funding: notPassing, govHash: P.govHash, netYes: 100, report: report(), ranking: null })).toBe(false);
    // passing: the funding order's answer
    expect(provenFunded({ funding: f(), govHash: P.govHash, netYes: 400, report: report(), ranking: rk() })).toBe(true);
    expect(provenFunded({ funding: f(), govHash: P.govHash, netYes: 400, report: report(), ranking: rk({}, { funded: false }) })).toBe(false);
    // not proven: no answer (the page shows the source's flag under a badge that is not "Verified")
    const unproven = f({ ranking: { result: rk({ verified: false }), error: null } });
    expect(provenFunded({ funding: unproven, govHash: P.govHash, netYes: 400, report: report(), ranking: rk({ verified: false }) })).toBeNull();
  });

  it('ended: proven from the proven payments; not checked payments are reported', () => {
    expect(f({ nowS: P.endEpoch + 1, ranking: null }).status).toBe('proven');
    expect(f({ nowS: P.endEpoch + 1, ranking: null, report: report({ payments: null }) }).status).toBe('reported');
  });
});

// ---- end to end: the five checks of a real proposal -------------------------------------------------------------------------------

describe('a whole proposal', () => {
  it('fixture data is "Demo data" even when every check would pass', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const proven: ComponentState = { status: 'proven', summary: 'ok' };
    const cs: Component[] = [
      { id: 'content', state: contentComponent(null) },
      { id: 'collateral', state: collateralComponent({ verdict: verifyCollateral(p, anchoredTx(tx), 'mainnet'), error: null, publishedHeight: p.collateralHeight }) },
      { id: 'chain', state: chainComponent({ report: report(), error: null, unavailable: null }) },
      { id: 'votes', state: proven },
      { id: 'funding', state: proven },
    ];
    expect(aggregate(cs).level).toBe('verified');
    expect(aggregate(cs, { demo: true }).level).toBe('demo');
  });

  it('the recorded fixture replay as it really runs (claims only, chain unavailable, bridge keys) is never verified', async () => {
    const p = byName('OrchardPay');
    const v = verifyCollateral(p, await recorded(p.collateralTxid), 'mainnet');
    const collateral = collateralComponent({ verdict: v, error: null, publishedHeight: p.collateralHeight });
    const chain = chainComponent({ report: null, error: null, unavailable: 'needs live DAPI nodes (recorded data has no header chain)' });
    const cs: Component[] = [
      { id: 'content', state: contentComponent(null) },
      { id: 'collateral', state: collateral },
      { id: 'chain', state: chain },
      { id: 'votes', state: { status: 'reported', reason: 'bridge keys' } },
      { id: 'funding', state: fundingComponent({ proposal: p, nowS: 0, chain, votes: { status: 'reported', reason: 'x' }, report: null, netYes: null, ranking: null }) },
    ];
    expect(aggregate(cs).level).toBe('partial');
  });
});
