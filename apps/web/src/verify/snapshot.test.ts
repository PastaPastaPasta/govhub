// QA stream A (honest "Mismatch"): the bridge's live tally changes at the same height whenever a vote arrives, so the tally a page read
// and the votes the recount fetches a moment later can be two snapshots. Those must never read as a mismatch; a contradiction inside ONE
// snapshot (the bridge labels the set with the tally's voteSetHash and the votes don't reproduce it) still must. Real recorded mainnet
// votes and masternodes, the worker's own fetch-and-recount loop (recountSnapshots), a bridge whose answers move between requests.
import { hash160, p2pkhAddress, signVote } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { BridgeError, type Bridge, type BridgeVotes, type VotesQuery } from '../data/bridge.ts';
import { FixtureBridge, loadFixtures } from '../data/fixtures.ts';
import type { Tally } from '../data/types.ts';
import { votesComponent } from './aggregate.ts';
import type { VotesDone } from './protocol.ts';
import { recountSnapshots } from './snapshot.ts';
import { BRIDGE_TARGET, contradicts, PLATFORM_TARGET, voteVerdict } from './verdict.ts';
import { verifyVotes, type VoteTarget } from './votes.ts';

type Base = Parameters<typeof verifyVotes>[0];
let base: Base;
let H: number;
/** The full recorded set: the live tally after a mid-block vote (here: five more votes than the stored set). */
let live: Tally;
/** The stored record at the same height (what Platform holds), before those votes arrived. */
let stored: Tally;
let fullVotes: Base['votes'];
let storedVotes: Base['votes'];
/** Yet another snapshot: the live set after one more change. */
let laterVotes: Base['votes'];
let later: string;

const tallyOf = (votes: Base['votes'], asOfHeight: number, like: Tally): Tally => {
  const r = verifyVotes({ ...base, votes, targets: [] });
  return { ...like, asOfHeight, yesWeighted: r.weighted.yes, noWeighted: r.weighted.no, abstainWeighted: r.weighted.abstain, yesCount: r.unweighted.yes, noCount: r.unweighted.no, abstainCount: r.unweighted.abstain, voteSetHash: r.voteSetHash };
};

beforeAll(async () => {
  const snap = await loadFixtures();
  const fixture = new FixtureBridge();
  const p = snap.proposals.find((x) => x.name === 'dash-intents')!;
  live = snap.tallies.get(p.govHash)!;
  H = live.asOfHeight;
  fullVotes = (await fixture.votes(p.govHash, { height: H })).votes;
  const mns = (await fixture.mnlist(H)).masternodes;
  const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: m.type === 'evo' ? 1 : 0, typeProven: true }]));
  const proReg = new Map(mns.map((m) => [m.proTxHash.toLowerCase(), { type: m.type === 'evo' ? 1 : 0, collateral: { txid: m.collateralTxid, index: m.collateralIndex } }]));
  base = { govHash: p.govHash, votes: fullVotes, masternodes: mns, network: 'mainnet', now: snap.now, targets: [], sml, proReg };
  storedVotes = fullVotes.filter((v) => v.outcome !== 2).concat(fullVotes.filter((v) => v.outcome === 2).slice(5));
  stored = tallyOf(storedVotes, H, live);
  laterVotes = fullVotes.filter((v) => v.outcome !== 2).concat(fullVotes.filter((v) => v.outcome === 2).slice(2));
  later = tallyOf(laterVotes, H, live).voteSetHash;
  expect(new Set([live.voteSetHash, stored.voteSetHash, later]).size).toBe(3);
}, 30_000);

const set = (votes: Base['votes'], voteSetHash: string | null, tallyHeight = H): BridgeVotes => ({ govHash: base.govHash, asOfHeight: tallyHeight, tallyHeight, mnListHash: null, voteSetHash, votes });

/**
 * A bridge answering like the real API: `?height=H` the stored record, `?voteSetHash=` (new bridges) exactly that set or 404, no
 * parameter the live set. Every request is logged.
 */
function bridge(answer: { height: () => BridgeVotes; hash?: (vsh: string) => BridgeVotes | null; live: () => BridgeVotes }): Bridge & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'test bridge',
    asked,
    async votes(_g: string, q: VotesQuery = {}) {
      asked.push(q.voteSetHash ? `hash=${q.voteSetHash.slice(0, 8)}` : q.height !== undefined ? `height=${q.height}` : 'live');
      if (q.voteSetHash && answer.hash) {
        const s = answer.hash(q.voteSetHash);
        if (!s) throw new BridgeError('no such vote set', 404);
        return s;
      }
      return q.height !== undefined ? answer.height() : answer.live();
    },
  } as unknown as Bridge & { asked: string[] };
}

/** The worker's recount (recountSnapshots, with the same verifyVotes call), and what the page makes of it. */
async function check(b: Bridge, targets: VoteTarget[], shown: VoteTarget, masternodes = base.masternodes) {
  const runs = await recountSnapshots(b, base.govHash, targets, () => {}, async (votes, ts) => ({ result: verifyVotes({ ...base, masternodes, votes: votes.votes, targets: ts }), mnlistHeight: votes.tallyHeight, listMatches: null }));
  const done: VotesDone = { id: 1, kind: 'votes', bridge: 'test', runs, sml: { height: H, blockHash: 'x', node: 'n', validWeighted: 1, weak: null } };
  return { runs, level: voteVerdict(runs).level, component: votesComponent({ shown, talliesLoading: false, bridge: true, result: done, error: null }) };
}

const platform = (): VoteTarget => ({ name: PLATFORM_TARGET, tally: stored });
const bridgeLive = (): VoteTarget => ({ name: BRIDGE_TARGET, tally: live });
/** The new bridge's by-hash answers: the stored and the live (held) set. */
const known = (vsh: string) => (vsh === stored.voteSetHash ? set(storedVotes, stored.voteSetHash) : vsh === live.voteSetHash ? set(fullVotes, live.voteSetHash) : null);

describe('a vote arriving between reading the tally and reading its votes is never a mismatch', () => {
  it('reproduces the QA race: the stored set at the live tally\'s height, compared by height alone, would be a "Mismatch"', () => {
    const r = verifyVotes({ ...base, votes: storedVotes, targets: [bridgeLive()] });
    // the run as the worker recorded it before (no label): comparable by height, and contradicted
    expect(contradicts({ votesAsOf: H, asked: H }, r.targets[0]!)).toBe(true);
    // with the label the bridge sent (the stored set's hash), it is another snapshot, not a contradiction
    expect(contradicts({ votesAsOf: H, asked: H, servedVoteSetHash: stored.voteSetHash }, r.targets[0]!)).toBe(false);
  });

  it('new bridge: the live tally\'s set is fetched by its hash, and both tallies verify', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: known, live: () => set(laterVotes, later) });
    const { runs, level, component } = await check(b, [platform(), bridgeLive()], platform());
    expect(b.asked).toEqual([`height=${H}`, `height=${H}`, `hash=${live.voteSetHash.slice(0, 8)}`]);
    expect(runs.every((r) => r.result.targets.every((t) => t.matches))).toBe(true);
    expect(level).toBe('verified');
    expect(component.status).toBe('proven');
    // shown the bridge's live tally instead: a match, though on the bridge's word (never "Mismatch")
    expect((await check(b, [platform(), bridgeLive()], bridgeLive())).component).toMatchObject({ status: 'reported' });
  });

  it('old bridge (ignores voteSetHash), live set still the held one: found on the live set', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), live: () => set(fullVotes, live.voteSetHash) });
    const { level, component } = await check(b, [bridgeLive()], bridgeLive());
    expect(b.asked).toEqual([`height=${H}`, `hash=${live.voteSetHash.slice(0, 8)}`, 'live']); // an old bridge answers the by-hash request as ?height=
    expect(level).toBe('verified');
    expect(component.status).toBe('reported');
  });

  it('old bridge, the live set moved on again: "couldn\'t verify yet" (another vote set served), not "Mismatch"', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), live: () => set(laterVotes, later) });
    const { runs, level, component } = await check(b, [bridgeLive()], bridgeLive());
    expect(b.asked).toHaveLength(3); // bounded: height, hash, live
    expect(level).toBe('changed');
    expect(component.status).toBe('error');
    expect(component).not.toHaveProperty('mismatch');
    expect(component.status === 'error' && component.reason).toMatch(/^Couldn't verify yet: for block [\d,]+ the bridge served another vote set than the one behind the Bridge live tally \(usually a vote arrived while checking/);
    // the recount is of the stored set, labelled as such
    expect(runs[0]).toMatchObject({ votesAsOf: H, asked: H, servedVoteSetHash: stored.voteSetHash });
    // and with the Platform tally next to it, that one still verifies
    const both = await check(b, [platform(), bridgeLive()], platform());
    expect(both.component.status).toBe('proven');
  });

  it('new bridge that no longer holds the held set (expired, restarted): not a mismatch either', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: (v) => (v === stored.voteSetHash ? known(v) : null), live: () => set(laterVotes, later) });
    const { level, component } = await check(b, [bridgeLive()], bridgeLive());
    expect(level).toBe('changed');
    expect(component).toMatchObject({ status: 'error' });
    expect(component).not.toHaveProperty('mismatch');
  });
});

describe('a contradiction inside one snapshot is still a mismatch', () => {
  it('the set at the tally\'s height carries the tally\'s voteSetHash but holds other votes: mismatch on the first answer', async () => {
    const b = bridge({ height: () => set(storedVotes, live.voteSetHash), hash: known, live: () => set(fullVotes, live.voteSetHash) });
    const { level, component } = await check(b, [bridgeLive()], bridgeLive());
    expect(b.asked).toEqual([`height=${H}`]); // labelled as the tally's set: compared, no second request that could hide it
    expect(level).toBe('mismatch');
    expect(component).toMatchObject({ status: 'error', mismatch: true });
  });

  it('asked by hash, the bridge serves a set labelled with that hash whose votes differ (one outcome flipped): mismatch', async () => {
    const flipped = fullVotes.map((v, i) => (i === 0 ? { ...v, outcome: v.outcome === 1 ? 2 : 1 } : v));
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: (v) => (v === live.voteSetHash ? set(flipped, live.voteSetHash) : known(v)), live: () => set(laterVotes, later) });
    const { level, component } = await check(b, [platform(), bridgeLive()], platform());
    expect(level).toBe('mismatch');
    expect(component).toMatchObject({ status: 'error', mismatch: true });
  });

  it('a tampered Platform tally, the bridge serving its honest set labelled with the Platform hash: mismatch', async () => {
    const tampered: Tally = { ...stored, yesWeighted: stored.yesWeighted + 100 };
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: known, live: () => set(fullVotes, live.voteSetHash) });
    const { component } = await check(b, [{ name: PLATFORM_TARGET, tally: tampered }], { name: PLATFORM_TARGET, tally: tampered });
    expect(component).toMatchObject({ status: 'error', mismatch: true });
    expect(component.status === 'error' && component.reason).toContain('Yes (weighted)');
  });

  it('the bound: a bridge that withholds votes and labels what it serves consistently gets "couldn\'t verify yet", never verified', async () => {
    // The Platform tally counts every vote; the bridge serves five fewer under their own hash, whatever it is asked. Like answering
    // 404 (which a bridge can always do), that hides which side is wrong, so it is not called a mismatch: the recount is of no tally.
    const full: VoteTarget = { name: PLATFORM_TARGET, tally: live };
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: () => set(storedVotes, stored.voteSetHash), live: () => set(storedVotes, stored.voteSetHash) });
    const { level, component } = await check(b, [full], full);
    expect(level).toBe('changed');
    expect(component.status).toBe('error');
    // a set the bridge mislabels but whose votes do reproduce the tally is that tally's set: the votes decide, not the label
    const honest = bridge({ height: () => set(fullVotes, later), live: () => set(fullVotes, later) });
    expect((await check(honest, [full], full)).component.status).toBe('proven');
  });
});

describe('every tamper case, labelled with the tally\'s hash or relabelled: never proven; a mismatch only when labelled as the tally\'s', () => {
  /** A bridge serving the same (tampered) votes to every request, under `label`. */
  const serving = (votes: Base['votes'], label: string) => bridge({ height: () => set(votes, label), hash: () => set(votes, label), live: () => set(votes, label) });
  const other = 'ee'.repeat(32);
  type Case = { votes: () => Base['votes']; tally: () => Tally; masternodes?: () => Base['masternodes']; labelled: 'mismatch' | 'excluded' };
  const cases: Record<string, Case> = {
    'tally number +100': { votes: () => fullVotes, tally: () => ({ ...live, yesWeighted: live.yesWeighted + 100 }), labelled: 'mismatch' },
    'vote outcome flipped (signature fails)': { votes: () => fullVotes.map((v, i) => (i === 0 ? { ...v, outcome: v.outcome === 1 ? 2 : 1 } : v)), tally: () => live, labelled: 'mismatch' },
    'votes withheld': { votes: () => storedVotes, tally: () => live, labelled: 'mismatch' },
    // PR #33: a masternode the proven list lacks, with a vote its key signed, counted in the published tally
    'fake masternode counted (excluded here)': {
      ...(() => {
        const key = secp256k1.utils.randomSecretKey();
        const fake = { proTxHash: 'fa'.repeat(32), collateralTxid: 'fb'.repeat(32), collateralIndex: 0, votingAddress: p2pkhAddress(hash160(secp256k1.getPublicKey(key, true)), 'mainnet'), type: 'evo' as const, valid: true };
        let vote: Base['votes'][number] | null = null;
        const votes = () => {
          const fields = { collateralTxid: fake.collateralTxid, collateralIndex: 0, govHashDisplay: base.govHash, signal: 1, outcome: 1, time: base.now - 60 };
          vote ??= { ...fields, sig: signVote({ privKey: key, vote: fields, network: 'mainnet' }).base64 };
          return [...fullVotes, vote];
        };
        const masternodes = () => [...base.masternodes, fake];
        return { votes, masternodes, tally: () => tallyOfServed(votes(), masternodes()) };
      })(),
      labelled: 'excluded' as const,
    },
  };
  /** The tally a bridge would publish from its own (served) view: its list, its keys. */
  const tallyOfServed = (votes: Base['votes'], masternodes: Base['masternodes']): Tally => {
    const r = verifyVotes({ ...base, votes, masternodes, sml: null, proReg: null, targets: [] });
    return { ...live, yesWeighted: r.weighted.yes, noWeighted: r.weighted.no, abstainWeighted: r.weighted.abstain, yesCount: r.unweighted.yes, noCount: r.unweighted.no, abstainCount: r.unweighted.abstain, voteSetHash: r.voteSetHash };
  };

  for (const [name, c] of Object.entries(cases)) {
    it(name, async () => {
      const tally = c.tally();
      const target: VoteTarget = { name: PLATFORM_TARGET, tally };
      const mns = c.masternodes?.();
      const labelled = await check(serving(c.votes(), tally.voteSetHash), [target], target, mns);
      if (c.labelled === 'mismatch') {
        expect(labelled.component).toMatchObject({ status: 'error', mismatch: true });
        expect(labelled.level).toBe('mismatch');
      } else {
        expect(labelled.component.status).toBe('reported');
        expect(labelled.level).toBe('excluded');
      }
      const relabelled = await check(serving(c.votes(), other), [target], target, mns);
      expect(relabelled.component.status).not.toBe('proven');
      expect(relabelled.level).not.toBe('verified');
      if (c.labelled === 'mismatch') {
        // what a bridge gains by relabelling: "couldn't verify yet" instead of "Mismatch"; never a pass, never partly verified
        expect(relabelled.component).toMatchObject({ status: 'error' });
        expect(relabelled.component).not.toHaveProperty('mismatch');
        expect(relabelled.level).toBe('changed');
      } else {
        // the votes explain the tally whatever the label (the content decides): the same "not fully proven" as labelled
        expect(relabelled.component.status).toBe('reported');
        expect(relabelled.level).toBe('excluded');
      }
    });
  }

  it('a follow-up request that fails (HTTP 500) keeps the answer in hand, labelled', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: () => { throw new BridgeError('test bridge answered HTTP 500', 500); }, live: () => set(fullVotes, live.voteSetHash) });
    const { runs, level } = await check(b, [bridgeLive()], bridgeLive());
    expect(runs[0]).toMatchObject({ asked: H, servedVoteSetHash: stored.voteSetHash });
    expect(level).toBe('changed');
    // ...but a failure before any answer still fails the recount
    const down = bridge({ height: () => { throw new BridgeError('unreachable'); }, live: () => set(fullVotes, live.voteSetHash) });
    await expect(check(down, [bridgeLive()], bridgeLive())).rejects.toThrow('unreachable');
  });

  it('a 404 by hash moves on to the live set', async () => {
    const b = bridge({ height: () => set(storedVotes, stored.voteSetHash), hash: () => null, live: () => set(fullVotes, live.voteSetHash) });
    expect((await check(b, [bridgeLive()], bridgeLive())).level).toBe('verified');
    expect(b.asked).toEqual([`height=${H}`, `hash=${live.voteSetHash.slice(0, 8)}`, 'live']);
  });
});
