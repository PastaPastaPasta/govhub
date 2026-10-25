// @vitest-environment happy-dom
// Settings, Recover funds: scan from a phrase, show only what the scan proved, sweep with the destination's network checked, use a lock
// on Platform (never offered as a sweep), keep the one-time key behind a warning, and wipe the phrase when done.
import { addressOf, hexToBytes, publicKeyOf, type RecoveryItem, type RecoveryScan, type RecoverySecret } from '@govhub/auth';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, render, type } from '../test/render.tsx';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const calls = { scan: [] as unknown[], sweep: [] as unknown[], fund: [] as unknown[] };
let scanResult: RecoveryScan;
let seen: RecoverySecret | null = null;
let fundHangs = false;
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  scanForFunds: async (o: { secret: RecoverySecret }) => ((seen = o.secret), calls.scan.push(o), scanResult),
  sweepItem: async (o: unknown) => (calls.sweep.push(o), { txid: 'ab'.repeat(32), sentDuffs: 49_774n, feeDuffs: 226n }),
  fundWithItem: async (o: unknown) => (calls.fund.push(o), fundHangs ? new Promise(() => {}) : { identityId: 'NEWID', record: {} }),
}));
vi.mock('./context.tsx', () => {
  const auth = { session: null, network: 'testnet', dapi: () => ({ network: 'testnet' }), platform: async () => ({ network: 'testnet' }), store: {}, closeSheet: () => {} };
  return { useAuth: () => auth };
});
const { RecoverFunds } = await import('./Recover.tsx');

const base = { family: 'create', label: 'Account setup', path: "m/9'/1'/5'/1'/1'", keyHash: '00'.repeat(20), funding: { kind: 'create' as const, identityIndex: 1 } };
const payments: RecoveryItem = {
  ...base, id: 'yPay', type: 'payments', index: 1, address: 'yPayAddress', payments: [{ txid: 'cd'.repeat(32), vout: 0, duffs: 50_000n, height: 1_579_000 }], duffs: 50_000n,
};
const lock: RecoveryItem = {
  ...base, id: 'lock', type: 'lock', index: 2, address: 'yLockAddress', funding: { kind: 'create', identityIndex: 2 }, payments: [],
  lock: { txid: 'ef'.repeat(32), creditIndex: 0, burnVout: 0, lockDuffs: 249_794n, raw: '00', height: 1_579_001, status: 'unused' }, duffs: 249_794n,
};
const DEST = publicKeyOf(hexToBytes('42'.repeat(32)));
const TESTNET_ADDR = addressOf(DEST, 'testnet');
const MAINNET_ADDR = addressOf(DEST, 'mainnet');

beforeEach(() => {
  fundHangs = false;
  for (const l of Object.values(calls)) l.length = 0;
  seen = null;
  scanResult = { network: 'testnet', fromHeight: 1_577_000, toHeight: 1_579_300, keysScanned: 21, identities: [{ identityIndex: 0, identityId: 'MINE' }], items: [payments, lock], usedLocks: 2, provenDuffs: 299_794n, dropped: 1 };
});

async function scanned() {
  const r = await render(
    <MemoryRouter>
      <RecoverFunds />
    </MemoryRouter>,
  );
  await type(r.el.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-testid="recover-phrase"]')!, PHRASE);
  await click(r.el.querySelector<HTMLButtonElement>('[data-testid="recover-scan"]')!);
  await flush();
  return r;
}

describe('Recover funds', () => {
  it('scans from the phrase (masked input) and shows the proven total, the items, and what was ignored', async () => {
    const r = await render(
      <MemoryRouter>
        <RecoverFunds />
      </MemoryRouter>,
    );
    expect(r.el.querySelector('[data-testid="recover-phrase"]')!.getAttribute('data-masked')).toBe('true');
    await r.unmount();
    const s = await scanned();
    expect(calls.scan).toHaveLength(1);
    expect((calls.scan[0] as { fromHeight: number }).fromHeight).toBe(1_577_000);
    expect(s.el.querySelector('[data-testid="recover-total"]')!.textContent).toMatch(/Found 0\.00299794 DASH you can recover/);
    expect(s.el.textContent).toMatch(/2 earlier payments were already used/);
    expect(s.el.textContent).toMatch(/1 transaction a node sent without proof was ignored/);
    expect(s.el.querySelectorAll('[data-testid="recover-item"]')).toHaveLength(2);
    // the phrase is no longer in the form
    expect(s.el.querySelector('[data-testid="recover-phrase"]')).toBeNull();
    await s.unmount();
  });

  it('sweeps payments only to an address of this network, showing amount and fee', async () => {
    const s = await scanned();
    const card = s.el.querySelector('[data-type="payments"]')!;
    await click(card.querySelector<HTMLButtonElement>('[data-testid="recover-sweep-open"]')!);
    const to = card.querySelector<HTMLInputElement>('[data-testid="recover-sweep-to"]')!;
    await type(to, MAINNET_ADDR);
    expect(card.textContent).toMatch(/mainnet address; these funds are on testnet/);
    expect(card.querySelector<HTMLButtonElement>('[data-testid="recover-sweep-send"]')!.disabled).toBe(true);
    await type(to, TESTNET_ADDR);
    expect(card.querySelector('[data-testid="recover-sweep-amount"]')!.textContent).toMatch(/Sends 0\.00049808 DASH; the network fee is 0\.00000192 DASH/);
    await click(card.querySelector<HTMLButtonElement>('[data-testid="recover-sweep-send"]')!);
    await flush();
    expect(calls.sweep).toHaveLength(1);
    expect((calls.sweep[0] as { to: string; item: RecoveryItem }).to).toBe(TESTNET_ADDR);
    expect((calls.sweep[0] as { item: RecoveryItem }).item.id).toBe('yPay');
    expect(card.querySelector('[data-testid="sweep-txid"]')!.textContent).toBe('ab'.repeat(32));
    await s.unmount();
  });

  it('an asset lock is never offered as a sweep; it creates the account or tops up an identity', async () => {
    const s = await scanned();
    const card = s.el.querySelector('[data-type="lock"]')!;
    expect(card.querySelector('[data-testid="recover-sweep-open"]')).toBeNull();
    expect(card.textContent).toMatch(/never sent back to a Dash address/);
    expect(card.textContent).toMatch(/Dash Platform proves it has not been used/);
    expect(card.querySelector('[data-testid="recover-topup-mine"]')!.textContent).toMatch(/identity #0/);
    await click(card.querySelector<HTMLButtonElement>('[data-testid="recover-create"]')!);
    await flush();
    expect((calls.fund[0] as { target: unknown }).target).toEqual({ create: true });
    expect(card.querySelector('[data-testid="recovered-identity"]')!.textContent).toBe('NEWID');
    await s.unmount();
  });

  it('"Scan again" and "Done" wait while an item is being used (they would stop it)', async () => {
    fundHangs = true;
    const s = await scanned();
    await click(s.el.querySelector<HTMLButtonElement>('[data-type="lock"] [data-testid="recover-create"]')!);
    await flush();
    expect(button(s.el, /Scan again/).disabled).toBe(true);
    expect(button(s.el, /Done \(forget/).disabled).toBe(true);
    await s.unmount();
  });

  it('exports the one-time key only after the warning is acknowledged, masked', async () => {
    const s = await scanned();
    const card = s.el.querySelector('[data-type="payments"]')!;
    const get = card.querySelector<HTMLButtonElement>('[data-testid="recover-export"]')!;
    expect(get.disabled).toBe(true);
    await click(card.querySelector<HTMLInputElement>('.recover-export input[type="checkbox"]')!);
    // the scan was mocked, so this phrase does not hold the item's (made-up) key: refused, nothing shown
    await click(get);
    expect(card.querySelector('[data-testid="recover-wif"]')).toBeNull();
    expect(card.textContent).toMatch(/does not hold that address/);
    await s.unmount();
  });

  it('"Done" wipes the phrase the scan used; leaving the page does too', async () => {
    const s = await scanned();
    const w = seen!.wallet!;
    expect(w.wiped).toBe(false);
    await click(button(s.el, /Done \(forget/));
    expect(w.wiped).toBe(true);
    await s.unmount();
    const s2 = await scanned();
    const w2 = seen!.wallet!;
    await s2.unmount();
    expect(w2.wiped).toBe(true);
  });
});
