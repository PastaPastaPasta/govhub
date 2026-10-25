// @vitest-environment happy-dom
// Switching network profile (or ending the session) while the keyring is open: the keyring zeroes its keys synchronously, and one
// more render still runs with the old keyring object. The page must render from the keys' public info, never derive from a private
// key (noble throws `invalid scalar: out of range` for the all-zero key).
import { emptyKeyring, type OpenedKeyring } from '@govhub/auth';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import { render } from '../test/render.tsx';
import { votingAddressOfInfo, votingKeyInfos, ZeroedKeyError } from '../voting/masternodes.ts';
import type { useKeyring } from '../voting/KeyringContext.tsx';

type Ctx = ReturnType<typeof useKeyring>;
const hold = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => hold.ctx }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: () => {} }) }));
vi.mock('../ui/vote/VotesList.tsx', () => ({ VotesList: () => null }));
vi.mock('../ui/SignIn.tsx', () => ({ openSignIn: () => {} }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ registry: { platformNetwork: 'testnet' }, mode: 'fixtures' }) }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null }) }));
vi.mock('../badge/context.tsx', () => ({
  useBadgeCtx: () => ({ contractId: '', trust: [], reader: null, jobs: [], coreHeight: null, privacy: 'standard', setPrivacy: () => {}, requestBadge: async () => ({}), removeJob: () => {}, retryJob: () => {} }),
  useBadges: () => ({ byOwner: new Map(), live: false, loading: false }),
}));

const { MasternodesPage } = await import('./MasternodesPage.tsx');

function openKeyring(): OpenedKeyring {
  const ring = emptyKeyring('9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', []);
  ring.content.keys.push({ privateKey: fixtureMnKey(1).slice(), compressed: true, label: 'rack 1' }, { privateKey: fixtureMnKey(2).slice(), compressed: true, label: '' });
  return ring;
}

function ctxFor(keyring: OpenedKeyring, coreNetwork: 'mainnet' | 'testnet'): Ctx {
  return {
    status: 'open',
    error: null,
    needsTopUp: false,
    demo: true,
    memoryOnly: false,
    keyring,
    keyInfos: votingKeyInfos(keyring.content.keys), // derived while the keys are live, as the provider does
    busy: null,
    mns: { phase: 'ready', owned: [], missing: [], mismatch: [], smlNodes: 0, forKeys: '' },
    coreNetwork,
    refreshMasternodes: () => {},
  } as unknown as Ctx;
}

// a new element each time: React skips re-rendering the very same element
const page = () => (
  <MemoryRouter>
    <MasternodesPage />
  </MemoryRouter>
);

describe('MasternodesPage with a wiped keyring', () => {
  it('lists the keys from their public info', async () => {
    const ring = openKeyring();
    hold.ctx = ctxFor(ring, 'mainnet');
    const r = await render(page());
    const groups = [...r.el.querySelectorAll('[data-testid="key-group"]')];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain('rack 1');
    expect(groups[1]!.textContent).toContain('Voting key 2');
    await r.unmount();
  });

  it('re-renders with the stale, zeroed keyring (session end or profile switch) without throwing, and formats the address per network', async () => {
    const ring = openKeyring();
    const ctx = ctxFor(ring, 'mainnet');
    hold.ctx = ctx;
    const r = await render(page());
    const mainnet = [...r.el.querySelectorAll('.visually-hidden')].map((e) => e.textContent);
    expect(mainnet).toHaveLength(2);

    ring.close(); // the keys are zero now, synchronously; the old keyring object is still what the next render gets
    expect(ring.content.keys.every((k) => k.privateKey.every((b) => b === 0))).toBe(true);
    await r.rerender(page());
    hold.ctx = { ...ctx, coreNetwork: 'testnet' };
    await r.rerender(page());

    const testnet = [...r.el.querySelectorAll('.visually-hidden')].map((e) => e.textContent);
    expect(testnet).toEqual(ctx.keyInfos.map((i) => votingAddressOfInfo(i, 'testnet')));
    expect(testnet).not.toEqual(mainnet);
    await r.unmount();
  });
});

describe('votingKeyInfos', () => {
  it('refuses a wiped key with a typed error', () => {
    const ring = openKeyring();
    ring.close();
    expect(() => votingKeyInfos(ring.content.keys)).toThrow(ZeroedKeyError);
  });
});
