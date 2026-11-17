// @vitest-environment happy-dom
// App Connect behind its flag: on by default on Mainnet only, nothing of it on the page while off; the hidden per-tab override wins.
import { storageFundingStore, makeSession } from '@govhub/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConnectEnabled, appConnectOverride, PROFILES, PROFILE_ORDER, profileRegistry } from '../config/registry.ts';
import { appSessionFromAuth, isWalletSession } from '../session/authSession.ts';
import { button, click, render } from '../test/render.tsx';

const auth = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('./context.tsx', () => ({ useAuth: () => auth.value }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ mode: 'live', registry: profileRegistry('mainnet') }) }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ forum: { store: null }, signIn: () => {} }) }));
const walletChunk = vi.hoisted(() => ({ loaded: false }));
vi.mock('./WalletSignIn.tsx', () => {
  walletChunk.loaded = true;
  return { default: () => <p data-testid="wallet-view">wallet</p> };
});

const { AuthSheet } = await import('./AuthSheet.tsx');

function mem(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
}

describe('the flag', () => {
  it('is on for Mainnet only, and its app id is the profile forum contract', () => {
    for (const id of PROFILE_ORDER) {
      expect(PROFILES[id].appConnect.enabled).toBe(id === 'mainnet');
      expect(PROFILES[id].appConnect.appId).toBe(PROFILES[id].forum!.contractId);
      expect(appConnectEnabled(profileRegistry(id), null)).toBe(id === 'mainnet');
    }
    expect(PROFILES.mainnet.appConnect.appId).toBe('4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3');
  });

  it('remembers ?appconnect=1 and ?appconnect=0 for the tab', () => {
    const s = mem();
    expect(appConnectOverride('', s)).toBe(null);
    expect(appConnectOverride('?appconnect=1', s)).toBe(true);
    expect(appConnectOverride('?x=2', s)).toBe(true);
    expect(appConnectOverride('?appconnect=0', s)).toBe(false);
    expect(appConnectOverride('', s)).toBe(false);
    expect(appConnectOverride('?appconnect=yes', s)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(appConnectOverride('?appconnect=1', broken)).toBe(true);
    expect(appConnectOverride('?appconnect=0', broken)).toBe(false);
    expect(appConnectOverride('', broken)).toBe(null);
  });

  it('the override wins over the flag, and it is never on with another forum contract', () => {
    const r = profileRegistry('mainnet');
    expect(appConnectEnabled(r, true)).toBe(true);
    expect(appConnectEnabled(r, false)).toBe(false);
    expect(appConnectEnabled(profileRegistry('testnet'), true)).toBe(true);
    const custom = { ...r, forum: { ...r.forum, contractId: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw' } };
    expect(appConnectEnabled(custom, true)).toBe(false);
    expect(appConnectEnabled(custom, null)).toBe(false);
  });
});

describe('the sign-in sheet', () => {
  beforeEach(() => {
    auth.value = { sheet: 'choose', closeSheet: () => {}, openSheet: (v: string) => (auth.value = { ...auth.value, sheet: v }), store: storageFundingStore(mem()), network: 'mainnet', appConnect: false, session: null };
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('flag off: the wallet button is the disabled "Coming soon" one, and the App Connect chunk is never loaded', async () => {
    const r = await render(<AuthSheet />);
    const b = r.el.querySelector<HTMLButtonElement>('[data-testid="wallet-signin"]')!;
    expect(b.disabled).toBe(true);
    expect(b.textContent).toContain('Coming soon');
    expect(walletChunk.loaded).toBe(false);
    await r.unmount();
  });

  it('flag on: the button opens the wallet view', async () => {
    auth.value = { ...auth.value, appConnect: true };
    const r = await render(<AuthSheet />);
    const b = r.el.querySelector<HTMLButtonElement>('[data-testid="wallet-signin"]')!;
    expect(b.disabled).toBe(false);
    expect(b.textContent).not.toContain('Coming soon');
    await click(b);
    await r.rerender(<AuthSheet />);
    await vi.waitFor(() => expect(r.el.querySelector('[data-testid="wallet-view"]')).not.toBeNull());
    await r.unmount();
  });

  it('flag on: wallet first, passkey second, the rest folded away, and no phrase warning until a phrase is asked for', async () => {
    auth.value = { ...auth.value, appConnect: true };
    const r = await render(<AuthSheet />);
    expect(r.el.querySelector('#sheet-title')?.textContent).toBe('Sign in to govhub');
    const main = [...r.el.querySelectorAll('.signin-main button')].map((b) => b.textContent);
    expect(main).toEqual(['Sign in with Dash Wallet', 'Sign in with a passkey']);
    expect(r.el.querySelector('[data-testid="seed-warning"]')).toBeNull();
    const toggle = r.el.querySelector<HTMLButtonElement>('[data-testid="signin-more"]')!;
    const panel = r.el.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect([...panel.querySelectorAll('.signin-alt b')].map((b) => b.textContent)).toEqual(['Create an account', 'I have a recovery phrase', 'Paste a key']);
    expect(panel.textContent).toContain('What is an account here?');

    await click(button(panel, /I have a recovery phrase/));
    await r.rerender(<AuthSheet />);
    expect(r.el.querySelector('#sheet-title')?.textContent).toBe('Sign in with a recovery phrase');
    expect(r.el.querySelector('[data-testid="seed-warning"]')).not.toBeNull();
    await click(button(r.el, /Back to sign-in options/));
    await r.rerender(<AuthSheet />);
    expect(r.el.querySelector('#sheet-title')?.textContent).toBe('Sign in to govhub');
    // back from one of the other ways: that section is still open
    expect(r.el.querySelector('[data-testid="signin-more"]')?.getAttribute('aria-expanded')).toBe('true');
    await r.unmount();
  });

  it('flag off: the other ways start open, since the wallet button does nothing yet', async () => {
    const r = await render(<AuthSheet />);
    expect(r.el.querySelector('[data-testid="signin-more"]')?.getAttribute('aria-expanded')).toBe('true');
    await r.unmount();
  });

  it('the passkey button opens the passkey view; signed-in views have no way back to the chooser', async () => {
    const r = await render(<AuthSheet />);
    await click(r.el.querySelector<HTMLButtonElement>('[data-testid="passkey-signin"]')!);
    await r.rerender(<AuthSheet />);
    expect(auth.value.sheet).toBe('passkey');
    expect(r.el.querySelector('[data-testid="sheet-back"]')).not.toBeNull();
    auth.value = { ...auth.value, sheet: 'topup', session: { source: 'wallet' } };
    await r.rerender(<AuthSheet />);
    expect(r.el.querySelector('[data-testid="sheet-back"]')).toBeNull();
    await r.unmount();
  });

  it('a wallet session sees the wallet notice instead of top-up and passkeys', async () => {
    auth.value = { ...auth.value, sheet: 'topup', session: { source: 'wallet' } };
    const r = await render(<AuthSheet />);
    expect(r.el.querySelector('[data-testid="wallet-limits"]')?.textContent).toMatch(/Top up your identity from the wallet/);
    await r.unmount();
  });
});

describe('a wallet session', () => {
  it('refuses to sign for any contract but the one its key is bound to, before reaching Platform', async () => {
    const forum = '4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3';
    const s = makeSession({ network: 'mainnet', identityId: 'AsDve9GcVemmG7hRFkVMpX2UVQupcoFo7EAg33m8PcTA', identityIndex: null, keyId: 7, securityLevel: 2, source: 'wallet', privateKey: new Uint8Array(32).fill(1), wallet: null, boundContractId: forum });
    const writeDocument = vi.fn(async () => ({ id: 'x', revision: 1 }));
    const app = appSessionFromAuth(s, async () => ({ writeDocument }) as never);
    expect(app.label).toBe('Dash wallet, key 7 (HIGH)');
    // what closes the badge flow and the other key-dependent views to it
    expect(isWalletSession(app)).toBe(true);
    expect(isWalletSession(appSessionFromAuth({ ...s, source: 'seed' } as never, async () => ({}) as never))).toBe(false);
    expect(isWalletSession(null)).toBe(false);
    await expect(app.signAndBroadcastDocument({ action: 'create', contractId: 'BqszMpFvXm11jWeUYRqQu2yREZi7EzgkFfDKZR9dqamq', type: 'mnBadge', data: {} })).rejects.toThrow(/can only write govhub comments/);
    expect(writeDocument).not.toHaveBeenCalled();
    await app.signAndBroadcastDocument({ action: 'create', contractId: forum, type: 'comment', data: {} });
    expect(writeDocument).toHaveBeenCalledOnce();
    app.close();
  });
});
