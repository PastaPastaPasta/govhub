// PV13 paging of the Past list (G3, desc) and the tally read's failure isolation, over a fake Platform that evaluates the query.
import { base58 } from '@scure/base';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { profileRegistry } from '../config/registry.ts';
import { hexToB64 } from '../lib/bytes.ts';
import { loadFixtures, type FixtureSnapshot } from './fixtures.ts';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import type { Proposal } from './types.ts';

// Platform is faked below the data layer: queryDocs evaluates `endEpoch <= x` + `orderBy endEpoch desc` + limit like Drive does.
const platform = vi.hoisted(() => ({
  types: new Set<string>(['proposal', 'tally', 'talliesSet']),
  proposals: [] as Record<string, unknown>[],
  queries: [] as DocQuery[],
  failTalliesSet: false,
  tallies: [] as Record<string, unknown>[],
}));
vi.mock('./platform.ts', async (orig) => {
  const real = await orig<typeof import('./platform.ts')>();
  return {
    ...real,
    govDocTypes: async () => platform.types,
    queryDocs: async (_r: unknown, q: DocQuery) => {
      platform.queries.push(q);
      if (q.documentTypeName === 'talliesSet') {
        if (platform.failTalliesSet) throw new Error('talliesSet read failed');
        return { docs: [], height: 777 };
      }
      if (q.documentTypeName === 'tally') return { docs: platform.tallies, height: 777 };
      if (q.documentTypeName !== 'proposal') return { docs: [], height: 777 };
      const [, op, v] = q.where.find((w) => w[0] === 'endEpoch')!;
      const t = v as number;
      const test = (e: number) => (op === '<=' ? e <= t : op === '<' ? e < t : op === '==' ? e === t : false);
      const dir = q.orderBy?.[0]?.[1] === 'asc' ? 1 : -1;
      let rows = platform.proposals
        .filter((d) => test(d.endEpoch as number))
        .sort((a, b) => dir * ((a.endEpoch as number) - (b.endEpoch as number)) || String(a.$id).localeCompare(String(b.$id)));
      if (q.startAfter) rows = rows.slice(rows.findIndex((d) => d.$id === q.startAfter) + 1);
      return { docs: rows.slice(0, q.limit ?? 100), height: 777 };
    },
  };
});
const { liveSource } = await import('./repo.ts');

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
});
beforeEach(() => {
  platform.proposals = [];
  platform.queries = [];
  platform.failTalliesSet = false;
  platform.tallies = [];
});

const id = (i: number) => base58.encode(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? 1 + (i >> 8) : k === 1 ? i & 0xff : 7)));
const docOf = (p: Proposal, i: number, endEpoch: number): Record<string, unknown> => ({
  $id: id(i),
  $createdAt: p.createdAt,
  govHash: hexToB64(i.toString(16).padStart(64, '0')),
  parentHash: hexToB64(p.parentHash),
  revision: p.revision,
  time: p.time,
  dataHex: p.dataHex,
  name: p.name,
  endEpoch,
  collateralTxid: hexToB64(p.collateralTxid),
  collateralHeight: p.collateralHeight,
});

async function readAll() {
  const source = liveSource(profileRegistry('testnet'));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await source.pastPage(cursor);
    seen.push(...page.items.map((x) => x.value.docId!));
    if (!page.next) break;
    cursor = page.next;
  }
  return seen;
}

describe('Past list paging on PV13 (G3 desc, keyset instead of startAfter)', () => {
  it('reads every ended proposal exactly once, newest end first, even when one endEpoch spans a page boundary', async () => {
    const p = snap.proposals[0]!;
    // 260 proposals, 40 per endEpoch: page boundaries (every 100) fall inside a group
    platform.proposals = Array.from({ length: 260 }, (_, i) => docOf(p, i, 1_700_000_000 - Math.floor(i / 40) * 86_400));
    const seen = await readAll();
    expect(seen).toHaveLength(260);
    expect(new Set(seen).size).toBe(260);
    const qs = platform.queries.filter((q) => q.documentTypeName === 'proposal');
    expect(qs.length).toBeGreaterThan(2);
    expect(qs.every((q) => q.startAfter === undefined)).toBe(true);
    // the second page is bounded by the first page's last endEpoch
    expect(qs[1]!.where[0]).toEqual(['endEpoch', '<=', 1_700_000_000 - 2 * 86_400]);
  });

  it('more than a page sharing one endEpoch hides nothing older: that end is swept ascending (startAfter), then the list goes on', async () => {
    const p = snap.proposals[0]!;
    platform.proposals = [
      docOf(p, 0, 1_700_100_000), // newer
      ...Array.from({ length: 230 }, (_, i) => docOf(p, 1 + i, 1_700_000_000)),
      ...Array.from({ length: 5 }, (_, i) => docOf(p, 300 + i, 1_600_000_000 - i)), // older
    ];
    const seen = await readAll();
    expect(seen).toHaveLength(236);
    expect(new Set(seen).size).toBe(236);
    expect(seen.slice(-5)).toEqual([300, 301, 302, 303, 304].map(id));
    const qs = platform.queries.filter((q) => q.documentTypeName === 'proposal');
    for (const q of qs) if (q.orderBy?.[0]?.[1] === 'desc') expect(q.startAfter).toBeUndefined();
    expect(qs.some((q) => q.where[0]![1] === '==' && q.startAfter)).toBe(true);
  });

  it('a malformed cursor returns nothing rather than restarting from the newest', async () => {
    const page = await liveSource(profileRegistry('testnet')).pastPage('not json');
    expect(page.items).toEqual([]);
    expect(page.next).toBeUndefined();
  });
});

describe('tallies(): a failed talliesSet read does not hide the per-proposal tallies', () => {
  it('returns the tally documents when the packed set cannot be read', async () => {
    const t = [...snap.tallies.values()][0]!;
    platform.tallies = [{ ...t, govHash: hexToB64(t.govHash), voteSetHash: hexToB64(t.voteSetHash) }];
    platform.failTalliesSet = true;
    const got = await liveSource(profileRegistry('testnet')).tallies([t.govHash]);
    expect(got.get(t.govHash)?.value.asOfHeight).toBe(t.asOfHeight);
  });
});
