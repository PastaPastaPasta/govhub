// @vitest-environment happy-dom
// F4: a dropped connection during the Recover scan is said in plain words and "Try again" re-runs it without a reload and without typing
// the phrase again (it stays in memory only). Any other failure still wipes it.
import type { RecoveryScan } from '@govhub/auth';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, flush, render, type } from '../test/render.tsx';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let failures: Error[] = [];
let scans = 0;
const result: RecoveryScan = { network: 'testnet', fromHeight: 1, toHeight: 2, keysScanned: 1, identities: [], items: [], usedLocks: 0, provenDuffs: 0n, dropped: 0 };
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  scanForFunds: async () => {
    scans++;
    const f = failures.shift();
    if (f) throw f;
    return result;
  },
}));
vi.mock('./context.tsx', () => {
  const auth = { session: null, network: 'testnet', dapi: () => ({ network: 'testnet' }), platform: async () => ({ network: 'testnet' }), store: {}, closeSheet: () => {} };
  return { useAuth: () => auth };
});
const { RecoverFunds } = await import('./Recover.tsx');

beforeEach(() => {
  failures = [];
  scans = 0;
});

async function start() {
  const r = await render(
    <MemoryRouter>
      <RecoverFunds />
    </MemoryRouter>,
  );
  await type(r.el.querySelector<HTMLInputElement>('[data-testid="recover-phrase"]')!, PHRASE);
  await click(r.el.querySelector<HTMLButtonElement>('[data-testid="recover-scan"]')!);
  await flush();
  return r;
}

describe('F4: Recover scan retry', () => {
  it('a transient failure: plain words, then Try again scans with the phrase still held', async () => {
    failures = [new Error('Failed to prefetch quorums: HTTP request error: error sending request')];
    const r = await start();
    const alert = r.el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/Could not reach the Dash network just now/);
    expect(alert.textContent).toMatch(/Try again in a moment/);
    const retry = r.el.querySelector<HTMLButtonElement>('[data-testid="recover-retry"]')!;
    expect(retry).toBeTruthy();
    expect(scans).toBe(1);
    await click(retry);
    await flush();
    expect(scans).toBe(2); // the phrase was not typed again
    expect(r.el.querySelector('[data-testid="recover-retry"]')).toBeNull();
    expect(r.el.querySelector('[role="alert"]')).toBeNull();
    await r.unmount();
  });

  it('any other failure shows its text and offers no retry (the phrase is wiped)', async () => {
    failures = [new Error('This phrase belongs to another network')];
    const r = await start();
    expect(r.el.querySelector('[role="alert"]')!.textContent).toBe('This phrase belongs to another network');
    expect(r.el.querySelector('[data-testid="recover-retry"]')).toBeNull();
    await r.unmount();
  });
});
