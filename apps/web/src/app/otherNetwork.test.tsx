// @vitest-environment happy-dom
// A proposal link opened on the wrong network: Governance asks the other network before saying "not found", and leads with opening
// it there when it is.
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, render } from '../test/render.tsx';

const other = vi.hoisted(() => ({ byName: async (_n: string): Promise<unknown[]> => [], proposal: async (_h: string): Promise<unknown> => null }));
const app = { mode: 'live', registry: { profile: 'testnet', coreNetwork: 'testnet', forum: { claimPortals: [] } }, source: { byName: async () => [], proposal: async () => null } };
vi.mock('./context.tsx', () => ({ useApp: () => app }));
vi.mock('../config/registry.ts', async (orig) => ({ ...(await orig<typeof import('../config/registry.ts')>()), registryForProfile: (_r: unknown, id: string) => ({ profile: id, coreNetwork: id }) }));
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
  const notice = (el: HTMLElement) => el.querySelector('dashhq-not-found')!;

  it('is on the other one: the family notice says so (found="mainnet"), under the record’s own header', async () => {
    let asked = '';
    other.byName = async (n) => ((asked = n), [{ value: { name: n } }]);
    const r = await at('/p/DCG-Operations?network=testnet', <ProposalByName />, '/p/:name');
    await flush();
    expect(asked).toBe('DCG-Operations');
    expect(r.el.querySelector('.dh-page-header__kicker')!.textContent).toBe('Proposal');
    expect(r.el.querySelector('h1')!.textContent).toBe('DCG-Operations');
    const n = notice(r.el);
    expect(n.getAttribute('thing')).toBe('proposal');
    expect(n.getAttribute('id-label')).toBe('name');
    expect(n.getAttribute('network')).toBe('testnet');
    expect(n.getAttribute('found')).toBe('mainnet');
    expect(n.getAttribute('list-href')).toBe('/?network=testnet');
    expect(n.getAttribute('list-label')).toBe('Browse Testnet proposals');
    expect(n.textContent).toBe(''); // the shell writes the words; no sentence of ours unless it is on neither
  });

  it('is checking (no found attribute) while the other network answers, then on neither, with one sentence of ours', async () => {
    let answer!: (v: unknown[]) => void;
    other.byName = () => new Promise((res) => (answer = res));
    const r = await at('/p/x-y?network=testnet', <ProposalByName />, '/p/:name');
    expect(notice(r.el).hasAttribute('found')).toBe(false);
    answer([]);
    await flush();
    expect(notice(r.el).getAttribute('found')).toBe('none');
    expect(notice(r.el).textContent).toContain('once Governance’s bridge has published it');
  });

  it('says it couldn’t check when the other network can’t be asked, without claiming either way', async () => {
    other.proposal = async () => Promise.reject(new Error('unreachable'));
    const hash = 'ab'.repeat(32);
    const r = await at(`/p/h/${hash}?network=testnet`, <ProposalByHash />, '/p/h/:hash');
    await flush();
    expect(notice(r.el).getAttribute('found')).toBe('unknown');
    expect(notice(r.el).getAttribute('id-label')).toBe('hash');
  });
});
