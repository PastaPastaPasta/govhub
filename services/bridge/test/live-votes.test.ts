// D-071: a vote seen over ZMQ is in the live vote set and tallies within seconds (one debounced run per burst), not at the next
// block; in memory only, so the stored per-height tallies (?height=, the published documents) do not change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countVotes, hexToBytes } from '@govhub/verify';
import { createApi } from '../src/api/server.ts';
import type { Bridge } from '../src/bridge.ts';
import { parseRawVote } from '../src/core/govparse.ts';
import type { CoreRpc } from '../src/core/rpc.ts';
import { latestSnapshot } from '../src/mnlist.ts';
import { RETIRED_SET_MAX, RETIRED_SET_TTL_S, RetiredVoteSets, type TallyRun } from '../src/tally.ts';
import { votesFixture } from './helpers.ts';
import { FIXTURE_NOW, fixtureBridge } from './world.ts';

const vf = votesFixture();
const prop = vf.proposals.find((p) => p.votes.length >= 3)!;
const late = prop.votes.slice(0, 2).map((v) => ({ raw: hexToBytes(v.rawHex), hash: parseRawVote(hexToBytes(v.rawHex)).hash }));

/** Core as the live refresh sees it: the tip is still the snapshot's block; `gobject get` calls are recorded per proposal. */
function fakeCore(b: Bridge, tip: () => { height: number; hash: string }, asked: string[] = []) {
  const rpc = {
    getBlockCount: async () => tip().height,
    getBlockHash: async () => tip().hash,
    gobjectGet: async (h: string) => (asked.push(h), { FundingResult: { YesCount: 0, NoCount: 0, AbstainCount: 0, AbsoluteYesCount: 0 } }),
    gobjectCurrentVotes: async () => ({}),
  } as unknown as CoreRpc;
  (b.ingest as { rpc: CoreRpc }).rpc = rpc;
  (b as { rpc: CoreRpc }).rpc = rpc;
}

const counted = (b: Bridge) => new Set(b.lastRun!.tallies.find((t) => t.govHash === prop.govHash)!.counted.map((v) => v.hash));

describe('live vote refresh (D-071)', () => {
  beforeEach(() => vi.useFakeTimers({ now: FIXTURE_NOW * 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('a burst of ZMQ votes is counted in the live vote set a few seconds later, once, without a new block; stored tallies stay', async () => {
    const b = await fixtureBridge({}, new Set(late.map((v) => v.hash)));
    const snap = latestSnapshot(b.db)!;
    fakeCore(b, () => ({ height: snap.height, hash: snap.blockHash }));
    const app = createApi(b);
    const live = async () => (await (await app.request(`/v1/proposals/${prop.govHash}/votes`)).json()) as { voteSetHash: string; votes: Array<{ hash: string }> };
    const before = await live();
    const stored = () => b.db.prepare('SELECT COUNT(*) n FROM tallies').get();
    const storedBefore = stored();
    const atHeight = async () => ((await (await app.request(`/v1/proposals/${prop.govHash}/votes?height=${snap.height}`)).json()) as { voteSetHash: string }).voteSetHash;
    const publishedHash = await atHeight();
    const spy = vi.spyOn(b, 'refreshVotes');

    vi.advanceTimersByTime(10_000); // the votes arrive after the snapshot was read
    for (const [i, v] of late.entries()) await b.ingest.onZmq({ topic: 'rawgovernancevote', body: v.raw, seq: i, receivedAt: Math.floor(Date.now() / 1000) });
    await vi.advanceTimersByTimeAsync(1000);
    for (const v of late) expect(counted(b).has(v.hash)).toBe(false); // pending: no list read after them yet

    await vi.advanceTimersByTimeAsync(2500); // VOTE_REFRESH_DEBOUNCE_MS (3000) after the first vote
    expect(spy).toHaveBeenCalledTimes(1); // one run for the burst
    for (const v of late) expect(counted(b).has(v.hash)).toBe(true);
    const after = await live();
    expect(after.votes.length).toBe(before.votes.length + 2);
    expect(after.voteSetHash).not.toBe(before.voteSetHash);
    expect(b.lastRun!.height).toBe(snap.height); // same block
    // the stored tallies and the vote set at that height (what published documents point at) did not change
    expect(stored()).toEqual(storedBefore);
    expect(await atHeight()).toBe(publishedHash);
    // a duplicate copy of a known vote schedules nothing
    await b.ingest.onZmq({ topic: 'rawgovernancevote', body: late[0]!.raw, seq: 9, receivedAt: Math.floor(Date.now() / 1000) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('when the tip moved (new block or reorg) the live refresh leaves it to the block path; 0 turns it off', async () => {
    const b = await fixtureBridge({}, new Set(late.map((v) => v.hash)));
    const snap = latestSnapshot(b.db)!;
    let tip = { height: snap.height, hash: 'ff'.repeat(32) }; // same height, another block
    fakeCore(b, () => tip);
    vi.advanceTimersByTime(10_000);
    await b.ingest.onZmq({ topic: 'rawgovernancevote', body: late[0]!.raw, seq: 1, receivedAt: Math.floor(Date.now() / 1000) });
    await vi.advanceTimersByTimeAsync(3500);
    expect(counted(b).has(late[0]!.hash)).toBe(false);
    tip = { height: snap.height + 1, hash: snap.blockHash };
    expect(await b.refreshVotes()).toBeNull();

    const off = await fixtureBridge({ VOTE_REFRESH_DEBOUNCE_MS: '0' }, new Set(late.map((v) => v.hash)));
    expect(off.ingest.onNewVote).toBeNull();
  });

  it('while the block path holds the lock, a stream of votes queues one live refresh, which asks Core only about changed proposals', async () => {
    const b = await fixtureBridge({}, new Set(late.map((v) => v.hash)));
    const snap = latestSnapshot(b.db)!;
    const asked: string[] = [];
    fakeCore(b, () => ({ height: snap.height, hash: snap.blockHash }), asked);
    await b.refreshVotes(); // a first live run compares every proposal once
    const all = asked.length;
    expect(all).toBe(b.lastRun!.tallies.length);
    asked.length = 0;
    const spy = vi.spyOn(b, 'refreshVotes');
    let release!: () => void;
    const block = b.exclusive(() => new Promise<void>((r) => (release = r))); // a slow block refresh
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 10; i++) {
      await b.ingest.onZmq({ topic: 'rawgovernancevote', body: late[i % 2]!.raw, seq: i, receivedAt: Math.floor(Date.now() / 1000) });
      if (i === 1) for (const v of late) b.ingest.onNewVote!(); // more new-vote signals than votes
      await vi.advanceTimersByTimeAsync(3500);
    }
    expect(spy).toHaveBeenCalledTimes(0);
    release();
    await block;
    await vi.advanceTimersByTimeAsync(10);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const v of late) expect(counted(b).has(v.hash)).toBe(true);
    expect(asked).toEqual([prop.govHash]); // only the proposal whose vote set changed
  });
});

describe('vote set by voteSetHash: a tally read before a mid-block vote is still recountable (QA A: honest "Mismatch")', () => {
  beforeEach(() => vi.useFakeTimers({ now: FIXTURE_NOW * 1000, toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  type VoteSet = { asOfHeight: number; tallyHeight: number; voteSetHash: string; yesWeighted: number; noWeighted: number; abstainWeighted: number; votes: Array<{ hash: string; collateralTxid: string; collateralIndex: number; outcome: number; time: number; weight: number }> };
  /** What a client recounts from the served set alone (signatures aside: the bridge tests check those elsewhere). */
  const recount = (s: VoteSet) =>
    countVotes(s.votes.map((v) => ({ mn: `${v.collateralTxid}-${v.collateralIndex}`, outcome: v.outcome, time: v.time })), new Map(s.votes.map((v) => [`${v.collateralTxid}-${v.collateralIndex}`, v.weight])), { now: FIXTURE_NOW });

  it('two live refreshes at one height: ?height= serves the stored set, ?voteSetHash= the exact set of the tally the client read', async () => {
    const b = await fixtureBridge({}, new Set(late.map((v) => v.hash)));
    const snap = latestSnapshot(b.db)!;
    fakeCore(b, () => ({ height: snap.height, hash: snap.blockHash }));
    const app = createApi(b);
    const json = async (path: string) => {
      const r = await app.request(path);
      return { status: r.status, body: (await r.json()) as VoteSet & { error?: string } };
    };
    const liveTally = async () => ((await (await app.request('/v1/tallies')).json()) as { tallies: Array<{ govHash: string; asOfHeight: number; voteSetHash: string; yesWeighted: number; noWeighted: number; abstainWeighted: number }> }).tallies.find((t) => t.govHash === prop.govHash)!;
    const stored = await liveTally();
    const vote = async (i: number) => {
      await b.ingest.onZmq({ topic: 'rawgovernancevote', body: late[i]!.raw, seq: i, receivedAt: Math.floor(Date.now() / 1000) });
      await vi.advanceTimersByTimeAsync(3500);
    };

    vi.advanceTimersByTime(10_000);
    await vote(0);
    const held = await liveTally(); // the client reads the live tally (one mid-block vote in) ...
    expect(held.asOfHeight).toBe(stored.asOfHeight);
    expect(held.voteSetHash).not.toBe(stored.voteSetHash);
    await vote(1); // ... and another vote arrives before it fetches the votes
    expect((await liveTally()).voteSetHash).not.toBe(held.voteSetHash);

    // the race QA saw: the same height serves another set than the tally the client holds
    const atHeight = await json(`/v1/proposals/${prop.govHash}/votes?height=${held.asOfHeight}`);
    expect(atHeight.body.voteSetHash).toBe(stored.voteSetHash);
    // by hash: exactly the held tally's set, and a recount of it reproduces that tally
    const exact = await json(`/v1/proposals/${prop.govHash}/votes?height=${held.asOfHeight}&voteSetHash=${held.voteSetHash}`);
    expect(exact.status).toBe(200);
    expect(exact.body).toMatchObject({ asOfHeight: held.asOfHeight, tallyHeight: held.asOfHeight, voteSetHash: held.voteSetHash, yesWeighted: held.yesWeighted, noWeighted: held.noWeighted, abstainWeighted: held.abstainWeighted });
    const r = recount(exact.body);
    expect(r.voteSetHash).toBe(held.voteSetHash);
    expect(r.weighted).toEqual({ yes: held.yesWeighted, no: held.noWeighted, abstain: held.abstainWeighted });
    // without a height, and upper-case: the same set
    expect((await json(`/v1/proposals/${prop.govHash}/votes?voteSetHash=${held.voteSetHash.toUpperCase()}`)).body.voteSetHash).toBe(held.voteSetHash);
    // the stored set and the current live set are found by hash too
    expect((await json(`/v1/proposals/${prop.govHash}/votes?height=${held.asOfHeight}&voteSetHash=${stored.voteSetHash}`)).body.votes.length).toBe(atHeight.body.votes.length);
    const now = await liveTally();
    expect(recount((await json(`/v1/proposals/${prop.govHash}/votes?voteSetHash=${now.voteSetHash}`)).body).voteSetHash).toBe(now.voteSetHash);

    // never another set under the asked hash: unknown is 404, malformed 400, a height below the set's 404
    expect((await json(`/v1/proposals/${prop.govHash}/votes?voteSetHash=${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await json(`/v1/proposals/${prop.govHash}/votes?voteSetHash=xyz`)).status).toBe(400);
    expect((await json(`/v1/proposals/${prop.govHash}/votes?height=${held.asOfHeight - 1}&voteSetHash=${held.voteSetHash}`)).status).toBe(404);
    expect((await json(`/v1/proposals/${prop.govHash}/votes?height=${held.asOfHeight + 1}&voteSetHash=${held.voteSetHash}`)).status).toBe(404);

    // superseded live sets are memory only and expire
    vi.advanceTimersByTime((RETIRED_SET_TTL_S + 1) * 1000);
    expect((await json(`/v1/proposals/${prop.govHash}/votes?voteSetHash=${held.voteSetHash}`)).status).toBe(404);
  });

  it('retired sets: only replaced ones are kept, oldest evicted first beyond the cap', () => {
    const run = (sets: Array<[string, string]>): TallyRun =>
      ({ tallies: sets.map(([govHash, voteSetHash]) => ({ govHash, voteSetHash, asOfHeight: 5, listHash: 'l', weighted: { yes: 0, no: 0, abstain: 0 }, counted: [{ hash: `${govHash}${voteSetHash}` }] })) }) as unknown as TallyRun;
    const r = new RetiredVoteSets();
    r.retire(run([['a', '1'], ['b', '1']]), run([['a', '2'], ['b', '1']]), 100);
    expect(r.get('a', '1', 100)?.voteHashes).toEqual(['a1']);
    expect(r.get('b', '1', 100)).toBeUndefined(); // still the current set
    for (let i = 0; i < RETIRED_SET_MAX + 10; i++) r.retire(run([['c', String(i)]]), run([['c', String(i + 1)]]), 200);
    expect(r.size).toBe(RETIRED_SET_MAX);
    expect(r.get('a', '1', 200)).toBeUndefined();
    expect(r.get('c', String(RETIRED_SET_MAX + 9), 200)).toBeDefined();
    // a set that became current again and is replaced once more ages from its latest retirement
    const again = new RetiredVoteSets();
    again.retire(run([['d', '1']]), run([['d', '2']]), 1000);
    again.retire(run([['d', '1']]), run([['d', '3']]), 1000 + RETIRED_SET_TTL_S - 10);
    expect(again.get('d', '1', 1000 + RETIRED_SET_TTL_S + 60)).toBeDefined();
  });

  it('retired sets: a new block with no new vote keeps the set at the height before, under the same voteSetHash', () => {
    const at = (h: number) => ({ tallies: [{ govHash: 'p', voteSetHash: '1', asOfHeight: h, listHash: 'l', weighted: { yes: 0, no: 0, abstain: 0 }, counted: [{ hash: 'v' }] }] }) as unknown as TallyRun;
    const r = new RetiredVoteSets();
    r.retire(at(10), at(11), 100);
    r.retire(at(11), at(12), 200);
    expect(r.get('p', '1', 200, 10)?.asOfHeight).toBe(10);
    expect(r.get('p', '1', 200, 11)?.asOfHeight).toBe(11);
    expect(r.get('p', '1', 200)?.asOfHeight).toBe(11);
    expect(r.get('p', '1', 200, 9)).toBeUndefined();
    // the live run at 12 is not retired: it is still current
    r.retire(at(12), at(12), 300);
    expect(r.get('p', '1', 300, 12)?.asOfHeight).toBe(11);
  });
});
