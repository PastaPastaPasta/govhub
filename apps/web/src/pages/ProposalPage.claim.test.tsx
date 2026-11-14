// @vitest-environment happy-dom
// Where the ownership claim goes: in "About this proposal" when the proposal is known to be unclaimed, in the sidebar otherwise,
// nowhere until the owner is settled, and never moved afterwards (a moved form would lose what the reader typed).
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal, Sourced } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import { render, type } from '../test/render.tsx';

const hold = vi.hoisted(() => ({
  own: { verdict: null as unknown, loading: true, error: null as string | null },
  collateral: { verdict: null as unknown, error: null as string | null },
}));
vi.mock('../app/context.tsx', () => ({
  useApp: () => ({
    source: { now: () => 0, bridgeDescriptor: () => null },
    gov: { cycle: { data: null }, bridgeTallies: new Map() },
    params: GOV_PARAMS.mainnet,
    checks: { state: () => ({ status: 'passed' }) },
  }),
}));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null }) }));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => ({ status: 'closed' }) }));
vi.mock('../ui/Discussion.tsx', () => ({ Discussion: ({ composerNote }: { composerNote?: string }) => <p data-testid="note">{composerNote ?? ''}</p> }));
vi.mock('../ui/ReadError.tsx', () => ({ ReadError: () => null }));
vi.mock('../ui/trust/TrustBadge.tsx', () => ({ TrustBadge: () => null }));
vi.mock('../ui/trust/VerificationDrawer.tsx', () => ({ VerificationDrawer: () => null }));
vi.mock('../ui/VotePanel.tsx', () => ({ OfflineSign: () => null, ProposalVotePanel: () => null }));
vi.mock('../ui/Ownership.tsx', () => ({
  // a stand-in with state of its own, so a remount shows as a lost signature
  ClaimPanel: () => {
    const [sig, setSig] = useState('');
    return <textarea data-testid="claim" value={sig} onChange={(e) => setSig(e.target.value)} />;
  },
  OwnerPost: () => null,
  OwnerValue: () => null,
  RejectedClaims: () => null,
  useOwnership: () => hold.own,
  useOwnerPost: () => ({ state: null }),
}));
vi.mock('../ui/trust/useProposalTrust.ts', () => ({
  useProposalTrust: () => ({ aggregate: { level: 'verified', reason: null }, collateral: hold.collateral, chain: { report: null, error: null, unavailable: false }, funded: null }),
}));
vi.mock('../ui/hooks.ts', async (orig) => ({ ...(await orig<typeof import('../ui/hooks.ts')>()), useAsync: () => ({ data: new Map(), loading: false }) }));

const { ProposalView } = await import('./ProposalPage.tsx');

const sp: Sourced<Proposal> = {
  value: { govHash: 'aa', parentHash: '0'.repeat(64), revision: 1, time: 0, dataHex: '', name: 'p', url: '', paymentAddress: 'X', paymentAmount: 1e8, startEpoch: 0, endEpoch: 1, collateralTxid: 'aa', collateralHeight: 0 },
  prov: { kind: 'proof', source: 'test' },
};
const page = () => (
  <MemoryRouter>
    <ProposalView sp={sp} />
  </MemoryRouter>
);
const about = (el: HTMLElement) => el.querySelector('.p-about [data-testid="claim"]') as HTMLTextAreaElement | null;
const side = (el: HTMLElement) => el.querySelector('.p-side [data-testid="claim"]') as HTMLTextAreaElement | null;
const owner = { owner: { identityId: 'id', method: 3 } };

describe('claim panel placement', () => {
  it('waits for the owner read and the collateral check, then stays put through a recheck and a late owner', async () => {
    hold.own = { verdict: null, loading: true, error: null };
    hold.collateral = { verdict: null, error: null };
    const { el, rerender } = await render(page());
    expect(el.querySelectorAll('[data-testid="claim"]')).toHaveLength(0);

    hold.own = { verdict: { owner: null }, loading: false, error: null };
    await rerender(page());
    expect(el.querySelectorAll('[data-testid="claim"]')).toHaveLength(0); // collateral still pending

    hold.collateral = { verdict: { ok: true }, error: null };
    await rerender(page());
    expect(about(el)).not.toBeNull();
    expect(side(el)).toBeNull();
    expect(el.querySelector('[data-testid="note"]')!.textContent).toContain("Only the proposal's owner can write the description");
    await type(about(el)!, 'H6Ld8vS0');

    hold.collateral = { verdict: null, error: null }; // a recheck clears the verdict
    await rerender(page());
    hold.own = { verdict: owner, loading: false, error: null }; // then reveals a method-3 owner
    hold.collateral = { verdict: { ok: true }, error: null };
    await rerender(page());
    expect(about(el)?.value).toBe('H6Ld8vS0');
    expect(side(el)).toBeNull();
    expect(el.querySelector('[data-testid="note"]')!.textContent).toBe('');
  });

  it('goes in the sidebar when the proposal has an owner, or the claims could not be read', async () => {
    for (const own of [{ verdict: owner, loading: false, error: null }, { verdict: { owner: null }, loading: false, error: 'read failed' }]) {
      hold.own = own;
      hold.collateral = { verdict: null, error: 'no DAPI' };
      const { el, unmount } = await render(page());
      expect(side(el)).not.toBeNull();
      expect(about(el)).toBeNull();
      await unmount();
    }
  });
});
