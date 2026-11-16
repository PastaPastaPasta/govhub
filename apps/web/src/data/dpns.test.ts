// DPNS names: the first registered .dash name of an identity, batched lookups (one query per tick and chunk), paging, caching, and
// failures that are retried rather than remembered as "no name".
import { describe, expect, it, vi } from 'vitest';
import { createDpnsResolver, domainIdentity, primaryName, type DomainDoc, type DomainQuery } from './dpns.ts';

const A = 'CkKwW6VVEvo1EEps7NERZADE13ZWUwwz7kkuZentxVuj';
const B = 'E5Mty9ojZou1GrcGaAszCywo3tqHykzrN1onmTox8FXG';
const C = 'GgZekwh38XcWQTyWWWvmw6CEYFnLU7yiZFPWZEjqKHit';

let n = 0;
const dom = (identity: string, label: string, createdAt: number, extra: Partial<DomainDoc> = {}): DomainDoc => ({
  $id: `doc${String(++n).padStart(4, '0')}`,
  $ownerId: identity,
  $createdAt: createdAt,
  label,
  normalizedLabel: label.toLowerCase(),
  normalizedParentDomainName: 'dash',
  records: { identity },
  ...extra,
});

/** A Platform holding `docs`: `in` queries ordered by identity then $id, paged with startAfter, every call recorded. */
function platform(docs: DomainDoc[]) {
  const calls: Array<{ ids: string[]; startAfter?: string }> = [];
  const sorted = [...docs].sort((x, y) => {
    const a = String(x.records?.identity), b = String(y.records?.identity);
    return a < b ? -1 : a > b ? 1 : String(x.$id) < String(y.$id) ? -1 : 1;
  });
  const query: DomainQuery = async (ids, { limit, startAfter }) => {
    calls.push({ ids: [...ids], ...(startAfter ? { startAfter } : {}) });
    const hits = sorted.filter((d) => ids.includes(String(d.records?.identity)));
    const from = startAfter ? hits.findIndex((d) => d.$id === startAfter) + 1 : 0;
    return hits.slice(from, from + limit);
  };
  return { query, calls };
}

describe('primaryName', () => {
  it('picks the first registered name of several, whatever order they come in', () => {
    const docs = [dom(A, 'zeta', 300), dom(A, 'Alpha', 200), dom(A, 'mid', 250), dom(B, 'other', 100)];
    expect(primaryName(A, docs)).toBe('Alpha.dash');
    expect(primaryName(A, [...docs].reverse())).toBe('Alpha.dash');
    expect(primaryName(B, docs)).toBe('other.dash');
    expect(primaryName(C, docs)).toBeUndefined();
  });

  it('breaks a tie of registration times by the label, and puts a name without a time last', () => {
    expect(primaryName(A, [dom(A, 'bbb', 100), dom(A, 'aaa', 100)])).toBe('aaa.dash');
    expect(primaryName(A, [dom(A, 'early', Number.NaN), dom(A, 'late', 900)])).toBe('late.dash');
  });

  it('skips documents that are not a .dash name of that identity', () => {
    expect(domainIdentity(dom(A, 'sub', 1, { normalizedParentDomainName: 'foo.dash' }))).toBeNull();
    expect(domainIdentity(dom(A, 'moved', 1, { $ownerId: B }))).toBeNull(); // the record points at someone who no longer owns it
    expect(domainIdentity(dom(A, '-bad-', 1))).toBeNull();
    expect(domainIdentity(dom(A, 'a‮b', 1))).toBeNull();
    expect(domainIdentity({ ...dom(A, 'none', 1), records: null })).toBeNull();
    expect(primaryName(A, [dom(A, 'sub', 1, { normalizedParentDomainName: 'foo.dash' }), dom(A, 'real', 5)])).toBe('real.dash');
  });
});

describe('createDpnsResolver', () => {
  it('asks once for every id wanted in the same tick, and answers each caller its own ids', async () => {
    const p = platform([dom(A, 'alice', 1), dom(B, 'bob', 2)]);
    const r = createDpnsResolver(p.query);
    const [x, y] = await Promise.all([r.names([A, C]), r.names([B, A])]);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.ids.sort()).toEqual([A, B, C].sort());
    expect([...x]).toEqual([[A, 'alice.dash']]);
    expect(new Map(y)).toEqual(new Map([[A, 'alice.dash'], [B, 'bob.dash']]));
  });

  it('caches answers, "no name" included', async () => {
    const p = platform([dom(A, 'alice', 1)]);
    const r = createDpnsResolver(p.query);
    await r.names([A, C]);
    expect(await r.names([A, C])).toEqual(new Map([[A, 'alice.dash']]));
    expect(p.calls).toHaveLength(1);
  });

  it('splits a large batch into chunks', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `id${i}`);
    const p = platform(ids.map((id, i) => dom(id, `name${i}`, i)));
    const r = createDpnsResolver(p.query, { chunk: 3 });
    const m = await r.names(ids);
    expect(p.calls.map((c) => c.ids.length)).toEqual([3, 3, 1]);
    expect(m.get('id6')).toBe('name6.dash');
  });

  it('pages through an identity with many names and still picks its first registered one', async () => {
    const docs = Array.from({ length: 9 }, (_, i) => dom(A, `nm${i}`, 1000 - i));
    const p = platform(docs);
    const r = createDpnsResolver(p.query, { limit: 4 });
    expect((await r.names([A])).get(A)).toBe('nm8.dash');
    expect(p.calls.map((c) => c.startAfter)).toEqual([undefined, docs[3]!.$id, docs[7]!.$id]);
  });

  it('an identity holding more names than the pages allow does not leave the others in its chunk unnamed', async () => {
    const [lo, hi] = [A, B].sort() as [string, string]; // `lo` comes first in records.identity order
    const p = platform([...Array.from({ length: 10 }, (_, i) => dom(lo, `many${i}`, 50 + i)), dom(hi, 'later', 1)]);
    const r = createDpnsResolver(p.query, { limit: 2, maxPages: 2 });
    const m = await r.names([lo, hi]);
    expect(m.get(hi)).toBe('later.dash');
    expect(m.get(lo)).toMatch(/^many\d\.dash$/);
    expect(p.calls.at(-1)!.ids).toEqual([hi]);
  });

  it('a failed read is not remembered: the next ask reads again', async () => {
    const p = platform([dom(A, 'alice', 1)]);
    const query = vi.fn<DomainQuery>().mockRejectedValueOnce(new Error('DAPI down')).mockImplementation(p.query);
    const r = createDpnsResolver(query);
    await expect(r.names([A])).rejects.toThrow('DAPI down');
    expect(await r.names([A])).toEqual(new Map([[A, 'alice.dash']]));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('answers what it could read when only some chunks failed', async () => {
    const p = platform([dom(A, 'alice', 1), dom(B, 'bob', 1)]);
    const query: DomainQuery = async (ids, page) => (ids.includes(B) ? Promise.reject(new Error('timeout')) : p.query(ids, page));
    const r = createDpnsResolver(query, { chunk: 1 });
    expect(await r.names([A, B])).toEqual(new Map([[A, 'alice.dash']]));
  });

  it('asks for nothing when given nothing', async () => {
    const p = platform([]);
    expect(await createDpnsResolver(p.query).names([])).toEqual(new Map());
    expect(p.calls).toHaveLength(0);
  });
});
