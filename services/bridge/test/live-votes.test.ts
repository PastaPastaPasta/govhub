// D-071: a vote seen over ZMQ is in the live vote set and tallies within seconds (one debounced run per burst), not at the next
// block; in memory only, so the stored per-height tallies (?height=, the published documents) do not change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@govhub/verify';
import { createApi } from '../src/api/server.ts';
import type { Bridge } from '../src/bridge.ts';
import { parseRawVote } from '../src/core/govparse.ts';
import type { CoreRpc } from '../src/core/rpc.ts';
import { latestSnapshot } from '../src/mnlist.ts';
import { votesFixture } from './helpers.ts';
import { FIXTURE_NOW, fixtureBridge } from './world.ts';

const vf = votesFixture();
const prop = vf.proposals.find((p) => p.votes.length >= 3)!;
const late = prop.votes.slice(0, 2).map((v) => ({ raw: hexToBytes(v.rawHex), hash: parseRawVote(hexToBytes(v.rawHex)).hash }));

/** Core as the live refresh sees it: the tip is still the snapshot's block; the comparison calls fail (no Core comparison). */
function fakeCore(b: Bridge, tip: () => { height: number; hash: string }) {
  const rpc = {
    getBlockCount: async () => tip().height,
    getBlockHash: async () => tip().hash,
    gobjectGet: async () => Promise.reject(new Error('not in this test')),
    gobjectCurrentVotes: async () => Promise.reject(new Error('not in this test')),
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
});
