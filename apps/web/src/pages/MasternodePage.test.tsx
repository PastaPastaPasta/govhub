// @vitest-environment happy-dom
// /masternodes/<protx>: every active proposal is a row at once; this masternode's vote fills in per row as the bridge answers, a row
// that can't be read says so (with Try again), and each row's action is offline signing with the voting address filled in.
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeMasternode, BridgeVote } from '../data/bridge.ts';
import { BridgeError } from '../data/bridge.ts';
import type { Proposal } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import type { Row } from '../lib/view.ts';
import { click, render } from '../test/render.tsx';
import { latestFundingVote } from '../ui/vote/useMasternodeVotes.ts';

const PRO = 'aa'.repeat(32);
const MN: BridgeMasternode = { proTxHash: PRO, collateralTxid: 'cc'.repeat(32), collateralIndex: 1, votingAddress: 'XvotingAddressXXXXXXXXXXXXXXXXXXXX', type: 'evo', valid: true };
const vote = (outcome: number, time: number, o: Partial<BridgeVote> = {}): BridgeVote => ({ collateralTxid: MN.collateralTxid, collateralIndex: 1, signal: 1, outcome, time, sig: '', ...o });

function proposal(i: number): Proposal {
  return { govHash: String(i).repeat(64).slice(0, 64), parentHash: '0'.repeat(64), revision: 1, time: 1, dataHex: '', name: `prop-${i}`, url: 'https://example.org', paymentAddress: 'X', paymentAmount: 100e8, startEpoch: 1_790_000_000, endEpoch: 1_800_000_000, collateralTxid: 'ee'.repeat(32), collateralHeight: 1 };
}
const rowOf = (p: Proposal): Row => ({ p: { value: p, prov: { kind: 'proof', source: 'test' } }, tally: null, platformTally: null, bridgeTally: null, absYes: null, threshold: null, state: null, schedule: null, lameDuck: false, startsLater: null, content: { ok: true } });

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

const hold = vi.hoisted(() => ({ mnlist: null as unknown, votes: new Map<string, unknown>(), proposals: [] as unknown[] }));
vi.mock('../data/bridgeFactory.ts', () => ({
  makeBridge: () => ({
    mnlist: () => (hold.mnlist as Deferred<unknown>).promise,
    votes: (h: string) => (hold.votes.get(h) as Deferred<unknown>).promise,
  }),
}));
vi.mock('../app/context.tsx', () => ({
  useApp: () => ({
    activeRows: { shown: (hold.proposals as Proposal[]).map((p) => ({ item: rowOf(p), check: { status: 'pending' } })), lameDucks: [], failed: [] },
    gov: { active: { data: (hold.proposals as Proposal[]).map((p) => ({ value: p, prov: { kind: 'proof', source: 'test' } })), loading: false }, cycle: { loading: false } },
    params: GOV_PARAMS.mainnet,
    registry: { coreNetwork: 'mainnet', platformNetwork: 'mainnet' },
    source: { now: () => 1_793_000_000, bridgeDescriptor: () => ({ kind: 'http', name: 'test', base: 'https://bridge.test' }) },
  }),
}));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => ({ status: 'signed-out', mns: { owned: [] } }) }));
vi.mock('../ui/SignIn.tsx', () => ({ openSignIn: () => {} }));
vi.mock('../ui/VotePanel.tsx', () => ({
  OfflineSign: ({ address, open }: { address: string; open?: boolean }) => <p data-testid="offline">{`offline ${address} ${open ? 'open' : ''}`}</p>,
  VoteComposer: () => <p data-testid="composer" />,
}));

const { MasternodePage } = await import('./MasternodePage.tsx');

const page = (path = `/masternodes/${PRO}`) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/masternodes/:proTx" element={<MasternodePage />} />
    </Routes>
  </MemoryRouter>
);
const flush = () => act(async () => {});
const cellText = (el: HTMLElement) => [...el.querySelectorAll('[data-testid="mn-vote"]')].map((c) => c.textContent?.trim() || '…');

describe('latestFundingVote', () => {
  it("takes this masternode's newest funding vote and ignores other outpoints and signals", () => {
    const votes = [vote(1, 10), vote(2, 30), vote(3, 40, { signal: 2 }), vote(3, 50, { collateralIndex: 0 }), vote(1, 20)];
    expect(latestFundingVote(votes, MN)).toEqual({ outcome: 2, time: 30 });
    expect(latestFundingVote(votes, { collateralTxid: 'dd'.repeat(32), collateralIndex: 1 })).toBeNull();
  });
});

describe('MasternodePage', () => {
  beforeEach(() => {
    hold.proposals = [proposal(1), proposal(2), proposal(3)];
    hold.mnlist = deferred();
    hold.votes = new Map((hold.proposals as Proposal[]).map((p) => [p.govHash, deferred()]));
  });

  it('lists every active proposal at once and fills in the votes as they arrive', async () => {
    const r = await render(page());
    expect(r.el.querySelectorAll('[data-testid="mn-vote-row"]')).toHaveLength(3);
    expect(r.el.querySelector('[data-testid="mn-facts"]')?.textContent).toContain('Finding it in the Mainnet masternode list');
    await act(async () => (hold.mnlist as Deferred<unknown>).resolve({ height: 5, listHash: 'x', masternodes: [MN] }));
    expect(r.el.querySelector('[data-testid="mn-facts"]')?.textContent).toContain('Evonode: each vote counts 4 times');
    expect(r.el.querySelector('[data-testid="mn-progress"]')?.textContent).toContain('0 of 3 read');

    const [a, b, c] = hold.proposals as Proposal[];
    await act(async () => (hold.votes.get(b!.govHash) as Deferred<unknown>).resolve({ votes: [vote(1, 1_792_000_000)] }));
    expect(cellText(r.el)).toEqual(['…', expect.stringContaining('Yes'), '…']);
    expect(r.el.querySelector('[data-testid="mn-progress"]')?.textContent).toContain('1 of 3 read');
    await act(async () => (hold.votes.get(a!.govHash) as Deferred<unknown>).reject(new BridgeError('none', 404)));
    await act(async () => (hold.votes.get(c!.govHash) as Deferred<unknown>).resolve({ votes: [vote(2, 1_792_000_000, { collateralIndex: 0 })] }));
    await flush();
    expect(cellText(r.el)).toEqual(['Not voted', expect.stringContaining('Yes'), 'Not voted']);
    expect(r.el.querySelector('[data-testid="mn-progress"]')?.textContent).toContain('not voted on 2, 1 yes');
    await r.unmount();
  });

  it("sends each row's Vote to the proposal's vote block as this masternode, and says it needs no account", async () => {
    const r = await render(page());
    await act(async () => (hold.mnlist as Deferred<unknown>).resolve({ height: 5, listHash: 'x', masternodes: [MN] }));
    const action = r.el.querySelector<HTMLAnchorElement>('a[data-testid="mn-vote-action"]')!;
    expect(action.textContent).toContain('Vote');
    expect(action.getAttribute('href')).toBe(`/p/prop-1?mn=${PRO}#vote`);
    expect(r.el.querySelector('[data-testid="mn-vote-row"] a')?.getAttribute('href')).toBe(`/p/prop-1?mn=${PRO}`);
    expect(r.el.querySelector('[data-testid="mn-ways"]')?.textContent).toContain('Neither needs an account');
    // a shared link, signed out: not "My masternodes"
    expect(r.el.querySelector('[data-testid="mn-crumbs"]')?.textContent).toBe('‹ Active proposals');
    await r.unmount();
  });

  it('says when the masternode is not in the list', async () => {
    const r = await render(page());
    await act(async () => (hold.mnlist as Deferred<unknown>).resolve({ height: 7, listHash: 'x', masternodes: [] }));
    const absent = r.el.querySelector('[data-testid="mn-absent"]')!.textContent;
    expect(absent).toContain('There’s no masternode with this ProTx hash here.');
    expect(absent).toContain("the governance bridge's masternode list, at block 7");
    expect(r.el.querySelector('[data-testid="mn-vote-row"]')).toBeNull();
    await r.unmount();
  });

  it('refuses something that is not a ProTx hash', async () => {
    const r = await render(page('/masternodes/nothex'));
    expect(r.el.querySelector('h1')?.textContent).toBe('Not a masternode');
    await r.unmount();
  });
});
