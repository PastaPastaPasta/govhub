// @vitest-environment happy-dom
// A wallet (App Connect) key revoked in the wallet: Platform's "Identity key N is disabled" on any write is recognised whatever N is,
// signs the wallet session out (this tab, the real AuthProvider) and is said once, in the app-wide banner with Reconnect.
import { makeSession, SecurityLevel, type PlatformPort, type Session } from '@govhub/auth';
import { act, createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useAuth as UseAuth } from '../auth/context.tsx';
import { flush, render } from '../test/render.tsx';
import { appSessionFromAuth } from './authSession.ts';
import { isDisabledKeyError, WALLET_SESSION_ENDED_TEXT, WalletSessionEndedError } from './keyDisabled.ts';
import type { Session as AppSession } from './session.ts';

const FORUM = '4EcYtwedNjTm4iGmx47GkLX2uNkCUWS4tt1KHhgGkjR3';
const ID = 'GgZekwh38XcWQTyWWWvmw6CEYFnLU7yiZFPWZEjqKHit';
const OP = { action: 'create', contractId: FORUM, type: 'comment', data: { body: 'hi' } } as const;

const h = vi.hoisted(() => ({ useForum: null as unknown as () => unknown, port: null as unknown as PlatformPort }));
vi.mock('../app/context.tsx', async () => {
  const { profileRegistry } = await import('../config/registry.ts');
  const app = { registry: profileRegistry('mainnet'), mode: 'live' };
  return { useApp: () => app };
});
vi.mock('../app/forum.tsx', () => ({ useForum: () => h.useForum() }));
vi.mock('../auth/runtime.ts', async (orig) => ({ ...(await orig<object>()), getPlatformPort: async () => h.port, getAuthDapi: () => ({}) }));

const { AuthProvider, useAuth } = await import('../auth/context.tsx');
const { WalletSessionEnded } = await import('../app/Layout.tsx');
const { WriteError } = await import('../ui/WriteError.tsx');

const session = (source: 'wallet' | 'key'): Session =>
  makeSession({
    network: 'mainnet', identityId: ID, identityIndex: null, keyId: 6, securityLevel: SecurityLevel.HIGH, source, privateKey: new Uint8Array(32).fill(1), wallet: null,
    ...(source === 'wallet' ? { boundContractId: FORUM } : {}),
  });
const failing = (e: unknown) => ({ writeDocument: async () => Promise.reject(e), balance: async () => 0n }) as unknown as PlatformPort;

describe('isDisabledKeyError', () => {
  it("matches Platform's disabled-key refusal for any key id, however it is wrapped", () => {
    for (const e of [
      new Error('Identity key 6 is disabled'),
      new Error('Identity key 123 is disabled'),
      new Error('Protocol error: consensus error: Identity key 0 is disabled'),
      new Error('identity public key id 12 has been disabled'),
      new Error('Public key 3 is disabled'),
      new Error('Identity Public Key #6 is disabled'),
      new Error('identity key with id 8 disabled'),
      new Error('Platform did not confirm this write (Identity key 6 is disabled). It may still appear.'),
      { message: 'state transition broadcast error: Identity key 9 is disabled' }, // a WASM error: not an Error instance
      { name: 'IdentityPublicKeyIsDisabledError', message: 'consensus error 40211' },
      new Error('broadcast failed', { cause: new Error('Identity key 7 is disabled') }),
      { message: 'several errors', errors: [{ message: 'nonce' }, { message: 'Identity key 2 is disabled' }] },
      'Identity key 4 is disabled',
    ]) expect(isDisabledKeyError(e), String((e as Error).message ?? e)).toBe(true);
  });

  it('leaves every other failure alone', () => {
    for (const e of [
      null,
      undefined,
      new Error('signing key not found on the identity'),
      new Error('Identity key 6 is not found'),
      new Error('insufficient identity GgZe balance 10 required 20'),
      new Error('The submit button is disabled'),
      new Error('masternode key 1 is disabled'),
      new Error('Your API key 2 is disabled'),
      new Error('This session has ended. Sign in again.'),
      { toString: () => '[object Object]' },
      42,
    ]) expect(isDisabledKeyError(e)).toBe(false);
  });
});

describe('a wallet session whose key is disabled', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects with the session-ended error, logs the raw one, and reports it once', async () => {
    const raw = new Error('Identity key 6 is disabled');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onKeyDisabled = vi.fn();
    const s = appSessionFromAuth(session('wallet'), async () => failing(raw), onKeyDisabled);
    const e = await s.signAndBroadcastDocument(OP).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletSessionEndedError);
    expect((e as Error).message).toBe(WALLET_SESSION_ENDED_TEXT);
    expect((e as Error).message).not.toMatch(/key 6/);
    expect((e as Error).cause).toBe(raw);
    expect(onKeyDisabled).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'), raw);
  });

  it('other failures, and a disabled key of a session that is not a wallet one, pass through unchanged', async () => {
    const onKeyDisabled = vi.fn();
    const other = new Error('insufficient identity x balance 1 required 2');
    await expect(appSessionFromAuth(session('wallet'), async () => failing(other), onKeyDisabled).signAndBroadcastDocument(OP)).rejects.toBe(other);
    const disabled = new Error('Identity key 6 is disabled');
    await expect(appSessionFromAuth(session('key'), async () => failing(disabled), onKeyDisabled).signAndBroadcastDocument(OP)).rejects.toBe(disabled);
    expect(onKeyDisabled).not.toHaveBeenCalled();
  });
});

describe('the sign-out and the prompt', () => {
  const ForumCtx = createContext<unknown>(null);
  h.useForum = () => useContext(ForumCtx);
  /** ForumProvider's session slot: replacing or clearing a session closes it. */
  function FakeForum({ children }: { children: ReactNode }) {
    const [s, setS] = useState<AppSession | null>(null);
    const ref = useRef<AppSession | null>(null);
    const set = useCallback((n: AppSession | null) => {
      if (ref.current === n) return;
      ref.current?.close();
      ref.current = n;
      setS(n);
    }, []);
    const signOut = useCallback(() => set(null), [set]);
    const value = useMemo(() => ({ session: s, signIn: set, signOut, balance: null, refreshBalance: () => {}, forum: { store: null } }), [s, set, signOut]);
    return <ForumCtx.Provider value={value}>{children}</ForumCtx.Provider>;
  }

  async function mount() {
    const t = { auth: null as unknown as ReturnType<typeof UseAuth>, forum: null as unknown as { session: AppSession | null } };
    const Probe = () => {
      t.auth = useAuth();
      t.forum = h.useForum() as typeof t.forum;
      return (
        <>
          <WalletSessionEnded />
          <WriteError error={WALLET_SESSION_ENDED_TEXT} />
        </>
      );
    };
    const r = await render(
      <FakeForum>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </FakeForum>,
    );
    return { r, get: () => t };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('signs the wallet session out (key wiped), shows one message with Reconnect, and Reconnect opens App Connect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.port = failing(new Error('Identity key 11 is disabled'));
    const m = await mount();
    const auth = session('wallet');
    m.get().auth.signIn(auth);
    await flush();
    const app = m.get().forum.session!;
    expect(app.identityId).toBe(ID);
    await expect(app.signAndBroadcastDocument(OP)).rejects.toBeInstanceOf(WalletSessionEndedError);
    await flush();
    expect(m.get().forum.session).toBeNull();
    expect(auth.ended).toBe(true);
    expect(auth.privateKey.every((b) => b === 0)).toBe(true);
    expect(m.get().auth.walletEnded).toBe(true);
    const banners = m.r.el.querySelectorAll('[data-testid="wallet-session-ended"]');
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toContain(WALLET_SESSION_ENDED_TEXT);
    expect(m.r.el.textContent).not.toMatch(/key 11|disabled/i);
    expect(m.r.el.querySelector('[data-testid="write-error"]')).toBeNull(); // the inline error leaves it to the banner
    m.r.el.querySelector<HTMLButtonElement>('[data-testid="wallet-reconnect"]')!.click();
    await flush();
    expect(m.get().auth.sheet).toBe('wallet');
    expect(m.get().auth.walletEnded).toBe(false);
    expect(m.r.el.querySelector('[data-testid="wallet-session-ended"]')).toBeNull();
    expect(m.r.el.querySelector('[data-testid="write-error"]')?.textContent).toBe(WALLET_SESSION_ENDED_TEXT); // no banner: said inline
    await m.r.unmount();
  });

  it('a write that fails after its session was replaced signs nobody out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail!: (e: unknown) => void;
    h.port = { writeDocument: () => new Promise((_, reject) => (fail = reject)), balance: async () => 0n } as unknown as PlatformPort;
    const m = await mount();
    m.get().auth.signIn(session('wallet'));
    await flush();
    const pending = m.get().forum.session!.signAndBroadcastDocument(OP).catch((e: unknown) => e);
    await flush();
    const next = session('wallet');
    // the old write fails right after the new sign-in, before React has run its effects
    await act(async () => {
      m.get().auth.signIn(next);
      fail(new Error('Identity key 6 is disabled'));
    });
    expect(await pending).toBeInstanceOf(WalletSessionEndedError);
    await flush();
    expect(m.get().forum.session).not.toBeNull();
    expect(next.ended).toBe(false);
    expect(m.get().auth.walletEnded).toBe(false);
    await m.r.unmount();
  });
});
