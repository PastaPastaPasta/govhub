// @vitest-environment happy-dom
// The sender: what a held vote becomes for each Platform answer, and that only votes still to send are stored.
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../test/render.tsx';
import { storageKey, type HeldVote } from './held.ts';
import type { ContestSource } from './source.ts';

const hold = vi.hoisted(() => ({ src: null as unknown as ContestSource, forum: { session: null as null | { identityId: string } } }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ registry: { platformNetwork: 'testnet' } }) }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => hold.forum }));
vi.mock('./useContests.ts', () => ({ useContestSource: () => hold.src }));
const { ContestVotesProvider, useContestVotes } = await import('./ContestVotes.tsx');

type Api = ReturnType<typeof useContestVotes>;
let api!: Api;
function Probe() {
  api = useContestVotes();
  return null;
}
const wait = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));

const vote = (over: Partial<HeldVote> = {}): HeldVote => ({
  id: crypto.randomUUID(),
  network: 'testnet',
  label: 'a1pha',
  proTxHash: 'p1',
  voterId: 'V1',
  owner: 'guest',
  choice: { kind: 'lock' },
  st: 'AQID',
  nonce: '1',
  mode: 'now',
  releaseAt: Date.now(),
  endsAt: null,
  status: 'waiting',
  tries: 0,
  ...over,
});

function fakeSource(over: Partial<ContestSource> = {}) {
  const broadcast = vi.fn(async (_st: Uint8Array) => {});
  const src = {
    network: 'testnet',
    live: true,
    broadcast,
    forget: vi.fn(),
    state: vi.fn(async () => ({ label: 'a1pha', contenders: [], abstain: 0, lock: 1, total: 1, outcome: null, height: 1 })),
    votesOf: vi.fn(async () => new Map()),
    ...over,
  } as unknown as ContestSource;
  hold.src = src;
  return { src, broadcast: (over.broadcast as typeof broadcast | undefined) ?? broadcast };
}

const stored = (live = true) => JSON.parse(localStorage.getItem(storageKey(live, 'testnet')) ?? '[]') as HeldVote[];
const mount = async () => {
  const r = await render(
    <ContestVotesProvider>
      <Probe />
    </ContestVotesProvider>,
  );
  await wait();
  return r;
};

beforeEach(() => {
  localStorage.clear();
  hold.forum = { session: null };
});

describe('the contest vote sender', () => {
  it('sends a "now" vote at once and keeps nothing stored once it is accepted', async () => {
    const { broadcast } = fakeSource();
    const r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect([...broadcast.mock.calls[0]![0]]).toEqual([1, 2, 3]);
    expect(api.held.find((v) => v.id === 'a')!.status).toBe('sent');
    expect(stored()).toEqual([]);
    await r.unmount();
  });

  it('keeps a vote Platform could not be reached for, and tries again later', async () => {
    fakeSource({ broadcast: vi.fn(async () => Promise.reject(new Error('network down'))) });
    const r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    const v = api.held.find((x) => x.id === 'a')!;
    expect(v.status).toBe('waiting');
    expect(v.tries).toBe(1);
    expect(v.nextTryAt).toBeGreaterThan(Date.now());
    expect(v.note).toBe('network down');
    expect(stored().map((x) => x.id)).toEqual(['a']);
    await r.unmount();
  });

  it('drops a vote Platform refuses for good, with the reason', async () => {
    fakeSource({ broadcast: vi.fn(async () => Promise.reject({ code: 40302, message: 'closed' })) });
    const r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    expect(api.held.find((x) => x.id === 'a')).toMatchObject({ status: 'failed', note: 'Voting on this name had closed.' });
    expect(stored()).toEqual([]);
    await r.unmount();
  });

  it('after a used nonce, reads the vote back: counted when it is this choice, else says so', async () => {
    fakeSource({ broadcast: vi.fn(async () => Promise.reject({ code: 40204, message: 'nonce' })), votesOf: vi.fn(async () => new Map([['V1', { kind: 'lock' as const }]])) });
    let r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    expect(api.held.find((x) => x.id === 'a')!.status).toBe('sent');
    await r.unmount();
    localStorage.clear();
    fakeSource({ broadcast: vi.fn(async () => Promise.reject({ code: 40204, message: 'nonce' })), votesOf: vi.fn(async () => new Map([['V1', { kind: 'abstain' as const }]])) });
    r = await mount();
    await act(async () => api.add([vote({ id: 'b' })]));
    await wait();
    expect(api.held.find((x) => x.id === 'b')).toMatchObject({ status: 'failed', note: 'This masternode voted from somewhere else meanwhile. Vote again to replace that vote.' });
    await r.unmount();
  });

  it('holds a spread-out vote until its time, sends it on request, and a cancelled one never goes', async () => {
    const { broadcast } = fakeSource();
    const r = await mount();
    const later = Date.now() + 3_600_000;
    await act(async () => api.add([vote({ id: 'a', mode: 'spread', releaseAt: later }), vote({ id: 'b', proTxHash: 'p2', voterId: 'V2', mode: 'spread', releaseAt: later })]));
    await wait();
    expect(broadcast).not.toHaveBeenCalled();
    expect(stored().map((x) => x.id).sort()).toEqual(['a', 'b']);
    await act(async () => api.cancel('b'));
    await act(async () => api.sendNow(['a']));
    await wait();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(api.held.map((x) => [x.id, x.status])).toEqual([['a', 'sent']]);
    expect(stored()).toEqual([]);
    await r.unmount();
  });

  it('replaces a waiting vote of the same masternode on the same name (it never went out)', async () => {
    fakeSource();
    const r = await mount();
    const later = Date.now() + 3_600_000;
    await act(async () => api.add([vote({ id: 'a', mode: 'spread', releaseAt: later })]));
    await act(async () => api.add([vote({ id: 'b', mode: 'spread', releaseAt: later, choice: { kind: 'abstain' } })]));
    expect(stored().map((x) => x.id)).toEqual(['b']);
    await r.unmount();
  });

  it('sends nothing in demo mode', async () => {
    const { broadcast } = fakeSource({ live: false });
    const r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    expect(broadcast).not.toHaveBeenCalled();
    expect(api.held[0]).toMatchObject({ status: 'sent', note: 'Demo data: nothing was sent.' });
    await r.unmount();
  });

  it('picks up votes another tab stored', async () => {
    fakeSource();
    const r = await mount();
    const v = vote({ id: 'other', mode: 'spread', releaseAt: Date.now() + 3_600_000 });
    localStorage.setItem(storageKey(true, 'testnet'), JSON.stringify([v]));
    await act(async () => dispatchEvent(new StorageEvent('storage', { key: storageKey(true, 'testnet') })));
    expect(api.held.map((x) => x.id)).toEqual(['other']);
    await r.unmount();
  });
  it('shows a reader only their own votes, though it sends every stored one', async () => {
    const { broadcast } = fakeSource();
    hold.forum = { session: { identityId: 'ALICE' } };
    const r = await mount();
    await act(async () => api.add([vote({ id: 'theirs', owner: 'BOB' }), vote({ id: 'mine', owner: 'ALICE', proTxHash: 'p2', voterId: 'V2' })]));
    await wait();
    expect(api.held.map((x) => x.id)).toEqual(['mine']);
    expect(broadcast).toHaveBeenCalledTimes(2);
    await r.unmount();
  });

  it('never cancels or replaces a vote another tab is sending', async () => {
    fakeSource();
    const r = await mount();
    const busy = vote({ id: 'busy', status: 'sending', sendingSince: Date.now(), mode: 'spread', releaseAt: Date.now() + 3_600_000 });
    localStorage.setItem(storageKey(true, 'testnet'), JSON.stringify([busy]));
    await act(async () => api.cancel('busy'));
    await act(async () => api.add([vote({ id: 'new', mode: 'spread', releaseAt: Date.now() + 3_600_000 })]));
    expect(stored().map((x) => [x.id, x.status])).toEqual([
      ['busy', 'sending'],
      ['new', 'waiting'],
    ]);
    await r.unmount();
  });

  it('when a used nonce cannot be checked, it tries again rather than telling the operator to vote again', async () => {
    fakeSource({ broadcast: vi.fn(async () => Promise.reject({ code: 40204, message: 'nonce already present at tip' })), votesOf: vi.fn(async () => Promise.reject(new Error('offline'))) });
    const r = await mount();
    await act(async () => api.add([vote({ id: 'a' })]));
    await wait();
    expect(api.held.find((x) => x.id === 'a')).toMatchObject({ status: 'waiting', tries: 1, note: 'Checking whether this vote counts…' });
    await r.unmount();
  });

  it('keeps demo votes apart from real ones', async () => {
    fakeSource({ live: false });
    const r = await mount();
    await act(async () => api.add([vote({ id: 'demo', mode: 'spread', releaseAt: Date.now() + 3_600_000 })]));
    expect(stored(false).map((x) => x.id)).toEqual(['demo']);
    expect(stored(true)).toEqual([]);
    await r.unmount();
  });
});
