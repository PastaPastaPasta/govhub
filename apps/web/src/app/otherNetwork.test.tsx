// @vitest-environment happy-dom
// A proposal link opened on the wrong network: Governance asks the other network before saying "not found", and leads with opening
// it there when it is.
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, render } from '../test/render.tsx';

const other = vi.hoisted(() => ({ byName: async (_n: string): Promise<unknown[]> => [], proposal: async (_h: string): Promise<unknown> => null }));
const app = { mode: 'live', registry: { profile: 'testnet', forum: { claimPortals: [] } }, source: { byName: async () => [], proposal: async () => null } };
vi.mock('./context.tsx', () => ({ useApp: () => app }));
vi.mock('../config/registry.ts', async (orig) => ({ ...(await orig<typeof import('../config/registry.ts')>()), registryForProfile: (_r: unknown, id: string) => ({ profile: id }) }));
vi.mock('../data/repo.ts', () => ({ createSource: () => other }));
const { ProposalByHash, ProposalByName } = await import('../pages/ProposalPage.tsx');

const at = (path: string, el: ReactElement, route: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={el} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  other.byName = async () => [];
  other.proposal = async () => null;
});

describe('a proposal that is not on this network', () => {
  it('is on the other one: says so, and opening it there is the primary action, with the same link', async () => {
    let asked = '';
    other.byName = async (n) => ((asked = n), [{ value: { name: n } }]);
    const r = await at('/p/DCG-Operations?network=testnet', <ProposalByName />, '/p/:name');
    await flush();
    expect(asked).toBe('DCG-Operations');
    expect(r.el.querySelector('h1')!.textContent).toBe('This proposal isn’t on Testnet');
    const notice = r.el.querySelector('[data-testid="wrong-network-found"]')!;
    expect(notice.textContent).toContain('It’s on Mainnet.');
    expect(notice.textContent).toContain('Testnet has no proposal named “DCG-Operations”.');
    const open = notice.querySelector<HTMLAnchorElement>('[data-testid="wrong-network-open"]')!;
    expect(open.className).toContain('dh-btn--primary');
    expect(open.getAttribute('href')).toBe('/p/DCG-Operations?network=mainnet');
    expect(r.el.textContent).not.toContain('may not have published it yet');
  });

  it('says it is checking while the other network answers, never "not found" first', async () => {
    let answer!: (v: unknown[]) => void;
    other.byName = () => new Promise((res) => (answer = res));
    const r = await at('/p/x-y?network=testnet', <ProposalByName />, '/p/:name');
    expect(r.el.querySelector('[data-testid="wrong-network-checking"]')!.textContent).toContain('Checking whether it’s on Mainnet');
    expect(r.el.querySelector('h1')!.textContent).toBe('No proposal here on Testnet');
    answer([]);
    await flush();
    expect(r.el.querySelector('h1')!.textContent).toBe('Proposal not found');
    expect(r.el.querySelector('[data-testid="wrong-network-absent"]')!.textContent).toContain('Mainnet has none either. If it was submitted in the last few minutes');
  });

  it('offers to look when the other network could not be asked, without claiming either way', async () => {
    other.proposal = async () => Promise.reject(new Error('unreachable'));
    const hash = 'ab'.repeat(32);
    const r = await at(`/p/h/${hash}?network=testnet`, <ProposalByHash />, '/p/h/:hash');
    await flush();
    const notice = r.el.querySelector('[data-testid="wrong-network-unknown"]')!;
    expect(notice.textContent).toContain('Mainnet couldn’t be checked just now, so it may be there.');
    expect(notice.querySelector('[data-testid="wrong-network-look"]')!.getAttribute('href')).toBe(`/p/h/${hash}?network=mainnet`);
  });
});
