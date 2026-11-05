// @vitest-environment happy-dom
// "Vote on this proposal": the way to sign follows what the visitor has (keyring, keys pasted for this tab, or nothing: offline), a
// masternode carried in with ?mn= stays the one voting, and pasted keys sign here, are wiped, and leave only signed votes.
import { recoverVoteSigner, type Network } from '@govhub/verify';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../../data/types.ts';
import type { OwnedMasternode } from '../../voting/masternodes.ts';
import { votingKeyInfos } from '../../voting/masternodes.ts';
import { button, click, flush, render } from '../../test/render.tsx';

const PRO = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const KEY = new Uint8Array(32).fill(7);
const MN: OwnedMasternode = { proTxHash: PRO, collateralTxid: 'ee'.repeat(32), collateralIndex: 0, type: 'evo', valid: true, votingAddress: 'Xvote', keyIndex: 0, provenance: { key: 'sml', collateral: 'protx' } };
const P: Proposal = { govHash: '12'.repeat(32), parentHash: '0'.repeat(64), revision: 1, time: 1, dataHex: '', name: 'dash-thing', url: '', paymentAddress: 'X', paymentAmount: 1e8, startEpoch: 1, endEpoch: 2e9, collateralTxid: 'aa'.repeat(32), collateralHeight: 1 };

const hold = vi.hoisted(() => ({
  keyring: {} as Record<string, unknown>,
  guest: {} as Record<string, unknown>,
  session: null as unknown,
  wiped: 0,
  submitted: [] as Array<Record<string, unknown>>,
  bridge: (async () => null) as () => Promise<unknown>,
}));
vi.mock('../../voting/KeyringContext.tsx', () => ({ useKeyring: () => hold.keyring }));
vi.mock('../../contests/GuestKeys.tsx', () => ({ useGuestKeys: () => hold.guest }));
vi.mock('../../app/forum.tsx', () => ({ useForum: () => ({ session: hold.session }) }));
const APP = vi.hoisted(() => ({ registry: { coreNetwork: 'mainnet' } }));
vi.mock('../../app/context.tsx', () => ({ useApp: () => APP }));
vi.mock('../SignIn.tsx', () => ({ openSignIn: () => {} }));
vi.mock('./VoteTracker.tsx', () => ({ VoteTracker: ({ vote }: { vote: { outcome: number } }) => <p data-testid="tracker">{`tracked ${vote.outcome}`}</p> }));
vi.mock('./useMasternodeVotes.ts', () => ({
  useMasternodeVotes: (proTx: string) => ({ lookup: { kind: 'found', height: 1, mn: { ...MN, proTxHash: proTx } }, cells: new Map([[P.govHash, { kind: 'none' }]]) }),
}));
vi.mock('../VotePanel.tsx', async (orig) => ({
  ...(await orig<typeof import('../VotePanel.tsx')>()),
  OfflineSignBody: ({ address, outcome }: { address: string; outcome: number }) => <p data-testid="offline">{`offline ${address} ${outcome}`}</p>,
  OfflineSign: () => null,
  VoteComposer: ({ onlyMn }: { onlyMn?: string }) => <p data-testid="composer">{`composer ${onlyMn ?? 'all'}`}</p>,
  bridgeVotesFor: () => hold.bridge(),
}));

const { ProposalVoteBlock } = await import('./VoteBlock.tsx');

const keyring = (o: Record<string, unknown> = {}) => ({
  status: 'signed-out', mns: { owned: [], phase: 'idle' }, watched: [], relays: ['https://relay.test'], relayHealth: {}, coreNetwork: 'mainnet' as Network, busy: null, error: null, demo: false,
  submitSigned: async (v: Record<string, unknown>) => void hold.submitted.push(v),
  ...o,
});
const noGuest = { status: 'empty', owned: [], keyInfos: [], error: null, add: async () => {}, forget: () => {}, copyKeys: () => null };
const pasted = () => ({
  ...noGuest,
  status: 'ready',
  owned: [MN],
  keyInfos: votingKeyInfos([{ privateKey: KEY, compressed: true, label: '' }]),
  copyKeys: () => {
    const copy = { privateKey: KEY.slice(), compressed: true };
    return { keyOf: () => copy, ownerOf: () => MN, wipe: () => (copy.privateKey.fill(0), hold.wiped++) };
  },
});

const view = (mn: string | null = null) =>
  render(
    <MemoryRouter initialEntries={[`/p/dash-thing${mn ? `?mn=${mn}` : ''}`]}>
      <ProposalVoteBlock proposal={P} mn={mn} closesIn={86400 * 12} onVerify={() => {}} />
    </MemoryRouter>,
  );
const pick = (el: HTMLElement, label: string) => click([...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!);

beforeEach(() => {
  hold.keyring = keyring();
  hold.guest = noGuest;
  hold.session = null;
  hold.wiped = 0;
  hold.submitted = [];
  hold.bridge = async () => null;
});

describe('Vote on this proposal', () => {
  it('signed out with nothing: Yes / No / Abstain first, then offline signing for that choice (no account, no key)', async () => {
    const r = await view();
    expect(r.el.querySelector('h2')?.textContent).toBe('Vote on this proposal');
    expect(r.el.textContent).toContain('Voting closes in 12 days');
    expect([...r.el.querySelectorAll('[data-way]')].map((b) => b.textContent)).toEqual(['Sign offline', 'Paste key', 'Account']);
    expect(r.el.querySelector('[data-testid="offline"]')).toBeNull();
    await pick(r.el, 'No');
    expect(r.el.querySelector('[data-testid="offline"]')?.textContent).toBe('offline  2');
    await r.unmount();
  });

  it('carries the masternode from ?mn=: its line, its voting address for offline signing, and the way back to its votes', async () => {
    const r = await view(OTHER);
    expect(r.el.querySelector('[data-testid="vote-mn-context"]')?.textContent).toContain('evonode, its vote counts 4 times');
    expect(r.el.querySelector('[data-testid="vote-mn-back"]')?.getAttribute('href')).toBe(`/masternodes/${OTHER}`);
    await pick(r.el, 'Yes');
    expect(r.el.querySelector('[data-testid="offline"]')?.textContent).toBe('offline Xvote 1');
    await r.unmount();
  });

  it('signed in: no pasted keys (signing in wipes them), and the keyring composer once it holds the masternode', async () => {
    hold.session = { identityId: 'me' };
    hold.keyring = keyring({ status: 'locked' });
    let r = await view();
    expect([...r.el.querySelectorAll('[data-way]')].map((b) => b.textContent)).toEqual(['Sign offline', 'Account']);
    expect(r.el.querySelector('[data-way="account"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(r.el.querySelector('[data-testid="vote-keyring-link"]')?.textContent).toBe('Unlock your keyring');
    await r.unmount();
    hold.keyring = keyring({ status: 'open', mns: { owned: [MN], phase: 'done' } });
    r = await view(PRO);
    expect(r.el.querySelector('[data-testid="composer"]')?.textContent).toBe(`composer ${PRO}`);
    await r.unmount();
  });

  it('pasted keys: signs the chosen vote here with a copy that is wiped, and hands only the signed vote to the relay path', async () => {
    hold.guest = pasted();
    const r = await view(PRO);
    expect(r.el.querySelector('[data-testid="vote-pasted"]')).not.toBeNull();
    expect((r.el.querySelector('[data-testid="vote-send"]') as HTMLButtonElement).disabled).toBe(true);
    await pick(r.el, 'Abstain');
    const send = button(r.el, /Vote Abstain with 1 masternode/);
    await click(send);
    await flush();
    expect(hold.wiped).toBe(1);
    expect(hold.submitted).toHaveLength(1);
    const v = hold.submitted[0]!;
    expect(v).toMatchObject({ proTxHash: PRO, govHash: P.govHash, outcome: 3, network: 'mainnet', weight: 4 });
    expect(Object.keys(v)).not.toContain('privateKey');
    // the signature is by the pasted key over exactly this vote
    const signer = recoverVoteSigner(v.sig as string, { collateralTxid: MN.collateralTxid, collateralIndex: 0, govHashDisplay: P.govHash, signal: 1, outcome: 3, time: v.time as number }, 'mainnet');
    expect(signer && Buffer.from(signer.keyId).toString('hex')).toBe(votingKeyInfos([{ privateKey: KEY, compressed: true, label: '' }])[0]!.keyId);
    await r.unmount();
  });

  it('pasted keys: one send at a time, and nothing is signed when the keys change while the bridge answers', async () => {
    hold.guest = pasted();
    let answer!: (v: null) => void;
    hold.bridge = () => new Promise((r) => (answer = r));
    const tree = () => (
      <MemoryRouter initialEntries={[`/p/dash-thing?mn=${PRO}`]}>
        <ProposalVoteBlock proposal={P} mn={PRO} closesIn={86400} onVerify={() => {}} />
      </MemoryRouter>
    );
    const r = await render(tree());
    await flush();
    answer(null);
    await flush();
    await pick(r.el, 'Yes');
    const send = r.el.querySelector<HTMLButtonElement>('[data-testid="vote-send"]')!;
    await click(send);
    expect(send.disabled).toBe(true);
    expect(send.textContent).toBe('Signing and sending…');
    await click(send); // ignored while the first one runs
    hold.guest = pasted(); // pasted again (new key infos) while the bridge is slow
    await r.rerender(tree());
    answer(null);
    await flush();
    expect(hold.submitted).toHaveLength(0);
    expect(hold.wiped).toBe(0); // never copied
    expect(r.el.textContent).toContain('The pasted keys or the network changed meanwhile, so nothing was signed.');
    await r.unmount();
  });

  it('pasted keys: "Now" is the bridge\'s vote; one of ours still on its way shows as sent, and the same choice is not sent twice', async () => {
    hold.guest = pasted();
    hold.keyring = keyring({ watched: [{ proTxHash: PRO, collateralTxid: MN.collateralTxid, collateralIndex: 0, govHash: P.govHash, outcome: 1, time: 100, releaseAt: 100, sig: '', voteHash: 'ff'.repeat(32), refs: [], status: 'held', rebroadcasts: 0, signedAt: 100 }] });
    const r = await view(PRO);
    await flush();
    expect(r.el.querySelector('[data-testid="current-vote"]')?.textContent).toContain('Not voted');
    expect(r.el.querySelector('[data-testid="pending-vote"]')?.textContent).toContain('Yes');
    await pick(r.el, 'Yes');
    await click(r.el.querySelector<HTMLButtonElement>('[data-testid="vote-send"]')!);
    await flush();
    expect(hold.submitted).toHaveLength(0);
    expect(r.el.textContent).toContain('the Yes vote you sent is still on its way');
    await r.unmount();
  });

  it('pasted keys for another masternode than ?mn=: back to the ways to sign, saying so', async () => {
    hold.guest = pasted();
    const r = await view(OTHER);
    expect(r.el.querySelector('[data-testid="vote-pasted"]')).toBeNull();
    await click(r.el.querySelector<HTMLButtonElement>('[data-way="paste"]')!);
    expect(r.el.querySelector('[data-testid="vote-paste"]')?.textContent).toContain('That key votes for other masternodes');
    await r.unmount();
  });
});
