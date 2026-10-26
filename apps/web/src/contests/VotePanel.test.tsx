// @vitest-environment happy-dom
// The contest vote panel with an open keyring: the nonce each vote is signed with, masternodes that already vote this way left out,
// key copies wiped after signing, a locked keyring refused, and no voting where Core and Platform differ.
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, flush, render } from '../test/render.tsx';
import type { HeldVote } from './held.ts';
import type { ContestState } from './model.ts';

const KEY1 = new Uint8Array(32).fill(1);
const KEY2 = new Uint8Array(32).fill(2);
const hold = vi.hoisted(() => ({
  k: null as unknown,
  app: { registry: { coreNetwork: 'testnet', platformNetwork: 'testnet' } } as unknown,
  held: [] as unknown[],
  add: null as unknown as (v: unknown[]) => void,
  signed: [] as Array<{ privateKey: Uint8Array; nonce: bigint; proTxHash: string }>,
  src: null as unknown,
}));
vi.mock('@dashevo/evo-sdk', () => ({}));
vi.mock('../app/context.tsx', () => ({ useApp: () => hold.app }));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => hold.k }));
vi.mock('./ContestVotes.tsx', () => ({ useContestVotes: () => ({ held: hold.held, add: (v: unknown[]) => hold.add(v), cancel: vi.fn(), sendNow: vi.fn() }) }));
vi.mock('./useContests.ts', () => ({ useContestSource: () => hold.src }));
vi.mock('./vote.ts', async (orig) => ({
  ...(await orig<typeof import('./vote.ts')>()),
  signVote: (_mod: unknown, _net: unknown, v: { privateKey: Uint8Array; nonce: bigint; proTxHash: string }) => {
    hold.signed.push({ privateKey: v.privateKey, nonce: v.nonce, proTxHash: v.proTxHash });
    return new Uint8Array([7]);
  },
}));
const { ContestVotePanel } = await import('./VotePanel.tsx');
const { votingKeyHash, voterIdOf } = await import('./vote.ts');

const PRO1 = 'a'.repeat(64);
const PRO2 = 'b'.repeat(64);
const mn = (proTxHash: string, keyIndex: number, type: 'regular' | 'evo' = 'regular') => ({ proTxHash, collateralTxid: proTxHash, collateralIndex: 0, type, valid: true, votingAddress: 'y', keyIndex, provenance: { key: 'sml', outpoint: 'protx' } });
const V1 = voterIdOf(PRO1, votingKeyHash(KEY1));
const V2 = voterIdOf(PRO2, votingKeyHash(KEY2));
const C = 'eUJLdV1mRNVYAMdHYV3nSiwKu2EBB1jGfVKUuCDeUE2';
const state: ContestState = { label: 'a1pha', contenders: [{ identityId: C, votes: 3, requested: 'Alpha' }], abstain: 0, lock: 1, total: 4, outcome: null, height: 1 };

let added: HeldVote[];
beforeEach(() => {
  const keys = [{ privateKey: KEY1.slice(), compressed: true, label: 'k1' }, { privateKey: KEY2.slice(), compressed: true, label: 'k2' }];
  hold.k = {
    status: 'open',
    demo: false,
    error: null,
    keyring: { content: { keys, labels: [] } },
    keyInfos: [KEY1, KEY2].map((k) => ({ keyId: '', pubKeyHash: votingKeyHash(k), compressed: true, label: '' })),
    mns: { phase: 'ready', owned: [mn(PRO1, 0), mn(PRO2, 1, 'evo')] },
  };
  hold.app = { registry: { coreNetwork: 'testnet', platformNetwork: 'testnet' } };
  hold.held = [];
  hold.signed = [];
  added = [];
  hold.add = (v) => void added.push(...(v as HeldVote[]));
  hold.src = {
    live: true,
    // MN2 already votes Lock; MN1 has not voted
    votesOf: vi.fn(async () => new Map([[V1, null], [V2, { kind: 'lock' }]])),
    nonceOf: vi.fn(async (v: string) => (v === V1 ? 4n : 9n)),
  };
});

const mount = () =>
  render(
    <MemoryRouter>
      <ContestVotePanel label="a1pha" state={state} endsAt={Date.now() + 86_400_000} nameOf={() => 'Alpha owner'} />
    </MemoryRouter>,
  );
const pick = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll<HTMLLabelElement>('.cvote-opt')].find((l) => text.test(l.textContent ?? ''))!.querySelector('input')!;

describe('ContestVotePanel', () => {
  it('signs one vote per masternode with the next nonce, past any vote this browser still holds, and wipes the key copies', async () => {
    // a vote of MN1 on another name waits here with nonce 6: the new one takes 7, not Platform's 4 + 1
    hold.held = [{ id: 'x', voterId: V1, label: 'other', status: 'waiting', nonce: '6', network: 'testnet', proTxHash: PRO1, choice: { kind: 'lock' } }];
    const { el } = await mount();
    await flush();
    await click(pick(el, /Alpha owner/));
    expect(el.querySelector('[data-testid="vote-send"]')!.textContent).toBe('Sign and send 2 votes');
    await click(el.querySelector<HTMLButtonElement>('[data-testid="vote-send"]')!);
    await flush();
    expect(hold.signed.map((s) => [s.proTxHash, s.nonce])).toEqual([
      [PRO1, 7n],
      [PRO2, 10n],
    ]);
    // the copies handed to signing are zero now; the keyring's own keys are untouched
    for (const s of hold.signed) expect(s.privateKey.every((b) => b === 0)).toBe(true);
    expect((hold.k as { keyring: { content: { keys: { privateKey: Uint8Array }[] } } }).keyring.content.keys[0]!.privateKey).toEqual(KEY1);
    expect(added.map((v) => [v.proTxHash, v.weight, v.mode, v.nonce, v.st])).toEqual([
      [PRO1, 1, 'now', '7', 'Bw=='],
      [PRO2, 4, 'now', '10', 'Bw=='],
    ]);
  });

  it('leaves out a masternode that already votes this way', async () => {
    const { el } = await mount();
    await flush();
    await click(pick(el, /^Lock/));
    expect(el.querySelector('[data-testid="vote-send"]')!.textContent).toBe('Sign and send 1 vote');
    await click(el.querySelector<HTMLButtonElement>('[data-testid="vote-send"]')!);
    await flush();
    expect(hold.signed.map((s) => s.proTxHash)).toEqual([PRO1]);
  });

  it('refuses to sign with a wiped key (the keyring locked meanwhile)', async () => {
    const { el } = await mount();
    await flush();
    await click(pick(el, /Abstain/));
    // the lock zeroes the keyring's keys in place
    for (const k of (hold.k as { keyring: { content: { keys: { privateKey: Uint8Array }[] } } }).keyring.content.keys) k.privateKey.fill(0);
    await click(el.querySelector<HTMLButtonElement>('[data-testid="vote-send"]')!);
    await flush();
    expect(hold.signed).toEqual([]);
    expect(added).toEqual([]);
    expect(el.querySelector('[role="alert"]')!.textContent).toMatch(/wiped/);
  });

  it('points to My masternodes while the keyring is not open', async () => {
    (hold.k as { status: string }).status = 'locked';
    const { el } = await mount();
    expect(el.querySelector('[data-testid="vote-cta"]')!.textContent).toMatch(/Unlock your masternode keyring/);
  });

  it('does not offer voting where Core and Platform are different networks (the Dev profile)', async () => {
    hold.app = { registry: { coreNetwork: 'mainnet', platformNetwork: 'testnet' } };
    const { el } = await mount();
    expect(el.textContent).toMatch(/cannot vote here/);
    expect(el.querySelector('[data-testid="vote-send"]')).toBeNull();
  });
});
