// @vitest-environment happy-dom
// The budget header's "N of M in the budget" counts over the tallies: none while they're read, "not known" when they couldn't be,
// and "at least" when some couldn't.
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal, Tally } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import type { Row } from '../lib/view.ts';
import { render } from '../test/render.tsx';

const prov = { kind: 'proof', source: 'test' } as const;
const row = (h: string, inNextBudget: boolean | null) => ({
  item: { p: { value: { govHash: h, name: h, paymentAmount: 100e8 } as Proposal, prov }, tally: inNextBudget === null ? null : { value: { inNextBudget } as Tally, prov }, lameDuck: false, startsLater: null } as unknown as Row,
  check: { status: 'passed' },
});
const hold = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => hold.app }));
vi.mock('./trust/ChainShield.tsx', () => ({ ChainShield: () => null }));
vi.mock('./UsdValue.tsx', () => ({ UsdValue: () => null }));
const { BudgetHeader } = await import('./BudgetHeader.tsx');

function app(gov: { talliesLoading?: boolean; talliesFailed?: boolean; untallied?: string[]; error?: string }) {
  return {
    gov: {
      cycle: { data: { value: { superblockHeight: 1, budget: 6828e8, allocated: 100e8, votingDeadlineHeight: 0, estTime: 2e9, validWeighted: 3320, paid: 0 } }, loading: false },
      active: gov.error ? { loading: false, error: gov.error } : { loading: false, data: [] },
      height: {},
      talliesLoading: !!gov.talliesLoading,
      talliesFailed: !!gov.talliesFailed,
      untallied: new Set(gov.untallied ?? []),
    },
    source: { now: () => 1e9, notice: null },
    params: GOV_PARAMS.mainnet,
    activeRows: { shown: [row('a', true), row('b', null), row('c', false)], lameDucks: [], failed: [] },
    reload: () => {},
  };
}
const inBudget = async (a: ReturnType<typeof app>) => {
  hold.app = a;
  const { el } = await render(
    <MemoryRouter>
      <BudgetHeader />
    </MemoryRouter>,
  );
  return el.querySelector('[data-testid="budget-in"]')!.textContent;
};

describe('BudgetHeader', () => {
  it('labels the feed threshold as an estimate and explains the proposal source', async () => {
    const a = app({});
    a.gov.cycle.data.value.validWeighted = 3330;
    hold.app = a;
    const { el } = await render(<MemoryRouter><BudgetHeader /></MemoryRouter>);
    const fact = [...el.querySelectorAll('.budget-facts > div')].find(d => d.querySelector('dt')?.textContent === 'To pass (feed estimate)')!;
    expect(fact.querySelector('dd')?.textContent).toContain('333 net yes votes');
    expect(el.textContent).toContain('Proposal pages use the masternode-list read when available');
  });
  it('counts once the tallies are in', async () => expect(await inBudget(app({}))).toBe('1 of 3 proposals'));
  it('says it is counting while they are read', async () => expect(await inBudget(app({ talliesLoading: true }))).toContain('counting the votes'));
  it('says it isn’t known when the votes couldn’t be read, or the proposals', async () => {
    expect(await inBudget(app({ talliesFailed: true }))).toBe('not known: the votes couldn’t be read');
    expect(await inBudget(app({ error: 'down' }))).toBe('not known: the proposals couldn’t be read');
  });
  it('is a lower bound when some votes weren’t read', async () => expect(await inBudget(app({ untallied: ['b'] }))).toBe('at least 1 of 3 proposals'));
});
