// The live source's paging, against a fake SDK: the open list is complete whether Drive's limit counts end times or polls.
import { describe, expect, it, vi } from 'vitest';
import type { Registry } from '../config/registry.ts';
import { DPNS_CONTRACT_ID } from './model.ts';

const fake = vi.hoisted(() => ({ sdk: null as unknown }));
vi.mock('../data/platform.ts', () => ({ getSdk: async () => fake.sdk }));
const { liveContests, NAMES_PAGE } = await import('./source.ts');

const NOW = Date.now();
const poll = (label: string) => ({ toJSON: () => ({ contractId: DPNS_CONTRACT_ID, documentTypeName: 'domain', indexName: 'parentNameAndLabel', indexValues: ['dash', label] }) });

/** 150 contests over 70 end times; a page holds at most `limit` polls (a bucket can be cut), like a GroveDB element limit. */
function pollsByEndDate(countPolls: boolean) {
  const all = Array.from({ length: 150 }, (_, i) => ({ ts: NOW + 60_000 + Math.floor(i / 2.15) * 1000, label: `n${String(i).padStart(3, '0')}` }));
  return vi.fn(async (q: { startTimeMs: number; startTimeIncluded: boolean; limit: number }) => {
    const rest = all.filter((p) => (q.startTimeIncluded ? p.ts >= q.startTimeMs : p.ts > q.startTimeMs));
    const buckets: { timestampMs: bigint; votePolls: ReturnType<typeof poll>[] }[] = [];
    let n = 0;
    for (const p of rest) {
      if (countPolls && n === q.limit) break;
      let b = buckets.at(-1);
      if (!b || b.timestampMs !== BigInt(p.ts)) {
        if (!countPolls && buckets.length === q.limit) break;
        buckets.push((b = { timestampMs: BigInt(p.ts), votePolls: [] }));
      }
      b.votePolls.push(poll(p.label));
      n++;
    }
    return { data: buckets, metadata: { height: 1n } };
  });
}

const registry = { platformNetwork: 'testnet', platform: { trusted: true, addresses: [`t${Math.random()}`] } } as unknown as Registry;

describe('liveContests', () => {
  for (const countPolls of [true, false]) {
    it(`reads every open contest when the limit counts ${countPolls ? 'polls' : 'end times'}`, async () => {
      const q = pollsByEndDate(countPolls);
      fake.sdk = { voting: { votePollsByEndDateWithProof: q } };
      const r = { ...registry, platform: { trusted: true, addresses: [`t${Math.random()}`] } } as Registry;
      const open = await liveContests(r).open();
      expect(open).toHaveLength(150);
      expect(new Set(open.map((c) => c.label)).size).toBe(150);
      expect(open.map((c) => c.endsAt)).toEqual([...open.map((c) => c.endsAt)].sort((a, b) => a - b));
      expect(q.mock.calls.length).toBeLessThan(6);
    });
  }

  it('keeps paging past a full page of another app\'s contested polls', async () => {
    const other = (i: number) => ({ toJSON: () => ({ contractId: 'Other', documentTypeName: 'post', indexName: 'byName', indexValues: [`x${i}`] }) });
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ timestampMs: BigInt(NOW + 1000 + i), votePolls: [other(i)] })),
      [{ timestampMs: BigInt(NOW + 1099), votePolls: [other(99)] }, { timestampMs: BigInt(NOW + 5000), votePolls: [poll('late')] }],
    ];
    const q = vi.fn(async () => ({ data: pages.shift() ?? [], metadata: {} }));
    fake.sdk = { voting: { votePollsByEndDateWithProof: q } };
    const r = { ...registry, platform: { trusted: true, addresses: [`t${Math.random()}`] } } as Registry;
    expect((await liveContests(r).open()).map((c) => c.label)).toEqual(['late']);
  });

  it('pages names from the last entry Platform returned', async () => {
    const labels = Array.from({ length: NAMES_PAGE }, (_, i) => `a${String(i).padStart(3, '0')}`);
    const contestedResourcesWithProof = vi.fn(async () => ({ data: [...labels.slice(0, -1), 42], metadata: {} }));
    fake.sdk = { group: { contestedResourcesWithProof } };
    const page = await liveContests(registry).names({ from: 'a' });
    expect(page.labels).toHaveLength(NAMES_PAGE - 1);
    // the last raw entry is not a label: the cursor falls back to the last label rather than repeating the page
    expect(page.next).toBe(labels.at(-2));
    expect(contestedResourcesWithProof).toHaveBeenCalledWith(expect.objectContaining({ startAtValue: 'a', startAtValueIncluded: true, limit: NAMES_PAGE }));
    await liveContests(registry).names({ after: 'a099' });
    expect(contestedResourcesWithProof).toHaveBeenLastCalledWith(expect.objectContaining({ startAtValue: 'a099', startAtValueIncluded: false }));
  });
});
