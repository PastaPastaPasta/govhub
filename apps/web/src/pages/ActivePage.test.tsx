// @vitest-environment happy-dom
// The Active list with a lame duck among the proposals: it leaves the main list and the counts, and sits in a collapsed section at
// the end with a neutral state in place of the funding bars.
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { LAME_DUCK_EXPLAINER } from '../ui/LameDuck.tsx';
import { button, click, flush, render, type } from '../test/render.tsx';
import type { ActiveRows } from '../app/context.tsx';

const hold = vi.hoisted(() => ({ ctx: null as unknown, keyring: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => hold.ctx }));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => hold.keyring }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ forum: { reader: { profiles: async () => new Map() } } }) }));
vi.mock('../ui/useCommentCounts.ts', () => ({ useCommentCounts: () => new Map() }));
vi.mock('../ui/BudgetHeader.tsx', () => ({ BudgetHeader: () => null }));

const { ActivePage } = await import('./ActivePage.tsx');

const DAY = 86400;
const NOW = Date.UTC(2026, 9, 25) / 1000;
const prov = { kind: 'proof', source: 'test' } as const;
const cycle: Sourced<Cycle> = { value: { superblockHeight: 1, budget: 6000e8, allocated: 250e8, votingDeadlineHeight: 0, estTime: NOW + 23 * DAY, validWeighted: 3320, paid: 0 }, prov };
const proposal = (govHash: string, name: string, over: Partial<Proposal>): Sourced<Proposal> => ({
  value: { govHash, parentHash: '0'.repeat(64), revision: 1, time: 0, dataHex: '', name, url: '', paymentAddress: 'XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62', paymentAmount: 100e8, startEpoch: 0, endEpoch: 2e9, collateralTxid: govHash, collateralHeight: 0, ...over },
  prov,
});
const tally = (govHash: string, over: Partial<Tally> = {}): Sourced<Tally> => ({
  value: { govHash, asOfHeight: 100, yesWeighted: 400, noWeighted: 20, abstainWeighted: 0, yesCount: 300, noCount: 20, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget: false, margin: 0, ...over },
  prov,
});

function setup(): { rows: ActiveRows } {
  const tallies = new Map([
    ['live', tally('live', { inNextBudget: true })],
    ['multi', tally('multi')],
    ['duck', tally('duck')],
  ]);
  const derive = (p: Sourced<Proposal>) => ({ item: deriveRow(p, tallies, new Map(), cycle, GOV_PARAMS.mainnet, NOW), check: { status: 'passed' } as never });
  const live = derive(proposal('live', 'live-one', { startEpoch: NOW - 2 * DAY, endEpoch: NOW + 40 * DAY }));
  // partly paid, with a payment still to come: stays in the main list with its normal state
  const multi = derive(proposal('multi', 'partly-paid', { startEpoch: NOW - 40 * DAY, endEpoch: NOW + 60 * DAY }));
  // the pshenmic proposal: one payment, paid, the next superblock is after it ends
  const duck = derive(proposal('duck', 'pshenmic-dev-dash-desktop-november-2026', { startEpoch: Date.UTC(2026, 8, 29) / 1000, endEpoch: Date.UTC(2026, 9, 27, 12) / 1000 }));
  expect(duck.item.lameDuck).toBe(true);
  expect(multi.item.lameDuck).toBe(false);
  const rows: ActiveRows = { shown: [live, multi], lameDucks: [duck], failed: [] };
  hold.keyring = { status: 'signed-out', mns: { owned: [] }, watched: [], currentVotes: async () => new Map() };
  hold.ctx = {
    gov: { active: { loading: false }, cycle: { data: cycle } },
    activeRows: rows,
    registry: { forum: { claimPortals: [] } },
    params: GOV_PARAMS.mainnet,
    source: { scope: 'test', bridgeDescriptor: () => null, now: () => NOW },
  };
  return { rows };
}

let at = '';
function Where() {
  const l = useLocation();
  at = l.search;
  return null;
}
const page = (url = '/') => (
  <MemoryRouter initialEntries={[url]}>
    <ActivePage />
    <Where />
  </MemoryRouter>
);
const titles = (el: ParentNode) => [...el.querySelectorAll('[data-testid="proposal-card"] .prow-title a')].map((a) => a.textContent);
// each card's exact on-chain name (its title reads it as words)
const slugs = (el: ParentNode) => [...el.querySelectorAll('[data-testid="proposal-card"] [data-testid="card-slug"]')].map((x) => x.textContent!.split(' · ')[0]);

describe('ActivePage with a lame duck', () => {
  it('lists it only in a collapsed section after the live proposals', async () => {
    setup();
    const { el } = await render(page());
    expect(titles(el)).toEqual(['Live one', 'Partly paid']); // the names as words; the exact names are under them
    expect([...el.querySelectorAll('[data-testid="card-slug"]')].map((x) => x.textContent)).toEqual(['live-one', 'partly-paid']);
    const toggle = el.querySelector('[data-testid="toggle-lameduck"]') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Finished, still on the network (1)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).toContain(LAME_DUCK_EXPLAINER);
    expect(LAME_DUCK_EXPLAINER).toContain('They drop off the network when they end.');
    expect(el.textContent).not.toContain('pshenmic');
    // the section comes after the live list
    const list = el.querySelector('.plist')!;
    const section = el.querySelector('[data-testid="lameduck-section"]')!;
    expect(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a neutral state, with no bars or budget tags, once opened', async () => {
    setup();
    const { el } = await render(page());
    await click(button(el, /Finished, still on the network/));
    const section = el.querySelector('[data-testid="lameduck-section"]')!;
    const card = section.querySelector('[data-testid="proposal-card"]') as HTMLElement;
    expect(card.dataset.lameduck).toBe('true');
    expect(card.textContent).toContain('pshenmic-dev-dash-desktop-november-2026');
    expect(card.textContent).toContain('No more payments possible');
    expect(card.textContent).toContain('Ends 27 Oct 2026');
    expect(card.textContent).not.toMatch(/Passing by|In the next budget|Not in the next budget|payments left|final payment/);
    expect(card.querySelector('.fund, [role="meter"], meter, progress')).toBeNull();
    expect(card.className).toContain('prow-ended');
    // the live cards keep theirs
    const live = el.querySelector('[data-govhash="live"]') as HTMLElement;
    expect(live.textContent).toContain('In the next budget');
    expect(el.querySelector('[data-govhash="multi"]')!.textContent).toContain('Not in the next budget');
    expect(el.querySelector('[data-govhash="multi"]')!.textContent).toMatch(/payments left/);
    // and it closes again
    await click(button(el, /Finished, still on the network/));
    expect(el.querySelector('[data-testid="lameduck-section"] [data-testid="proposal-card"]')).toBeNull();
  });

  it('has no section when nothing is a lame duck', async () => {
    const { rows } = setup();
    (hold.ctx as { activeRows: ActiveRows }).activeRows = { ...rows, lameDucks: [] };
    const { el } = await render(page());
    expect(el.querySelector('[data-testid="lameduck-section"]')).toBeNull();
  });
});

describe('ActivePage search, filter and sort', () => {
  /** live-one (passing, 100 DASH), partly-paid (passing, 300 DASH), cheap-and-failing (10 DASH), and the lame duck */
  function setupMany() {
    const { rows } = setup();
    const tallies = new Map([['weak', tally('weak', { yesWeighted: 10, noWeighted: 50 })]]);
    const weak = { item: deriveRow(proposal('weak', 'cheap-and-failing', { startEpoch: NOW - DAY, endEpoch: NOW + 20 * DAY, paymentAmount: 10e8, url: 'https://example.org/bob-proposal' }), tallies, new Map(), cycle, GOV_PARAMS.mainnet, NOW), check: { status: 'passed' } as never };
    rows.shown[1]!.item.p.value.paymentAmount = 300e8;
    (hold.ctx as { activeRows: ActiveRows }).activeRows = { ...rows, shown: [...rows.shown, weak] };
  }
  const chip = (el: ParentNode, name: RegExp) => [...el.querySelectorAll<HTMLLabelElement>('.list-chip')].find((l) => name.test(l.textContent ?? ''))!;

  it('filters by status from the URL, with counts on the chips and a way back', async () => {
    setupMany();
    const { el } = await render(page('/?status=failing'));
    expect(slugs(el)).toEqual(['cheap-and-failing']);
    expect(chip(el, /^All/).textContent).toBe('All 3');
    expect(chip(el, /^Passing/).textContent).toBe('Passing 2');
    expect(chip(el, /^Not passing/).className).toContain('on');
    // a status filter leaves the finished proposals out
    expect(el.querySelector('[data-testid="lameduck-section"]')).toBeNull();
    expect(el.querySelector('[data-testid="list-count"]')!.textContent).toContain('1 of 3 proposals');
    await click(el.querySelector<HTMLButtonElement>('[data-testid="list-clear"]')!);
    expect(at).toBe('');
    expect(slugs(el)).toEqual(['live-one', 'partly-paid', 'cheap-and-failing']);
  });

  it('search matches name or URL words in any order, writes ?q= and says when nothing matches', async () => {
    setupMany();
    const { el } = await render(page());
    const input = el.querySelector<HTMLInputElement>('[data-testid="list-search"]')!;
    expect(input.closest('label')!.textContent).toContain('Search active proposals');
    await type(input, 'proposal bob');
    expect(at).toBe('?q=proposal+bob');
    expect(slugs(el)).toEqual(['cheap-and-failing']);
    await type(input, 'pshenmic');
    // only a finished proposal matches: its section opens by itself
    expect(slugs(el)).toEqual(['pshenmic-dev-dash-desktop-november-2026']);
    await type(input, 'nothing-like-this');
    expect(el.querySelector('[data-testid="list-no-matches"]')!.textContent).toContain('No proposals match “nothing-like-this”');
    await click(button(el.querySelector('[data-testid="list-no-matches"]')!, /Clear filters/));
    expect(input.value).toBe('');
    expect(slugs(el)).toEqual(['live-one', 'partly-paid', 'cheap-and-failing']);
  });

  it('sorts by amount and says what order the list is in', async () => {
    setupMany();
    const { el } = await render(page('/?sort=amount'));
    expect(slugs(el)).toEqual(['partly-paid', 'live-one', 'cheap-and-failing']);
    expect(el.textContent).toContain('Largest payment requested first.');
    const select = el.querySelector<HTMLSelectElement>('[data-testid="list-sort"]')!;
    expect(select.value).toBe('amount');
  });

  it('"Not voted yet" only for a signed-in masternode owner, and hides what their masternodes voted on', async () => {
    setupMany();
    const { el } = await render(page('/?unvoted=1'));
    // signed out: no chip, and the filter in the URL changes nothing
    expect(el.querySelector('[data-testid="filter-unvoted"]')).toBeNull();
    expect(slugs(el)).toEqual(['live-one', 'partly-paid', 'cheap-and-failing']);

    const mn = { collateralTxid: 'CC', collateralIndex: 0 };
    const currentVotes = vi.fn(async () => new Map([[`cc-0|live`, { outcome: 1, time: 1 }]]));
    hold.keyring = { status: 'open', mns: { owned: [mn] }, watched: [{ govHash: 'weak', collateralTxid: 'cc', collateralIndex: 0, status: 'queued', refs: [] }], currentVotes };
    const { el: el2 } = await render(page('/?unvoted=1'));
    await flush();
    expect(el2.querySelector<HTMLInputElement>('[data-testid="filter-unvoted"]')!.checked).toBe(true);
    // live: voted on the network; weak: a vote on its way
    expect(slugs(el2)).toEqual(['partly-paid']);
    expect(currentVotes).toHaveBeenCalledWith(['live', 'multi', 'weak', 'duck']);
  });
});
