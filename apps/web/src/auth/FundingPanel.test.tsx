// @vitest-environment happy-dom
// D-032: an underpayment says what came in and what is still needed, and the wallet link / QR ask for just that.
// D-006: a lock too small for Platform is final (no "Try again"), and a create's lock can top up an existing identity instead.
import { LockTooSmallError, type FundingView } from '@govhub/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, render, type } from '../test/render.tsx';

const runs: Array<Record<string, unknown>> = [];
let script: (o: { onUpdate(v: FundingView): void; recoverInto?: string; identityIndex: number }) => Promise<{ identityId: string; record: { recoveredInto?: string; identityIndex?: number } }>;
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  runFunding: (o: never) => (runs.push(o), script(o)),
  discoverIdentities: async () => [{ identityId: TARGET, identityIndex: 1 }],
  nextCreateIndex: () => 2,
}));
const closeSheet = vi.fn();
vi.mock('./context.tsx', () => {
  const auth = { dapi: () => ({}), platform: async () => ({}), store: {}, closeSheet: () => closeSheet() };
  return { useAuth: () => auth };
});
const { FundingPanel } = await import('./FundingPanel.tsx');

const ADDRESS = 'yiKBLWNurnxpqgcQhr7r1uUxWd1nGzsN2e';
const { TARGET } = vi.hoisted(() => ({ TARGET: '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL' }));
const view = (v: Partial<FundingView>): FundingView => ({
  state: 'awaiting-deposit', address: ADDRESS, uri: `dash:${ADDRESS}?amount=0.00224`, minDuffs: 224_000, remainingDuffs: 224_000n, receivedDuffs: 0n, pendingDuffs: 0n, lateDuffs: 0n,
  depositTxids: [], isLocked: false, ...v,
});
const never = () => new Promise<never>(() => {});

beforeEach(() => void (runs.length = 0));

describe('D-032: underpayment', () => {
  it('shows "received X, still need Y" and the wallet link asks for Y only', async () => {
    script = async (o) => {
      o.onUpdate(view({ receivedDuffs: 100_000n, remainingDuffs: 124_000n, uri: `dash:${ADDRESS}?amount=0.00124` }));
      return never();
    };
    const r = await render(<FundingPanel kind="create" wallet={null} identityIndex={0} onDone={() => {}} />);
    await flush();
    expect(r.el.querySelector('[data-testid="underpaid"]')!.textContent).toMatch(/Received 0\.001 DASH, still need 0\.00124 DASH/);
    expect(r.el.querySelector<HTMLAnchorElement>('a[href^="dash:"]')!.getAttribute('href')).toBe(`dash:${ADDRESS}?amount=0.00124`);
    expect(r.el.textContent).not.toMatch(/Send at least/);
    await r.unmount();
  });

  it('asks for the minimum before anything arrived', async () => {
    script = async (o) => (o.onUpdate(view({})), never());
    const r = await render(<FundingPanel kind="create" wallet={null} identityIndex={0} onDone={() => {}} />);
    await flush();
    expect(r.el.textContent).toMatch(/Send at least 0\.00224 DASH/);
    expect(r.el.querySelector('[data-testid="underpaid"]')).toBeNull();
    await r.unmount();
  });
});

describe('D-032: enough received', () => {
  it('says nothing more is needed while the payment confirms', async () => {
    script = async (o) => (o.onUpdate(view({ pendingDuffs: 224_000n, remainingDuffs: 0n, uri: `dash:${ADDRESS}` })), never());
    const r = await render(<FundingPanel kind="create" wallet={null} identityIndex={0} onDone={() => {}} />);
    await flush();
    expect(r.el.querySelector('[data-testid="enough"]')!.textContent).toMatch(/Received 0\.00224 DASH: that is enough/);
    expect(r.el.textContent).not.toMatch(/Send at least/);
    await r.unmount();
  });
});

describe('D-006: lock too small', () => {
  it('is final: no "Try again", no "Retry continues"; the lock tops up an existing identity instead', async () => {
    const onDone = vi.fn();
    script = async (o) => {
      o.onUpdate(view({ state: 'registering', remainingDuffs: 0n, lockTxid: 'd3'.repeat(32) }));
      if (!o.recoverInto) throw new LockTooSmallError('create', 209_646_000n, 221_500_000n);
      if (o.recoverInto !== TARGET) throw new Error(`There is no identity ${o.recoverInto} on Dash Platform (testnet).`);
      return { identityId: TARGET, record: { recoveredInto: TARGET } };
    };
    const r = await render(<FundingPanel kind="create" wallet={null} identityIndex={0} onDone={onDone} />);
    await flush();
    const box = r.el.querySelector('[data-testid="lock-too-small"]')!;
    expect(box.textContent).toMatch(/0\.00209646 DASH.*0\.002215 DASH/);
    expect(r.el.textContent).not.toMatch(/Try again|Retrying continues/);
    await click(button(r.el, /Use these funds to top up an existing identity/));
    const input = r.el.querySelector<HTMLInputElement>('[data-testid="recover-identity"]')!;
    await type(input, 'not an id');
    await click(button(r.el, /Top up this identity/));
    expect(r.el.textContent).toMatch(/not an identity id/);
    expect(runs).toHaveLength(1);
    // an id Platform does not know: back to the choice with the reason, nothing tied to it
    const unknown = '3o9H4W5zi6SweXxu8QgJ9HaqGeGmky4onLuE8Y2SyZt4';
    await type(input, unknown);
    await click(button(r.el, /Top up this identity/));
    await flush();
    expect(runs.map((x) => x.recoverInto)).toEqual([undefined, unknown, undefined]);
    expect(r.el.textContent).toContain(`There is no identity ${unknown}`);
    expect(r.el.querySelector<HTMLInputElement>('[data-testid="recover-identity"]')!.value).toBe(unknown); // kept to correct
    await type(r.el.querySelector<HTMLInputElement>('[data-testid="recover-identity"]')!, TARGET);
    await click(button(r.el, /Top up this identity/));
    await flush();
    expect(runs.at(-1)!.recoverInto).toBe(TARGET);
    expect(r.el.querySelector('[data-testid="recovered"]')!.textContent).toContain(TARGET);
    expect(onDone).not.toHaveBeenCalled(); // never signs in as the identity that was never created
    await click(button(r.el, /Close/));
    expect(closeSheet).toHaveBeenCalled();
    await r.unmount();
  });

  it('"Pay again for a new account" funds a new identity at the next free index and signs in to that index', async () => {
    const onDone = vi.fn();
    script = async (o) => {
      if (o.identityIndex === 0) throw new LockTooSmallError('create', 209_646_000n, 221_500_000n);
      return { identityId: 'NEW', record: { identityIndex: o.identityIndex } };
    };
    const r = await render(<FundingPanel kind="create" wallet={{} as never} identityIndex={0} onDone={onDone} />);
    await flush();
    await click(r.el.querySelector<HTMLButtonElement>('[data-testid="pay-again"]')!);
    await flush();
    expect(runs.at(-1)).toMatchObject({ identityIndex: 2, kind: 'create' });
    expect(runs.at(-1)!.recoverInto).toBeUndefined();
    expect(onDone).toHaveBeenCalledWith('NEW', 2);
    await r.unmount();
  });

  it("offers this phrase's own identities as one-click targets", async () => {
    script = async (o) => {
      if (!o.recoverInto) throw new LockTooSmallError('create', 209_646_000n, 221_500_000n);
      return { identityId: o.recoverInto, record: { recoveredInto: o.recoverInto } };
    };
    const r = await render(<FundingPanel kind="create" wallet={{} as never} identityIndex={0} onDone={() => {}} />);
    await flush();
    await flush();
    const b = r.el.querySelector<HTMLButtonElement>('[data-testid="recover-mine"]')!;
    expect(b.textContent).toMatch(/identity #1/);
    await click(b);
    await flush();
    expect(runs.at(-1)!.recoverInto).toBe(TARGET);
    expect(r.el.querySelector('[data-testid="recovered"]')).not.toBeNull();
    await r.unmount();
  });

  it('a top-up lock too small offers nothing but the reason', async () => {
    script = async () => {
      throw new LockTooSmallError('topup', 50_000_000n, 50_500_000n);
    };
    const r = await render(<FundingPanel kind="topup" wallet={null} identityIndex={0} topUp={{ identityId: TARGET, index: 0 }} onDone={() => {}} />);
    await flush();
    expect(r.el.querySelector('[data-testid="lock-too-small"]')).not.toBeNull();
    expect(r.el.querySelectorAll('button')).toHaveLength(0);
    await r.unmount();
  });
});
