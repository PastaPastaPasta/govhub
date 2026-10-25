// @vitest-environment happy-dom
// The starter in the sign-in sheet: offered next to "Pay with DASH" where the network has a starter issuer (disabled elsewhere), the
// privacy note, the "already used" answer, the keyring masternode picker, and redeeming only once the funding watcher is live.
import { generatePhrase, SeedWallet } from '@govhub/auth';
import { bytesToBase64, epochStart, parseStarterRequest, toHex } from '@govhub/badge';
import { signMessageWif } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FundingPanelProps } from '../auth/FundingPanel.tsx';
import { button, click, flush, render, type } from '../test/render.tsx';
import type { StarterDeps } from './client.ts';
import { fundingTarget } from './client.ts';
import { loadPendingFor, loadStarterFor, saveStarterFor, type StoredStarter } from './store.ts';
import { E, P, PRO, rnd, setup, votingKey } from './testkit.ts';

const h = vi.hoisted(() => ({
  app: { registry: { platformNetwork: 'testnet', faucet: null }, gov: { active: { data: [] as unknown[], loading: false } }, source: { coreNetwork: 'testnet', proposal: async () => null } } as Record<string, unknown>,
  auth: { network: 'testnet' as 'testnet' | 'mainnet', signIn: () => {}, closeSheet: () => {}, platform: async () => ({}), store: { list: () => h.records }, dapi: () => ({}), openSheet: () => {} },
  records: [] as Array<{ address: string; deposits: unknown[]; lock?: unknown }>,
  copies: [] as Array<{ privateKey: Uint8Array }>,
  keyring: { status: 'signed-out', keyring: null, coreNetwork: 'testnet', mns: { owned: [] } } as Record<string, unknown>,
  funding: [] as FundingPanelProps[],
  live: null as StarterDeps | null,
}));
vi.mock('../app/context.tsx', () => ({ useApp: () => h.app }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => h.auth }));
vi.mock('../voting/KeyringContext.tsx', () => ({ useKeyring: () => h.keyring }));
vi.mock('../auth/FundingPanel.tsx', () => ({
  FundingPanel: (p: FundingPanelProps) => {
    h.funding.push(p);
    return <div data-testid="funding-panel">{p.deposit}</div>;
  },
}));
vi.mock('./live.ts', () => ({ liveStarterDeps: () => h.live }));
vi.mock('../voting/gate.ts', async (orig) => {
  const real = await orig<typeof import('../voting/gate.ts')>();
  return { ...real, keyCopy: (k: Parameters<typeof real.keyCopy>[0]) => { const c = real.keyCopy(k); if (c) h.copies.push(c); return c; } };
});
const { StarterPanel } = await import('./StarterPanel.tsx');
const { FundNewIdentity } = await import('../auth/AuthSheet.tsx');

/** Flushes until `cond` holds (the token request does real RSA and ECDSA work across several turns). */
async function until(cond: () => unknown, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const wallet = () => SeedWallet.fromPhrase(generatePhrase(12), 'testnet');
const testnet = () => {
  h.app.registry = { platformNetwork: 'testnet', faucet: null };
  h.auth.network = 'testnet';
};

beforeEach(() => {
  testnet();
  h.keyring = { status: 'signed-out', keyring: null, coreNetwork: 'testnet', mns: { owned: [] } };
  h.funding.length = 0;
  h.live = null;
  h.records = [];
  h.copies.length = 0;
  localStorage.clear();
});

describe('funding choice', () => {
  it('testnet: "Get a free starter" next to "Pay with DASH", the voucher as a secondary option; the starter shows the privacy note', async () => {
    h.live = setup().deps;
    const r = await render(<FundNewIdentity phrase={generatePhrase(12)} identityIndex={0} />);
    await until(() => r.el.querySelector('[data-testid="choice-starter"]'), 'the choice');
    const starter = button(r.el, /Get a free starter/);
    expect(starter.disabled).toBe(false);
    expect(button(r.el, /Pay with DASH/)).toBeTruthy();
    expect(button(r.el, /I have a voucher link/).closest('ul')!.classList.contains('choices-s')).toBe(true);
    expect(r.el.textContent).not.toMatch(/Redeem a voucher/);
    await click(starter);
    const note = r.el.querySelector('[data-testid="starter-privacy"]')!;
    expect(note.textContent).toMatch(/never sees your new account/);
    expect(note.textContent).toMatch(/never which masternode or proposal/);
    expect(note.textContent).toMatch(/match the two by time/);
    expect(note.textContent).toMatch(/keep no logs/);
    expect(note.textContent).toMatch(/belongs to some masternode or proposal owner \(not which one\)/);
    expect(r.el.querySelector('[data-testid="starter-kind-mn"]')!.closest('label')!.textContent).toMatch(/I own a masternode/);
    expect(r.el.querySelector('[data-testid="starter-kind-proposal"]')!.closest('label')!.textContent).toMatch(/I own a\s+proposal/);
    await r.unmount();
  });

  it('a network without a starter issuer: the option is disabled and says so', async () => {
    h.app.registry = { platformNetwork: 'mainnet', faucet: null };
    h.auth.network = 'mainnet';
    const phrase = generatePhrase(12);
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} />);
    await until(() => r.el.querySelector('[data-testid="choice-starter"]'), 'the choice');
    const starter = button(r.el, /Get a free starter/);
    expect(starter.disabled).toBe(true);
    expect(starter.textContent).toMatch(/Not available on mainnet yet/);
    await r.unmount();
  });

  it('StarterPanel itself, without a starter issuer: not available', async () => {
    h.app.registry = { platformNetwork: 'mainnet', faucet: null };
    h.auth.network = 'mainnet';
    const w = SeedWallet.fromPhrase(generatePhrase(12), 'mainnet');
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} />);
    expect(r.el.querySelector('[data-testid="starter-unavailable"]')!.textContent).toMatch(/not available on mainnet/);
    await r.unmount();
  });
});

async function mnSubmit(r: Awaited<ReturnType<typeof render>>, wif: string) {
  await click(r.el.querySelector<HTMLInputElement>('[data-testid="starter-kind-mn"]')!);
  await type(r.el.querySelector<HTMLInputElement>('[data-testid="starter-protx"]')!, PRO);
  await type(r.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!, wif);
  await click(button(r.el, /Get my starter/));
  await until(() => r.el.querySelector('[data-testid^="starter-already"], [data-testid="starter-error"], [data-testid="funding-panel"]'), 'the token answer');
}

describe('masternode starter', () => {
  it('"already used": a clear message and "Pay with DASH instead"; the pasted key is dropped', async () => {
    const s = setup({ answer: () => ({ ok: false, status: 409, error: 'already-issued', message: 'used' }) });
    await s.platform.addKey(E);
    const payInstead = vi.fn();
    const r = await render(<StarterPanel wallet={wallet()} identityIndex={0} onDone={() => {}} onPayInstead={payInstead} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    const box = r.el.querySelector('[data-testid="starter-already-used"]')!;
    expect(box.textContent).toMatch(/You already used your starter/);
    expect(box.textContent).toMatch(/one starter ever/);
    expect(r.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!.value).toBe('');
    await click(button(box as HTMLElement, /Pay with DASH instead/));
    expect(payInstead).toHaveBeenCalled();
    await r.unmount();
  });

  it('an unanswered request (it may have reached the issuer): "Pay with DASH instead" at the proof step asks first', async () => {
    const s = setup({ answer: () => ({ ok: false, status: 503, error: 'unavailable', message: 'busy' }) });
    await s.platform.addKey(E);
    const payInstead = vi.fn();
    const asked: string[] = [];
    let yes = false;
    vi.stubGlobal('confirm', (m: string) => (asked.push(m), yes));
    try {
      const r = await render(<StarterPanel wallet={wallet()} identityIndex={0} onDone={() => {}} onPayInstead={payInstead} deps={s.deps} />);
      await mnSubmit(r, votingKey().wif);
      const pay = () => click(button(r.el.querySelector('[data-testid="starter-error"]') as HTMLElement, /Pay with DASH/));
      await pay();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/may already have reached the issuer/);
      expect(payInstead).not.toHaveBeenCalled();
      yes = true;
      await pay();
      expect(payInstead).toHaveBeenCalledTimes(1);
      await r.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('"now": the token is stored encrypted, and the faucet is asked only once the funding watcher is live', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const w = wallet();
    const t = fundingTarget(w, 0);
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    expect(h.funding.length).toBeGreaterThan(0);
    const fp = h.funding.at(-1)!;
    expect(fp).toMatchObject({ kind: 'create', identityIndex: 0 });
    expect(s.seen.redeem).toHaveLength(0); // not before the watcher is live
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain(PRO);
    await act(async () => fp.onAwaitingDeposit!(t.address));
    await until(() => r.el.querySelector('[data-testid="starter-paid"]'), 'the faucet answer');
    expect(s.seen.redeem).toEqual([expect.objectContaining({ network: 'testnet', epoch: E, address: t.address })]);
    expect(r.el.querySelector('[data-testid="starter-paid"]')!.textContent).toMatch(/0\.006 DASH/);
    await r.unmount();
  });

  it('a faucet refusal (unknown key, bad token) never deletes a token that is still within its redeem window', async () => {
    const s = setup({ faucet: () => ({ ok: false, status: 400, code: 'unknown-key', message: 'No starter key is accepted for that epoch' }) });
    await s.platform.addKey(E);
    const w = wallet();
    const t = fundingTarget(w, 0);
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    expect(localStorage.length).toBe(1);
    await act(async () => h.funding.at(-1)!.onAwaitingDeposit!(t.address));
    await until(() => s.seen.redeem.length, 'the faucet call');
    await flush();
    expect(r.el.textContent).toMatch(/right now/);
    expect(localStorage.length).toBe(1); // kept: the next visit (or a retry) can still redeem it
    await r.unmount();
  });

  it('a faucet refusal forgets the token only once Platform’s proved height is past its redeem window', async () => {
    const s = setup({ faucet: () => ({ ok: false, status: 400, code: 'unknown-key', message: 'No starter key is accepted for that epoch' }) });
    await s.platform.addKey(E);
    const w = wallet();
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    expect(localStorage.length).toBe(1);
    s.platform.core = epochStart(P, E + 2);
    await act(async () => h.funding.at(-1)!.onAwaitingDeposit!(fundingTarget(w, 0).address));
    await until(() => localStorage.length === 0, 'the expired token to be forgotten');
    await r.unmount();
  });

  it('"Pay with DASH instead" with a token in hand asks first, and says an unresolved payout may still arrive', async () => {
    const s = setup({ faucet: () => ({ ok: false, status: 503, code: 'unavailable', message: 'Chain providers unavailable, please retry' }) });
    await s.platform.addKey(E);
    const w = wallet();
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    await act(async () => h.funding.at(-1)!.onAwaitingDeposit!(fundingTarget(w, 0).address));
    await until(() => r.el.querySelector('[data-testid="starter-redeem-error"]'), 'the faucet error');
    const asked: string[] = [];
    let yes = false;
    vi.stubGlobal('confirm', (m: string) => (asked.push(m), yes));
    try {
      await click(button(r.el, /Pay with DASH instead/));
      expect(asked[0]).toMatch(/will then not be used/);
      expect(asked[0]).toMatch(/may still pay/);
      expect(r.el.querySelector('[data-testid="starter-redeem-error"]')).not.toBeNull(); // declined: nothing changed
      yes = true;
      await click(button(r.el, /Pay with DASH instead/));
      expect(h.funding.at(-1)!.deposit).toBeUndefined(); // the QR for the same address
      expect(localStorage.length).toBe(1); // the token itself is not thrown away here
    } finally {
      vi.unstubAllGlobals();
    }
    await r.unmount();
  });

  it('the keyring’s masternodes can be picked; the keyring key signs (its copy is wiped)', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const priv = secp256k1.utils.randomSecretKey();
    const keyCopy = priv.slice();
    h.keyring = {
      status: 'open',
      coreNetwork: 'testnet',
      keyring: { content: { keys: [{ privateKey: keyCopy, compressed: true, label: '' }] } },
      mns: { owned: [{ proTxHash: PRO, valid: true, type: 'regular', votingAddress: 'yVoting', keyIndex: 0 }] },
    };
    const r = await render(<StarterPanel wallet={wallet()} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await click(r.el.querySelector<HTMLInputElement>('[data-testid="starter-kind-mn"]')!);
    expect(r.el.querySelector('[data-testid="starter-mn-pick"]')).not.toBeNull();
    expect(r.el.querySelector('[data-testid="starter-wif"]')).toBeNull();
    await click(button(r.el, /Get my starter/));
    await until(() => h.funding.length, 'the funding panel');
    expect(s.seen.token).toHaveLength(1);
    expect(s.seen.token[0]!.signature).toBe(signMessageWif((await import('@govhub/verify')).encodeWif(priv, true, 'testnet'), s.seen.token[0]!.request, 'testnet'));
    expect(keyCopy).toEqual(priv); // the keyring's own key is untouched
    expect(h.copies).toHaveLength(1);
    expect(h.copies[0]!.privateKey.every((x) => x === 0)).toBe(true); // the signing copy is wiped
    await r.unmount();
  });
});

describe('token safety', () => {
  it('a token that arrives after the sheet closed (wallet wiped) is still saved for the next visit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup();
    await s.platform.addKey(E);
    const worker = s.deps.worker;
    let asked = false;
    s.deps.worker = (async (r: Parameters<typeof worker>[0]) => {
      if (r.kind === 'token') {
        asked = true;
        await gate;
      }
      return worker(r as never);
    }) as typeof worker;
    const phrase = generatePhrase(12);
    const w = SeedWallet.fromPhrase(phrase, 'testnet');
    const r = await render(<StarterPanel wallet={w} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await flush();
    await click(r.el.querySelector<HTMLInputElement>('[data-testid="starter-kind-mn"]')!);
    await type(r.el.querySelector<HTMLInputElement>('[data-testid="starter-protx"]')!, PRO);
    await type(r.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!, votingKey().wif);
    await click(button(r.el, /Get my starter/));
    await until(() => asked, 'the token request');
    await r.unmount();
    w.wipe();
    release();
    let saved: Awaited<ReturnType<typeof loadStarterFor>> = null;
    for (let i = 0; i < 200 && !saved; i++) {
      saved = await loadStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0);
      if (!saved) await act(async () => new Promise((r) => setTimeout(r, 5)));
    }
    expect(saved).toMatchObject({ v: 1, token: { epoch: E } });
    expect(await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).toEqual([]); // the request went with the token
    expect(localStorage.length).toBe(1);
  });
});

describe('proposal starter', () => {
  it('shows the exact message with signmessage commands, checks the pasted signature locally and mentions the expiry', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const pay = votingKey();
    h.app.gov = { active: { data: [{ value: { govHash: 'cd'.repeat(32), name: 'my-proposal', paymentAddress: pay.address } }], loading: false } };
    const r = await render(<StarterPanel wallet={wallet()} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await click(r.el.querySelector<HTMLInputElement>('[data-testid="starter-kind-proposal"]')!);
    const sel = r.el.querySelector<HTMLSelectElement>('[data-testid="starter-proposal-pick"]')!;
    await act(async () => {
      sel.value = 'cd'.repeat(32);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(r.el.textContent).toContain(pay.address);
    await click(r.el.querySelector<HTMLButtonElement>('[data-testid="starter-get-message"]')!);
    await until(() => r.el.querySelector('[data-testid="starter-message"]'), 'the message');
    const msg = r.el.querySelector('[data-testid="starter-message"]')!.textContent!;
    expect(msg).toMatch(/^govhub-starter-req:v1\|testnet\|/);
    expect(r.el.textContent).toContain(`signmessage "${pay.address}" "${msg}"`);
    expect(r.el.textContent).toMatch(/as the issuer set it/);
    expect(button(r.el, /Get a new message/)).toBeTruthy();
    const sig = r.el.querySelector<HTMLTextAreaElement>('[data-testid="starter-sig"]')!;
    await type(sig, signMessageWif(votingKey().wif, msg, 'testnet'));
    expect(r.el.querySelector('[data-testid="starter-sig-status"]')!.textContent).toMatch(/does not verify/);
    expect(button(r.el, /Get my starter/).disabled).toBe(true);
    await type(sig, signMessageWif(pay.wif, msg, 'testnet'));
    expect(r.el.querySelector('[data-testid="starter-sig-status"]')!.textContent).toMatch(/checks out/);
    await click(button(r.el, /Get my starter/));
    await until(() => h.funding.length, 'the funding panel');
    expect(s.seen.token).toHaveLength(1);
    h.app.gov = { active: { data: [], loading: false } };
    await r.unmount();
  });
});

describe('redeem later and resume', () => {
  const stored = (dueAt: number): StoredStarter => ({ v: 1, token: { network: 'testnet', epoch: E, msgPrefix: bytesToBase64(rnd(32)), sig: bytesToBase64(rnd(256)), validUntil: Date.now() + 86_400_000 }, dueAt });

  it('a stored token for this setup continues the starter (waiting until its time) instead of the QR code', async () => {
    h.live = setup().deps;
    const phrase = generatePhrase(12);
    await saveStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0, stored(Date.now() + 3_600_000));
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} resume />);
    await until(() => r.el.querySelector('[data-testid="starter-waiting"]'), 'the waiting notice');
    expect(r.el.querySelector('[data-testid="starter-waiting"]')!.textContent).toMatch(/redeemed at a random time/);
    expect(h.funding).toHaveLength(0);
    await click(button(r.el, /Redeem now instead/));
    await until(() => h.funding.length, 'the funding panel');
    expect(h.funding.at(-1)).toMatchObject({ kind: 'create', identityIndex: 0 });
    expect(h.funding.at(-1)!.onAwaitingDeposit).toBeTypeOf('function');
    // saved: a reload resumes at once
    expect((await loadStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0))!.dueAt).toBeLessThanOrEqual(Date.now());
    await r.unmount();
  });

  it('a setup the faucet already paid goes to the funding watcher even before the due time', async () => {
    h.live = setup().deps;
    const phrase = generatePhrase(12);
    const w = SeedWallet.fromPhrase(phrase, 'testnet');
    await saveStarterFor(localStorage, w, 0, stored(Date.now() + 3_600_000));
    h.records = [{ address: fundingTarget(w, 0).address, deposits: [{}] }];
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} resume />);
    await until(() => h.funding.length, 'the funding panel');
    expect(r.el.querySelector('[data-testid="starter-waiting"]')).toBeNull();
    await r.unmount();
  });

  it('an expired token (Platform’s proved height past S(epoch + 2)) is dropped on resume, with a note, and the QR flow shows', async () => {
    const s = setup();
    s.platform.core = epochStart(P, E + 2);
    h.live = s.deps;
    const phrase = generatePhrase(12);
    await saveStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0, { ...stored(Date.now() - 1), token: { ...stored(0).token, validUntil: Date.now() - 1 } });
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} resume />);
    await until(() => h.funding.length, 'the funding panel');
    expect(h.funding.at(-1)!.deposit).toBeUndefined();
    expect(r.el.textContent).toMatch(/has expired/);
    expect(localStorage.length).toBe(0);
    await r.unmount();
  });

  it('a token past its clock estimate is kept while Platform’s proved height is still inside its redeem window', async () => {
    const s = setup();
    s.platform.core = epochStart(P, E + 2) - 1;
    h.live = s.deps;
    const phrase = generatePhrase(12);
    await saveStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0, { ...stored(Date.now() - 1), token: { ...stored(0).token, validUntil: Date.now() - 1 } });
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} resume />);
    await until(() => h.funding.length, 'the funding panel');
    expect(h.funding.at(-1)!.deposit).toBeTruthy(); // the starter continues
    expect(r.el.textContent).not.toMatch(/has expired/);
    expect(await loadStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).not.toBeNull();
    await r.unmount();
  });

  it('a request whose answer never came back resumes with the same blinding (no new request, no "already used")', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const worker = s.deps.worker;
    let lose = true;
    s.deps.worker = (async (r: Parameters<typeof worker>[0]) => {
      const out = await worker(r as never);
      if (r.kind === 'token' && lose) throw new Error('Failed to fetch'); // the issuer recorded it; the answer was lost
      return out;
    }) as typeof worker;
    h.live = s.deps;
    const phrase = generatePhrase(12);
    const vk = votingKey();
    const r = await render(<StarterPanel wallet={SeedWallet.fromPhrase(phrase, 'testnet')} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, vk.wif);
    await until(() => r.el.querySelector('[data-testid="starter-error"]'), 'the lost answer');
    await r.unmount(); // a reload
    const kept = await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0);
    expect(kept).toMatchObject([{ kind: 'mn', subject: PRO }]);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain(PRO); // encrypted
    lose = false;
    const r2 = await render(<FundNewIdentity phrase={phrase} identityIndex={0} />);
    await until(() => r2.el.querySelector('[data-testid="starter-resume-request"]'), 'the resume notice');
    expect(r2.el.querySelector<HTMLInputElement>('[data-testid="starter-protx"]')!.value).toBe(PRO);
    await type(r2.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!, vk.wif);
    await click(button(r2.el, /Get my starter/));
    await until(() => h.funding.length, 'the funding panel');
    const [a, b] = s.seen.token.map((t) => toHex(parseStarterRequest(t.request).blindedMsgSha256));
    expect(s.seen.token).toHaveLength(2);
    expect(b).toBe(a); // the same blinded message, signed again by the issuer
    expect(s.seen.calls.filter((c) => c === 'blind')).toHaveLength(1);
    expect(await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).toEqual([]);
    await r2.unmount();
  });

  it('trying another masternode never drops an unanswered request for the first; both resume, each with its own blinding', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const worker = s.deps.worker;
    let lose = true;
    s.deps.worker = (async (r: Parameters<typeof worker>[0]) => {
      const out = await worker(r as never);
      if (r.kind === 'token' && lose) throw new Error('Failed to fetch');
      return out;
    }) as typeof worker;
    h.live = s.deps;
    const phrase = generatePhrase(12);
    const vk = votingKey();
    const OTHER = 'ef'.repeat(32);
    const r = await render(<StarterPanel wallet={SeedWallet.fromPhrase(phrase, 'testnet')} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, vk.wif);
    await until(() => r.el.querySelector('[data-testid="starter-error"]'), 'the first lost answer');
    // another masternode, also lost
    const protx = r.el.querySelector<HTMLInputElement>('[data-testid="starter-protx"]')!;
    await type(protx, OTHER);
    await type(r.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!, vk.wif);
    await click(button(r.el, /Get my starter/));
    await until(() => s.seen.token.length === 2, 'the second request');
    await flush();
    await r.unmount();
    const kept = await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0);
    expect(kept.map((k) => k.subject).sort()).toEqual([PRO, OTHER].sort());
    lose = false;
    const r2 = await render(<FundNewIdentity phrase={phrase} identityIndex={0} />);
    await until(() => r2.el.querySelector('[data-testid="starter-resume-request"]'), 'the resume notice');
    expect(r2.el.querySelector('[data-testid="starter-resume-request"]')!.textContent).toMatch(/does not lose it/);
    await type(r2.el.querySelector<HTMLInputElement>('[data-testid="starter-protx"]')!, PRO);
    await type(r2.el.querySelector<HTMLInputElement>('[data-testid="starter-wif"]')!, vk.wif);
    await click(button(r2.el, /Get my starter/));
    await until(() => h.funding.length, 'the funding panel');
    const blinded = s.seen.token.map((t) => ({ subject: toHex(parseStarterRequest(t.request).subject), h: toHex(parseStarterRequest(t.request).blindedMsgSha256) }));
    const forPro = blinded.filter((b) => b.subject === PRO).map((b) => b.h);
    expect(forPro).toHaveLength(2);
    expect(forPro[1]).toBe(forPro[0]); // the first masternode's own blinding, despite the second request in between
    await r2.unmount();
  });

  it('a stored request whose epoch’s issuance has closed (proved height) is dropped on resume with a plain explanation', async () => {
    const s = setup();
    await s.platform.addKey(E);
    const worker = s.deps.worker;
    s.deps.worker = (async (r: Parameters<typeof worker>[0]) => {
      const out = await worker(r as never);
      if (r.kind === 'token') throw new Error('Failed to fetch');
      return out;
    }) as typeof worker;
    h.live = s.deps;
    const phrase = generatePhrase(12);
    const r = await render(<StarterPanel wallet={SeedWallet.fromPhrase(phrase, 'testnet')} identityIndex={0} onDone={() => {}} deps={s.deps} />);
    await mnSubmit(r, votingKey().wif);
    await until(() => r.el.querySelector('[data-testid="starter-error"]'), 'the lost answer');
    await r.unmount();
    expect(await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).toHaveLength(1);
    s.platform.core = epochStart(P, E + 1); // the issuer no longer issues for E
    const r2 = await render(<FundNewIdentity phrase={phrase} identityIndex={0} />);
    await until(() => r2.el.querySelector('[role="alert"]'), 'the explanation');
    expect(r2.el.textContent).toMatch(/can no longer be completed/);
    expect(r2.el.querySelector('[data-testid="starter-resume-request"]')).toBeNull();
    expect(await loadPendingFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0)).toEqual([]);
    await r2.unmount();
  });

  it('an account funded another way (Pay with DASH) drops the starter token and requests kept for it', async () => {
    h.live = setup().deps;
    const phrase = generatePhrase(12);
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} />);
    await until(() => r.el.querySelector('[data-testid="choice-starter"]'), 'the funding choice');
    await click(button(r.el, /Pay with DASH/));
    await until(() => h.funding.length, 'the QR funding panel');
    // e.g. a token from a starter attempt in another tab of this setup
    await saveStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0, stored(Date.now() + 3_600_000));
    expect(localStorage.length).toBe(1);
    await act(async () => {
      await Promise.resolve(h.funding.at(-1)!.onDone('x'.repeat(44), 0)).catch(() => {});
    });
    expect(localStorage.length).toBe(0);
    await r.unmount();
  });

  it('a due token goes straight to the funding watcher; without one a resume shows the QR flow', async () => {
    h.live = setup().deps;
    const phrase = generatePhrase(12);
    await saveStarterFor(localStorage, SeedWallet.fromPhrase(phrase, 'testnet'), 0, stored(Date.now() - 1));
    const r = await render(<FundNewIdentity phrase={phrase} identityIndex={0} resume />);
    await until(() => h.funding.length, 'the funding panel');
    expect(h.funding.at(-1)!.deposit).toBeTruthy();
    await r.unmount();
    h.funding.length = 0;
    const r2 = await render(<FundNewIdentity phrase={generatePhrase(12)} identityIndex={0} resume />);
    await until(() => h.funding.length, 'the funding panel');
    expect(h.funding.at(-1)!.deposit).toBeUndefined();
    expect(h.funding.at(-1)!.onAwaitingDeposit).toBeUndefined();
    await r2.unmount();
  });
});
