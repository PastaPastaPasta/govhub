// @vitest-environment happy-dom
// A masternode link opened on the wrong network: the other network's bridge is asked, but only once it says it serves that network.
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GOV_PARAMS } from '../lib/governance.ts';
import { flush, render } from '../test/render.tsx';

const PRO = 'aa'.repeat(32);
const hold = vi.hoisted(() => ({ statusNet: 'mainnet', mainnetList: [] as unknown[], asked: [] as string[] }));
vi.mock('../data/bridgeFactory.ts', () => ({
  makeBridge: (d: { base: string }) => ({
    // this network (Testnet) has no such masternode; the other network's bridge answers with hold's
    mnlist: async () => (hold.asked.push(`mnlist ${d.base}`), d.base === 'https://mainnet.bridge' ? { height: 9, listHash: 'x', masternodes: hold.mainnetList } : { height: 7, listHash: 'y', masternodes: [] }),
    status: async () => (hold.asked.push(`status ${d.base}`), { network: hold.statusNet }),
    votes: async () => ({ votes: [] }),
  }),
}));
// one app value, as the real provider memoizes it (a new registry every render would be a new network to ask)
const app = vi.hoisted(() => ({
  mode: 'live',
  activeRows: { shown: [], lameDucks: [], failed: [] },
  gov: { active: { data: [], loading: false }, cycle: { loading: false } },
  params: null as unknown,
  registry: { profile: 'testnet', coreNetwork: 'testnet', platformNetwork: 'testnet' },
  source: { now: () => 1_793_000_000, bridgeDescriptor: () => ({ kind: 'http', name: 'testnet', base: 'https://testnet.bridge' }) },
}));
vi.mock('../app/context.tsx', () => ({ useApp: () => app }));
vi.mock('../config/registry.ts', async (orig) => ({ ...(await orig<typeof import('../config/registry.ts')>()), registryForProfile: (_r: unknown, id: string) => ({ profile: id, coreNetwork: id }) }));
vi.mock('../data/repo.ts', () => ({ createSource: () => ({ bridgeDescriptor: () => ({ kind: 'http', name: 'mainnet', base: 'https://mainnet.bridge' }) }) }));
vi.mock('../lib/ownerPages.ts', async (orig) => ({ ...(await orig<typeof import('../lib/ownerPages.ts')>()), useOwnerPage: () => null, useOwnerPages: () => new Map() }));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => ({ status: 'signed-out', mns: { owned: [] } }) }));
vi.mock('../ui/SignIn.tsx', () => ({ openSignIn: () => {} }));

app.params = GOV_PARAMS.testnet;
const { MasternodePage } = await import('./MasternodePage.tsx');
const page = () => (
  <MemoryRouter initialEntries={[`/masternodes/${PRO}?network=testnet`]}>
    <Routes>
      <Route path="/masternodes/:proTx" element={<MasternodePage />} />
    </Routes>
  </MemoryRouter>
);
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

beforeEach(() => {
  (window as unknown as { dashhq: unknown }).dashhq = { href: (_p: string, path: string, o?: { network?: string }) => `https://radar.test${path}?network=${o?.network ?? 'mainnet'}` };
  hold.statusNet = 'mainnet';
  hold.mainnetList = [];
  hold.asked = [];
});

describe('a masternode that is not on this network', () => {
  it('is found in the other network’s list, and Radar’s link follows it there', async () => {
    hold.mainnetList = [{ proTxHash: PRO }];
    const r = await render(page());
    await settle();
    const nf = r.el.querySelector('[data-testid="mn-absent"] dashhq-not-found')!;
    expect(nf.getAttribute('found')).toBe('mainnet');
    expect(nf.getAttribute('thing')).toBe('masternode');
    expect(nf.querySelector('dashhq-hash')!.getAttribute('value')).toBe(PRO);
    expect(r.el.querySelector('.dh-page-header__kicker')!.textContent).toBe('Masternode');
    expect(hold.asked).toEqual(expect.arrayContaining(['status https://mainnet.bridge', 'mnlist https://mainnet.bridge']));
    const radar = [...r.el.querySelectorAll<HTMLAnchorElement>('[data-testid="mn-absent"] a')].find((a) => a.textContent!.startsWith('Its record in Radar'))!;
    expect(radar.textContent).toBe('Its record in Radar (Mainnet)');
    expect(radar.getAttribute('href')).toBe(`https://radar.test/mn/${PRO}?network=mainnet`);
    await r.unmount();
  });

  it('is on neither when the other list hasn’t it either', async () => {
    const r = await render(page());
    await settle();
    expect(r.el.querySelector('[data-testid="mn-absent"] dashhq-not-found')!.getAttribute('found')).toBe('none');
    await r.unmount();
  });

  it('never trusts a data service that says it serves another network: it couldn’t check', async () => {
    hold.statusNet = 'testnet';
    hold.mainnetList = [{ proTxHash: PRO }];
    const r = await render(page());
    await settle();
    expect(r.el.querySelector('[data-testid="mn-absent"] dashhq-not-found')!.getAttribute('found')).toBe('unknown');
    expect(hold.asked).not.toContain('mnlist https://mainnet.bridge');
    await r.unmount();
  });
});
