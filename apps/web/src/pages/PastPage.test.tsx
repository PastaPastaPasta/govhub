// @vitest-environment happy-dom
// The Past list's search and column sorting: anything but the default order reads every page from Platform first.
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { flush, render, type } from '../test/render.tsx';
import { act } from 'react';

const hold = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => hold.ctx }));

const { PastPage } = await import('./PastPage.tsx');

const prov = { kind: 'proof', source: 'test' } as const;
const proposal = (name: string, endEpoch: number, paymentAmount: number): Sourced<Proposal> => ({
  value: { govHash: name, parentHash: '0', revision: 1, time: 0, dataHex: '', name, url: `https://example.org/${name}`, paymentAddress: 'Xaddr', paymentAmount, startEpoch: 0, endEpoch, collateralTxid: name, collateralHeight: 0 },
  prov,
});
const tally = (govHash: string, yes: number): Sourced<Tally> => ({
  value: { govHash, asOfHeight: 1, yesWeighted: yes, noWeighted: 0, abstainWeighted: 0, yesCount: yes, noCount: 0, abstainCount: 0, voteSetHash: '', rank: 0, inNextBudget: false, margin: 0 },
  prov,
});

// two pages, newest end first, as Platform serves them
const PAGES = [
  [proposal('zeta-tools', 900, 5e8), proposal('alpha-docs', 800, 50e8)],
  [proposal('mid-outreach', 500, 20e8), proposal('beta-tools', 100, 1e8)],
];

function setup() {
  const pastPage = vi.fn(async (cursor?: string) => (cursor ? { items: PAGES[1]! } : { items: PAGES[0]!, next: 'p2' }));
  const yes: Record<string, number> = { 'zeta-tools': 10, 'alpha-docs': 400, 'mid-outreach': 50, 'beta-tools': 5 };
  hold.ctx = {
    source: { pastPage, tallies: async (hs: string[]) => new Map(hs.map((h) => [h, tally(h, yes[h]!)])) },
    checks: { subscribe: () => () => {}, getVersion: () => 0, state: () => ({ status: 'passed' }), ensure: () => () => {} },
    gov: { active: { data: [] } },
    activeRows: { shown: [] },
  };
  return { pastPage };
}

let at = '';
function Where() {
  at = useLocation().search;
  return null;
}
const page = (url = '/past') => (
  <MemoryRouter initialEntries={[url]}>
    <PastPage />
    <Where />
  </MemoryRouter>
);
const names = (el: ParentNode) => [...el.querySelectorAll('table.past tbody th a')].map((a) => a.textContent);
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

describe('PastPage search and sort', () => {
  it('lists Platform order by default and reads only the first page', async () => {
    const { pastPage } = setup();
    const { el } = await render(page());
    await settle();
    expect(names(el)).toEqual(['zeta-tools', 'alpha-docs']);
    expect(pastPage).toHaveBeenCalledTimes(1);
    expect(el.querySelector('th[aria-sort="descending"]')!.textContent).toContain('Ended');
  });

  it('a search reads every page and finds a match on the second', async () => {
    const { pastPage } = setup();
    const { el } = await render(page());
    await settle();
    await type(el.querySelector<HTMLInputElement>('[data-testid="list-search"]')!, 'tools');
    await settle();
    expect(pastPage).toHaveBeenCalledWith('p2');
    expect(names(el)).toEqual(['zeta-tools', 'beta-tools']);
    expect(at).toBe('?q=tools');
    expect(el.querySelector('[data-testid="list-count"]')!.textContent).toContain('2 of 4 past proposals');
    await type(el.querySelector<HTMLInputElement>('[data-testid="list-search"]')!, 'nope');
    expect(el.querySelector('[data-testid="list-no-matches"]')).not.toBeNull();
  });

  it('column headings sort, flip on a second click, and are kept in the URL', async () => {
    setup();
    const { el } = await render(page('/past?sort=yes'));
    await settle();
    expect(names(el)).toEqual(['alpha-docs', 'mid-outreach', 'zeta-tools', 'beta-tools']);
    const amount = el.querySelector<HTMLButtonElement>('[data-testid="sort-amount"]')!;
    await act(async () => amount.click());
    expect(at).toBe('?sort=amount');
    expect(names(el)).toEqual(['alpha-docs', 'mid-outreach', 'zeta-tools', 'beta-tools']);
    await act(async () => amount.click());
    expect(at).toBe('?sort=amount&dir=asc');
    expect(names(el)).toEqual(['beta-tools', 'zeta-tools', 'mid-outreach', 'alpha-docs']);
    expect(amount.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="sort-name"]')!.click());
    expect(at).toBe('?sort=name');
    expect(names(el)).toEqual(['alpha-docs', 'beta-tools', 'mid-outreach', 'zeta-tools']);
  });
});
