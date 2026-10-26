// @vitest-environment happy-dom
// A proposal whose first eligible superblock is a later one: the list card and the proposal page say so instead of "Not in the next budget".
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { formatDate } from '../lib/format.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { render } from '../test/render.tsx';

const hold = vi.hoisted(() => ({ trust: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ params: GOV_PARAMS.mainnet, source: { scope: 'test', bridgeDescriptor: () => null } }) }));
vi.mock('./trust/store.ts', () => ({ trustScope: () => 'test', useCachedTrust: () => hold.trust }));
vi.mock('./trust/TrustBadge.tsx', () => ({ TrustBadge: () => null }));
vi.mock('./Identity.tsx', () => ({ Avatar: () => null }));

const { ProposalCard } = await import('./ProposalCard.tsx');
const { StartsLaterPageStatus, startsLaterDetail, startsLaterLabel } = await import('./StartsLater.tsx');

const prov = { kind: 'proof', source: 'test' } as const;
// 2026-10-25; the next mainnet superblock (2,575,480) is ~Nov 20, and Dash-Pay-name-registration-rules runs Jan 3 to Feb 1, 2027
const NOW = Date.UTC(2026, 9, 25) / 1000;
const NEXT = Date.UTC(2026, 10, 20, 12) / 1000;
const cycle: Sourced<Cycle> = { value: { superblockHeight: 2_575_480, budget: 6000e8, allocated: 250e8, votingDeadlineHeight: 0, estTime: NEXT, validWeighted: 3320, paid: 0 }, prov };
const proposal = (over: Partial<Proposal> = {}): Sourced<Proposal> => ({
  value: { govHash: 'aa', parentHash: '0'.repeat(64), revision: 1, time: NOW, dataHex: '', name: 'Dash-Pay-name-registration-rules', url: '', paymentAddress: 'XaddressXaddress', paymentAmount: 1e8, startEpoch: 1798946946, endEpoch: 1801522426, collateralTxid: 'aa', collateralHeight: 0, ...over },
  prov,
});
const tally = (over: Partial<Tally> = {}): Sourced<Tally> => ({
  value: { govHash: 'aa', asOfHeight: 100, yesWeighted: 348, noWeighted: 0, abstainWeighted: 0, yesCount: 30, noCount: 0, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget: false, margin: 0, ...over },
  prov,
});
const rowOf = (p: Sourced<Proposal>, t: Sourced<Tally>) => deriveRow(p, new Map([[p.value.govHash, t]]), new Map(), cycle, GOV_PARAMS.mainnet, NOW);
async function card(p = proposal(), t = tally(), trust: unknown = null) {
  hold.trust = trust;
  return render(
    <MemoryRouter>
      <ProposalCard row={rowOf(p, t)} href="/p/x" />
    </MemoryRouter>,
  );
}

describe('ProposalCard for a proposal that starts paying at a later superblock', () => {
  it('says "Starts paying ~Jan 2027" in an info tag, keeps passing by votes, and drops the warning', async () => {
    const { el } = await card();
    const tag = el.querySelector('[data-testid="card-starts-later"]')!;
    expect(tag.textContent).toBe('Starts paying ~Jan 2027');
    expect(tag.className).toContain('tag-info');
    expect(tag.className).not.toContain('tag-warn');
    expect(el.textContent).not.toContain('Not in the next budget');
    expect(el.textContent).not.toContain('In the next budget');
    // 348 net yes of 332 needed: passing by 16, in the passing colour, not the warning one
    expect(el.querySelector('[data-testid="funding-meter"]')!.className).toContain('meter-pass');
    expect(el.textContent).toContain('Passing by 16');
    expect(el.querySelector('article')!.className).toContain('prow-pass');
    expect(tag.getAttribute('title')).toContain(`it isn't eligible for the ${formatDate(NEXT)} budget`);
  });

  it('a failing proposal reads as failing, with the same start note', async () => {
    const { el } = await card(proposal(), tally({ yesWeighted: 100 }));
    expect(el.textContent).toContain('Needs 232 more yes votes');
    expect(el.querySelector('[data-testid="funding-meter"]')!.className).toContain('meter-fail');
    expect(el.querySelector('[data-testid="card-starts-later"]')!.textContent).toBe('Starts paying ~Jan 2027');
  });

  it("trusts the schedule over a reported inNextBudget flag, and the verification label stays as the page proved it", async () => {
    const { el } = await card(proposal(), tally({ inNextBudget: true }), { level: 'reported', reason: 'not proven', funded: null });
    expect(el.querySelector('[data-testid="card-starts-later"]')).not.toBeNull();
    expect(el.textContent).not.toContain('In the next budget');
  });

  it('a proof that the next superblock does pay it wins over the estimate (and is the only thing that does)', async () => {
    const { el } = await card(proposal(), tally({ inNextBudget: true }), { level: 'verified', reason: null, funded: true });
    expect(el.querySelector('[data-testid="card-starts-later"]')).toBeNull();
    expect(el.textContent).toContain('In the next budget');
  });

  it('a Verified mark that proved nothing about funding (funded: null) leaves the schedule in charge', async () => {
    const { el } = await card(proposal(), tally({ inNextBudget: true }), { level: 'verified', reason: null, funded: null });
    expect(el.querySelector('[data-testid="card-starts-later"]')!.textContent).toBe('Starts paying ~Jan 2027');
    expect(el.textContent).not.toContain('In the next budget');
  });

  it('a proof that it is not funded changes nothing: still "starts paying"', async () => {
    const { el } = await card(proposal(), tally(), { level: 'verified', reason: null, funded: false });
    expect(el.querySelector('[data-testid="card-starts-later"]')!.textContent).toBe('Starts paying ~Jan 2027');
  });

  it('a proposal that is due keeps the warning when passing and not funded', async () => {
    const { el } = await card(proposal({ startEpoch: NOW - 86400, endEpoch: NEXT + 40 * 86400 }));
    expect(el.querySelector('[data-testid="card-starts-later"]')).toBeNull();
    expect(el.textContent).toContain('Not in the next budget');
    expect(el.querySelector('[data-testid="funding-meter"]')!.className).toContain('meter-warn'); // the same votes, but this one is a warning
  });
});

describe('StartsLaterPageStatus', () => {
  it('names the first payment and the budget it misses', async () => {
    const later = rowOf(proposal(), tally()).startsLater!;
    expect(startsLaterLabel(later)).toBe('Starts paying ~Jan 2027');
    // the superblock is ~Jan 19 23:00 UTC: the day shown depends on the reader's timezone
    expect(formatDate(later.firstTime)).toMatch(/^Jan (19|20), 2027$/);
    expect(startsLaterDetail(later)).toBe(`Its first payment is the superblock around ${formatDate(later.firstTime)}. Votes count then; it isn't eligible for the ${formatDate(later.nextTime)} budget.`);
    const { el } = await render(<StartsLaterPageStatus later={later} />);
    const text = el.textContent ?? '';
    expect(text).toContain(startsLaterDetail(later));
    expect(text).toMatch(/estimated from the superblock schedule/i);
    expect(text).not.toMatch(/next budget is full|Not in the next budget/);
  });
});
