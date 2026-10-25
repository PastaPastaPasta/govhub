// @vitest-environment happy-dom
// What the proposal page says in place of the passing / budget / voting-deadline block.
import { describe, expect, it } from 'vitest';
import { render } from '../test/render.tsx';
import { LameDuckPageStatus, lameDuckSummary } from './LameDuck.tsx';

const OCT27 = Date.UTC(2026, 9, 27, 12) / 1000;

describe('lameDuckSummary', () => {
  it('paid in full: every payment of its window has been made', () => {
    expect(lameDuckSummary({ total: 1, paid: { count: 1, atLeast: false }, endEpoch: OCT27 })).toEqual({
      headline: 'Paid in full',
      detail: '1 of 1 payment made. No more payments are possible; it leaves the network on Oct 27, 2026.',
    });
    // a count that is only a lower bound but already reaches the total is still in full; more than estimated counts as what was paid
    expect(lameDuckSummary({ total: 2, paid: { count: 3, atLeast: true }, endEpoch: OCT27 }).detail).toContain('3 of 3 payments made');
    // an estimate of zero superblocks does not stop a payment that was found
    expect(lameDuckSummary({ total: 0, paid: { count: 1, atLeast: false }, endEpoch: OCT27 }).headline).toBe('Paid in full');
  });

  it('paid in part, or not at all: says so instead of "paid in full"', () => {
    expect(lameDuckSummary({ total: 3, paid: { count: 2, atLeast: false }, endEpoch: OCT27 })).toMatchObject({ headline: 'No more payments possible', detail: expect.stringContaining('2 of 3 payments made') });
    expect(lameDuckSummary({ total: 3, paid: { count: 2, atLeast: true }, endEpoch: OCT27 }).detail).toContain('At least 2 of 3');
    expect(lameDuckSummary({ total: 1, paid: { count: 0, atLeast: false }, endEpoch: OCT27 }).detail).toContain('No payment was made');
    expect(lameDuckSummary({ total: 1, paid: { count: 0, atLeast: true }, endEpoch: OCT27 }).detail).toContain('No payment found yet in the superblocks read');
  });

  it('without a payment count (chain not checked yet) it claims no payment', () => {
    const s = lameDuckSummary({ total: 1, paid: null, endEpoch: OCT27 });
    expect(s.headline).toBe('No more payments possible');
    expect(s.detail).not.toMatch(/paid|made/i);
    expect(s.detail).toContain('Oct 27, 2026');
  });
});

describe('LameDuckPageStatus', () => {
  it('replaces the funding status: no passing, budget or voting-deadline words, and labels the estimate', async () => {
    const { el } = await render(<LameDuckPageStatus total={1} paid={{ count: 1, atLeast: false }} endEpoch={OCT27} counting={false} />);
    const text = el.textContent ?? '';
    expect(text).toContain('Paid in full');
    expect(text).toContain('1 of 1 payment made. No more payments are possible; it leaves the network on Oct 27, 2026.');
    expect(text).toMatch(/is an estimate/);
    expect(text).not.toMatch(/Passing|next budget|Voting closes|Voting for this payout/);
    expect(text).not.toContain('Counting the payments made');
  });

  it('says it is still counting while the chain check runs', async () => {
    const { el } = await render(<LameDuckPageStatus total={1} paid={null} endEpoch={OCT27} counting />);
    expect(el.textContent).toContain('No more payments possible');
    expect(el.textContent).toContain('Counting the payments made');
  });
});
