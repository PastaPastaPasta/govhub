// @vitest-environment happy-dom
// The treasury overview never shows a figure built from parts still being read: no sums while the votes are counted, no comparison
// while superblocks are read; once complete it says what each figure rests on.
import { superblockPaymentsLimit } from '@govhub/verify';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, Tally } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import type { SuperblockRead } from '../lib/ledger.ts';
import type { Row } from '../lib/view.ts';
import fixtures from '../lib/ledger.fixtures.json';
import { render } from '../test/render.tsx';

const prov = { kind: 'proof', source: 'test' } as const;
const row = (name: string, dash: number, inNextBudget: boolean, passing = inNextBudget): { item: Row } => ({
  item: {
    p: { value: { govHash: name, name, url: '', paymentAmount: dash * 1e8 } as Proposal, prov },
    tally: { value: { inNextBudget } as Tally, prov },
    state: { passing, margin: 10, needed: passing ? 0 : 10, light: passing ? 'pass' : 'fail' },
    lameDuck: false,
    startsLater: null,
    content: { ok: true },
  } as unknown as Row,
});
const hold = vi.hoisted(() => ({ app: null as unknown, slots: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => hold.app }));
vi.mock('../ui/useLedger.ts', () => ({ LEDGER_STEP: { mainnet: 12, testnet: 24 }, useLedger: () => ({ slots: hold.slots, unavailable: null, canLoadMore: false, loadMore() {}, retry() {} }) }));
vi.mock('../lib/ownerPages.ts', async (orig) => ({ ...(await orig<typeof import('../lib/ownerPages.ts')>()), useOwnerPages: () => new Map() }));
vi.mock('../ui/UsdValue.tsx', () => ({ UsdValue: () => null }));
const { TreasuryPage } = await import('./TreasuryPage.tsx');

const cb = fixtures as Record<string, SuperblockRead['outputs']>;
const LIMIT = Number(superblockPaymentsLimit(2575480, 'mainnet'));
const read = (height: number, time: number): SuperblockRead => ({ height, blockHash: '00', time, outputs: cb[String(height)]!, weak: null });

function app(talliesLoading: boolean) {
  return {
    gov: { cycle: { data: { value: { superblockHeight: 2575480, budget: LIMIT, allocated: 4892e8, votingDeadlineHeight: 2573200, estTime: 1_795_000_000, validWeighted: 3320, paid: 0 } }, loading: false }, active: { loading: false }, talliesLoading },
    source: { notice: null, coreNetwork: 'mainnet', now: () => 1_794_000_000 },
    params: GOV_PARAMS.mainnet,
    activeRows: { shown: [row('dcg', 4832, true), row('italia', 60, true), row('growth', 200, false, true), row('apac', 61, false)], lameDucks: [], failed: [] },
    checks: { state: () => ({ status: 'passed' }) },
  };
}
const view = () =>
  render(
    <MemoryRouter>
      <TreasuryPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  hold.slots = [
    { height: 2558864, state: 'read', read: read(2558864, 1792566848) },
    { height: 2542248, state: 'reading' },
  ];
});

describe('the treasury overview', () => {
  it('holds every sum while the votes are counted', async () => {
    hold.app = app(true);
    const { el } = await view();
    expect(el.querySelector('[data-testid="tr-budget"]')!.textContent).toMatch(/^6,82\d DASH$/); // the budget needs no votes
    expect(el.querySelector('[data-testid="tr-requested"]')!.textContent).toBe('counting…');
    expect(el.querySelector('[data-testid="tr-passing"]')!.textContent).toBe('counting…');
    expect(el.querySelector('[data-testid="tr-counting"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="tr-group-funded"]')).toBeNull();
  });

  it('groups what it pays for, says what each figure rests on, and compares only once every superblock is read', async () => {
    hold.app = app(false);
    const { el } = await view();
    expect(el.querySelector('[data-testid="tr-requested"]')!.textContent).toBe('5,153 DASH');
    expect(el.querySelector('[data-testid="tr-passing"]')!.textContent).toBe('5,092 DASH');
    expect([...el.querySelectorAll('[data-testid="tr-group-funded"] [data-testid="tr-row"] a')].map((a) => a.textContent)).toEqual(['Dcg', 'Italia']);
    expect(el.querySelector('[data-testid="tr-group-over"]')!.textContent).toContain('Passing, but over the budget');
    expect([...el.querySelectorAll('[data-proof]')].map((p) => p.textContent)).toEqual(expect.arrayContaining(['Consensus limit', 'Platform records', 'Bridge’s tally']));
    // one superblock still reading: progress, no average and no chart
    expect(el.querySelector('[data-testid="tr-compare-progress"]')!.textContent).toContain('1 of 2 so far');
    expect(el.querySelector('[data-testid="tr-compare-line"]')).toBeNull();
    expect(el.querySelector('[data-testid="tr-chart"]')).toBeNull();
  });

  it('compares this payout with the average of the superblocks read, from the chain', async () => {
    hold.app = app(false);
    hold.slots = [
      { height: 2558864, state: 'read', read: read(2558864, 1792566848) },
      { height: 2542248, state: 'read', read: read(2542248, 1789900000) },
    ];
    const { el } = await view();
    const line = el.querySelector('[data-testid="tr-compare-line"]')!.textContent!;
    expect(line).toContain('paid 6,102 DASH on average'); // (5,393 + 6,810) / 2, rounded
    expect(line).toContain('4,892 DASH, is 20% less than that');
    expect(line).toContain('Verified from the chain');
    expect(el.querySelectorAll('[data-testid="tr-chart"] .tr-col')).toHaveLength(3); // two superblocks and the next payout
  });
});

it('says when the bridge’s budget differs from the consensus limit', async () => {
  hold.app = app(false);
  (hold.app as ReturnType<typeof app>).gov.cycle.data.value.budget = 7000e8;
  const { el } = await view();
  expect(el.querySelector('[data-testid="treasury-stats"] [data-proof="reported"]')!.textContent).toMatch(/^Bridge’s figure; consensus says 6,82\d DASH$/);
});
