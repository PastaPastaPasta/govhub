// @vitest-environment happy-dom
// The username contest list and page on the fixture contests: open ones lead, ended ones are not read until their section is opened,
// a search narrows both, and a contest page shows every choice with its tally.
import { act, StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureContests, type ContestSource } from '../contests/source.ts';
import { button, click, flush, render, type } from '../test/render.tsx';

const NOW_S = Date.UTC(2026, 9, 23) / 1000;
vi.mock('../data/fixtures.ts', () => ({ loadFixtures: async () => ({ now: NOW_S }) }));
const hold = vi.hoisted(() => ({ src: null as unknown as ContestSource, shown: true }));
vi.mock('../contests/useContests.ts', () => ({
  useContestSource: () => hold.src,
  useContestsShown: () => hold.shown,
  useClockMs: () => NOW_S * 1000,
}));
const forum = vi.hoisted(() => ({
  forum: { names: async () => new Map([['eUJLdV1mRNVYAMdHYV3nSiwKu2EBB1jGfVKUuCDeUE2', 'alice.dash']]), reader: { profiles: async () => new Map() } },
}));
vi.mock('../app/forum.tsx', () => ({ useForum: () => forum }));

const { ContestsPage } = await import('./ContestsPage.tsx');
const { ContestPage } = await import('./ContestPage.tsx');
const { ContestsGate } = await import('../contests/Gate.tsx');

let names: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const src = fixtureContests();
  names = vi.fn(src.names);
  hold.src = { ...src, names: names as ContestSource['names'] };
  hold.shown = true;
});

// StrictMode, as in the app: effects mount, unmount and mount again in development
const at = (path: string) => (
  <StrictMode>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/names" element={<ContestsGate />}>
          <Route index element={<ContestsPage />} />
          <Route path=":label" element={<ContestPage />} />
        </Route>
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </MemoryRouter>
  </StrictMode>
);
const cards = (el: ParentNode, scope = '') => [...el.querySelectorAll(`${scope} [data-testid="contest-card"]`)].map((c) => (c as HTMLElement).dataset.label);
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

describe('ContestsPage', () => {
  it('lists open contests soonest first and reads no ended ones until asked', async () => {
    const { el } = await render(at('/names'));
    await settle();
    expect(cards(el, '[data-testid="open-contests"]')).toEqual(['sat0sh1', 'ther0adn0ttaken', 'm00n-wa1k', 'ga1axy']);
    expect(el.textContent).toContain('Satoshi.dash');
    expect(el.textContent).toContain('Lock leads with 69%');
    expect(el.textContent).not.toContain('Ended ·');
    expect(names).not.toHaveBeenCalled();
    const toggle = el.querySelector('[data-testid="toggle-ended"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await click(button(el, /Ended contests/));
    await settle();
    // the first page only (StrictMode asks for it twice in development; the first answer is dropped)
    expect(names.mock.calls.every(([q]) => JSON.stringify(q) === '{}')).toBe(true);
    expect(cards(el, '[data-testid="ended-contests"]')).toEqual(['a1pha', 'dashpay', 'free-m0ney', 'w0r1d']);
    expect(el.textContent).toContain('Locked by 98% of the votes');
  });

  it('narrows both lists with a search, starting the ended list at that name', async () => {
    const { el } = await render(at('/names'));
    await settle();
    await type(el.querySelector('[data-testid="names-search"]') as HTMLInputElement, 'Moon');
    expect(cards(el, '[data-testid="open-contests"]')).toEqual(['m00n-wa1k']);
    await type(el.querySelector('[data-testid="names-search"]') as HTMLInputElement, 'Dash');
    expect(el.textContent).toContain('No open contest matches “Dash”.');
    await click(button(el, /Ended contests/));
    await act(() => new Promise((r) => setTimeout(r, 350)));
    await settle();
    expect(names).toHaveBeenLastCalledWith({ from: 'dash' });
    expect(cards(el, '[data-testid="ended-contests"]')).toEqual(['dashpay']);
  });

  it('is not there, and reads nothing, when contests are not shown for the profile', async () => {
    hold.shown = false;
    const open = vi.spyOn(hold.src, 'open');
    const state = vi.spyOn(hold.src, 'state');
    for (const path of ['/names', '/names/sat0sh1']) {
      const { el } = await render(at(path));
      await settle();
      expect(el.textContent).toContain('Page not found');
    }
    expect(open).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });
});

describe('ContestPage', () => {
  it('shows the requested spelling, every choice and the proof height', async () => {
    const { el } = await render(at('/names/ther0adn0ttaken'));
    await settle();
    expect(el.querySelector('h1')!.textContent).toBe('TheRoadNotTaken.dash');
    expect(el.textContent).toContain('Registers as ther0adn0ttaken.dash');
    expect(el.querySelector('[data-testid="contest-status"]')!.textContent).toMatch(/^Voting closes in 3\.2 days, on /);
    const rows = [...el.querySelectorAll('[data-testid="contender"]')].map((r) => r.textContent);
    expect(rows[0]).toContain('alice.dash');
    expect(rows[0]).toContain('Asked for TheRoadNotTaken');
    expect(rows[0]).toContain('212');
    expect(rows[0]).toContain('67%');
    expect(el.textContent).toContain('Abstain');
    expect(el.textContent).toContain('Nobody gets the name.');
    expect(el.textContent).toContain('Read from Dash Platform with proofs, at Platform block 459,350.');
  });

  it('marks the winner of a decided contest', async () => {
    const { el } = await render(at('/names/dashpay'));
    await settle();
    expect(el.querySelector('[data-testid="contest-status"]')!.textContent).toMatch(/^Awarded on /);
    expect(el.querySelector('[data-testid="contender"]')!.textContent).toContain('Got the name');
  });

  it('sends a typed name to its normalized address, and explains a name that cannot be contested', async () => {
    const { el } = await render(at('/names/Satoshi'));
    await settle();
    expect(el.querySelector('h1')!.textContent).toBe('Satoshi.dash');
    const other = await render(at('/names/bob2'));
    expect(other.el.textContent).toContain('Only names of 3 to 19 letters');
    const none = await render(at('/names/zzzz'));
    await settle();
    expect(none.el.textContent).toContain('No contest for zzzz.dash');
  });
});
