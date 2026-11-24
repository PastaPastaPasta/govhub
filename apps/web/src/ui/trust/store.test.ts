import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VotesDone } from '../../verify/protocol.ts';
import { recountKey, sharedRecount, sharedRun, type VotesRequest } from './store.ts';

const runVerification = vi.hoisted(() => vi.fn());
vi.mock('../../verify/client.ts', () => ({ runVerification, VERIFIER_BUILD: 'build-1' }));


const req = (over: Partial<VotesRequest> = {}): VotesRequest => ({
  kind: 'votes', govHash: 'aa'.repeat(32), bridge: { kind: 'http', name: 'b', base: 'https://b' }, dapi: { kind: 'recorded' }, network: 'mainnet', now: 1, crossCheckSml: true,
  targets: [{ name: 'Platform tally', tally: { asOfHeight: 100, voteSetHash: 'ff', yesWeighted: 10, noWeighted: 2, abstainWeighted: 0 } as never }],
  ...over,
});
const done = (n: number): VotesDone => ({ id: n, kind: 'votes', bridge: 'b', runs: [], sml: null });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe('the shared vote recount', () => {
  beforeEach(() => {
    runVerification.mockReset();
    vi.stubGlobal('sessionStorage', memoryStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is keyed by everything its answer depends on, the full tallies included (not the clock)', () => {
    expect(recountKey('s', req())).toBe(recountKey('s', req({ now: 999 })));
    for (const other of [req({ govHash: 'bb'.repeat(32) }), req({ crossCheckSml: false }), req({ dapi: { kind: 'live', cfg: {} as never } })]) expect(recountKey('s', other)).not.toBe(recountKey('s', req()));
    const t = req().targets[0]!;
    expect(recountKey('s', req({ targets: [{ ...t, tally: { ...t.tally, yesWeighted: 11 } }] }))).not.toBe(recountKey('s', req()));
    expect(recountKey('other', req())).not.toBe(recountKey('s', req()));
  });

  it('runs once for the same proposal and tallies, reuses it (also from this tab\'s storage), and again on "Re-check"', async () => {
    runVerification.mockResolvedValue(done(1));
    const scope = `t1-${Math.random()}`;
    const a = sharedRecount(scope, req());
    const b = sharedRecount(scope, req({ now: 2 }));
    expect(await a).toEqual(done(1));
    expect(await b).toEqual(done(1));
    expect(runVerification).toHaveBeenCalledTimes(1);

    const stored = [...Array(sessionStorage.length).keys()].map((i) => sessionStorage.key(i)!).filter((k) => k.startsWith('govhub:recount:'));
    expect(stored).toHaveLength(1);

    runVerification.mockResolvedValue(done(2));
    expect(await sharedRecount(scope, req(), { force: true })).toEqual(done(2));
    expect(runVerification).toHaveBeenCalledTimes(2);
  });

  it('a recount stored by this tab survives a reload of the module state; a stale or foreign entry is ignored', async () => {
    runVerification.mockResolvedValue(done(3));
    const scope = `t2-${Math.random()}`;
    await sharedRecount(scope, req());
    vi.resetModules();
    const fresh = await import('./store.ts');
    runVerification.mockClear();
    expect(await fresh.sharedRecount(scope, req())).toEqual(done(3));
    expect(runVerification).not.toHaveBeenCalled();

    const k = [...Array(sessionStorage.length).keys()].map((i) => sessionStorage.key(i)!).find((x) => x.startsWith('govhub:recount:'))!;
    const e = JSON.parse(sessionStorage.getItem(k)!);
    sessionStorage.setItem(k, JSON.stringify({ ...e, at: Date.now() - 11 * 60_000 }));
    vi.resetModules();
    const again = await import('./store.ts');
    runVerification.mockResolvedValue(done(4));
    expect(await again.sharedRecount(scope, req())).toEqual(done(4));
    expect(runVerification).toHaveBeenCalledTimes(1);
  });

  it('a recount kept by another build of the verifier is not reused', async () => {
    runVerification.mockResolvedValue(done(6));
    const scope = `t4-${Math.random()}`;
    await sharedRecount(scope, req());
    vi.resetModules();
    vi.doMock('../../verify/client.ts', () => ({ runVerification, VERIFIER_BUILD: 'build-2' }));
    const next = await import('./store.ts');
    runVerification.mockClear().mockResolvedValue(done(7));
    expect(await next.sharedRecount(scope, req())).toEqual(done(7));
    expect(runVerification).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../verify/client.ts');
  });

  it('a failed recount is not kept', async () => {
    runVerification.mockRejectedValueOnce(new Error('signature check crashed')).mockResolvedValue(done(5));
    const scope = `t3-${Math.random()}`;
    await expect(sharedRecount(scope, req())).rejects.toThrow('crashed');
    expect(await sharedRecount(scope, req())).toEqual(done(5));
  });
});

describe('a shared run the nodes held up', () => {
  it('waits and tries again on its own, telling every caller it is not yet checked, then is kept', async () => {
    const runs = new Map();
    let n = 0;
    const start = vi.fn(async () => {
      if (++n < 3) throw new Error('rate limited: all 4 node attempts failed: HTTP 429');
      return 'ranked';
    });
    const said: string[] = [];
    const retry = { delays: [1, 1, 1], sleep: async () => {} };
    expect(await sharedRun(runs, 'k', 'The funding order', start, { onProgress: (m) => said.push(m), retry })).toBe('ranked');
    expect(start).toHaveBeenCalledTimes(3);
    expect(said).toEqual(Array(2).fill("The funding order isn't checked in this browser yet: the Dash network's nodes are busy; trying again in a moment"));
    expect(await sharedRun(runs, 'k', 'The funding order', start)).toBe('ranked');
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('a caller whose signal is already aborted does not count as waiting', async () => {
    const runs = new Map();
    const start = vi.fn(async () => { throw new Error('rate limited: HTTP 429'); });
    const gone = new AbortController();
    gone.abort();
    await expect(sharedRun(runs, 'k', 'The vote count', start, { signal: gone.signal, retry: { delays: [1], sleep: async () => {} } })).rejects.toThrow('rate limited');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once every caller has gone, and is not kept', async () => {
    const runs = new Map();
    const start = vi.fn(async () => { throw new Error('rate limited: HTTP 429'); });
    const a = new AbortController(), b = new AbortController();
    const retry = { delays: [1, 1, 1], sleep: async () => { a.abort(); b.abort(); } };
    const p = sharedRun(runs, 'k', 'The vote count', start, { signal: a.signal, retry });
    void sharedRun(runs, 'k', 'The vote count', start, { signal: b.signal, retry }).catch(() => {});
    await expect(p).rejects.toThrow('rate limited');
    expect(start).toHaveBeenCalledTimes(1);
    expect(runs.has('k')).toBe(false);
  });
});
