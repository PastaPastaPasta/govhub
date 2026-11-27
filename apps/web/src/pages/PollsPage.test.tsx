// @vitest-environment happy-dom
// The polls pages on a network without masternode polls yet (mainnet before protocol 15): a calm notice, no lists and no "New poll",
// read again every few minutes until the network has them, then the lists appear by themselves.
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureDecisions, type DecisionSource } from '../decisions/source.ts';
import { flush, render } from '../test/render.tsx';

const NOW_S = Date.UTC(2026, 10, 27) / 1000;
vi.mock('../data/fixtures.ts', () => ({ loadFixtures: async () => ({ now: NOW_S }) }));
const hold = vi.hoisted(() => ({ src: null as unknown as DecisionSource }));
vi.mock('../decisions/useDecisions.ts', async (orig) => ({ ...(await orig<typeof import('../decisions/useDecisions.ts')>()), useDecisionSource: () => hold.src }));
vi.mock('../contests/useContests.ts', () => ({ useClockMs: () => NOW_S * 1000 }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null }) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: () => {} }) }));
vi.mock('../ui/useCommentCounts.ts', () => ({ useCommentCounts: () => new Map() }));

const { PollsPage } = await import('./PollsPage.tsx');
const { PollPage } = await import('./PollPage.tsx');

let available: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  available = vi.fn(async () => false);
  hold.src = { ...fixtureDecisions(), network: 'mainnet', available: available as DecisionSource['available'] };
});
afterEach(() => vi.useRealTimers());

const mount = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/polls" element={<PollsPage />} />
        <Route path="/polls/:id" element={<PollPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('before the network has masternode polls', () => {
  it('waits calmly, and lights up once a later check finds them', async () => {
    const { el, unmount } = await mount('/polls');
    await flush();
    expect(el.querySelector('[data-testid="polls-not-yet"]')!.textContent).toMatch(/arrive with Dash Platform 5.1 on mainnet/);
    expect(el.querySelector('[data-testid="polls-new"]')).toBeNull();
    expect(el.querySelector('[data-testid="poll-card"]')).toBeNull();
    // protocol 15 activates: the next check, a few minutes on, finds the contract
    available.mockResolvedValue(true);
    await act(async () => void vi.advanceTimersByTime(5 * 60_000 + 10));
    await flush();
    await flush();
    expect(available).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="polls-not-yet"]')).toBeNull();
    expect(el.querySelector('[data-testid="polls-new"]')).not.toBeNull();
    await unmount();
  });

  it('a poll link shows the same notice', async () => {
    const { el, unmount } = await mount('/polls/Bx4sgMPNXuZxZwnHa42sT7NKvzZsMpywSX9zDiYp69bK');
    await flush();
    expect(el.querySelector('[data-testid="polls-not-yet"]')).not.toBeNull();
    await unmount();
  });
});
