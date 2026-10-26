// @vitest-environment happy-dom
// D-015 across tabs: two or more "tabs" (each its own AuthProvider + KeyringProvider, talking over the real BroadcastChannel) share a
// seed sign-in (session/tabShare.ts). A lock in one tab (Lock now or the idle lock) wipes the keys in every tab, and no tab opens the
// saved keyring with the seed again (a new tab, a reload) until the phrase unlocks it. Platform is a fake (the saved keyring store
// and the identity lookups); the providers and the tab sharing are the real ones.
import {
  hash160, KeyPurpose, makeSession, publicKeyOf, randomBytes, SecurityLevel, SeedWallet, toBase58, type IdentityKeyInfo, type OpenedKeyring,
  type PlatformPort, type Session,
} from '@govhub/auth';
import { act, createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import type { Session as AppSession } from '../session/session.ts';
import { flush, render } from '../test/render.tsx';
import type { useAuth as UseAuth } from '../auth/context.tsx';
import type { useKeyring as UseKeyring } from './KeyringContext.tsx';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_ID = toBase58(randomBytes(32));

const h = vi.hoisted(() => ({
  useForum: null as unknown as () => unknown,
  port: null as unknown as PlatformPort,
  /** every saved-keyring open, and the keyrings handed out (to check they were wiped) */
  loads: 0,
  rings: [] as Array<{ content: { keys: Array<{ privateKey: Uint8Array }> } }>,
  /** the seed unlocker's and one passkey unlocker's public keys: only they open the saved keyring */
  unlocker: null as Uint8Array | null,
  passkeyUnlocker: null as Uint8Array | null,
  /** set: the next open waits for it (a slow Platform) */
  gate: null as Promise<void> | null,
  /** no saved keyring on Platform */
  absent: false,
}));
vi.mock('../app/context.tsx', async () => {
  // a testnet-Platform profile: the keyring below is derived for testnet
  const { profileRegistry } = await import('../config/registry.ts');
  const app = { registry: { ...profileRegistry('dev'), bridges: [], relays: [] }, mode: 'live' };
  return { useApp: () => app };
});
vi.mock('../app/forum.tsx', () => ({ useForum: () => h.useForum() }));
vi.mock('./../auth/runtime.ts', async (orig) => ({ ...(await orig<object>()), getPlatformPort: async () => h.port, getAuthDapi: () => ({}) }));
vi.mock('../data/platform.ts', async (orig) => ({ ...(await orig<object>()), getSdk: async () => ({}) }));
vi.mock('../data/dapi.ts', async (orig) => ({ ...(await orig<object>()), createWebDapi: () => ({}) }));
vi.mock('@dashevo/evo-sdk', () => ({}));
vi.mock('@govhub/auth/keyring-evo', () => ({ createEvoKeyringStore: () => ({}) }));
// the saved keyring on "Platform": opens for PHRASE's seed unlocker only (the session's seed or the phrase typed), with one voting key
vi.mock('@govhub/auth', async (orig) => {
  const real = await orig<typeof import('@govhub/auth')>();
  return {
    ...real,
    loadKeyring: async (_ctx: unknown, identityId: string, key: { pair: { publicKey: Uint8Array } }): Promise<OpenedKeyring> => {
      h.loads++;
      if (h.gate) await h.gate;
      if (h.absent) return null as unknown as OpenedKeyring;
      const is = (u: Uint8Array | null) => !!u && u.length === key.pair.publicKey.length && u.every((b, i) => b === key.pair.publicKey[i]);
      if (!is(h.unlocker) && !is(h.passkeyUnlocker)) throw new real.KeyringLockedError();
      const k = real.emptyKeyring(identityId, []);
      k.content.keys.push({ privateKey: fixtureMnKey(1).slice(), compressed: true, label: 'mn' });
      h.rings.push(k);
      return { ...k, authenticated: true } as OpenedKeyring;
    },
  };
});

const { AuthProvider, useAuth } = await import('../auth/context.tsx');
const { passkeyUnlockKey, seedUnlockKey } = await import('@govhub/auth');
const { stashPasskeyUnlock } = await import('./stash.ts');
/** The PRF output of the user's passkey, an unlocker of the saved keyring. */
const GOOD_PRF = new Uint8Array(32).fill(7);
const { KeyringProvider, useKeyring } = await import('./KeyringContext.tsx');

/** Just enough Platform for a seed sign-in handed over between tabs. */
function fakePort(): PlatformPort {
  const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
  const info = (id: number, level: number, priv: Uint8Array) =>
    ({ id, purpose: KeyPurpose.AUTHENTICATION, securityLevel: level, type: 0, data: publicKeyOf(priv), disabled: false, bound: false }) as IdentityKeyInfo;
  const keys = [info(0, SecurityLevel.MASTER, w.identityKey(0, 0).privateKey), info(2, SecurityLevel.HIGH, w.identityKey(0, 2).privateKey)];
  w.wipe();
  return {
    network: 'testnet',
    identityKeys: async (id: string) => (id === SEED_ID ? keys : null),
    identityByUniqueKeyHash: async (x: Uint8Array) => (keys.some((k) => hash160(k.data).every((b, i) => b === x[i])) ? SEED_ID : null),
    identitiesByNonUniqueKeyHash: async () => [],
    balance: async () => 0n,
  } as unknown as PlatformPort;
}
h.port = fakePort();

const seedSession = (): Session => {
  const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
  return makeSession({ network: 'testnet', identityId: SEED_ID, identityIndex: 0, keyId: 2, securityLevel: SecurityLevel.HIGH, source: 'seed', privateKey: wallet.identityKey(0, 2).privateKey, wallet });
};

{
  const s = seedSession();
  const k = seedUnlockKey(s)!;
  h.unlocker = k.pair.publicKey.slice();
  k.wipe();
  s.end();
  const p = passkeyUnlockKey(GOOD_PRF.slice());
  h.passkeyUnlocker = p.pair.publicKey.slice();
  p.wipe();
}
/** A passkey sign-in (Passkeys.tsx): the vault gives the seed, the same ceremony's PRF output is stashed for the keyring. */
function passkeySignIn(t: Tab, prf: Uint8Array) {
  const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
  const s = makeSession({ network: 'testnet', identityId: SEED_ID, identityIndex: 0, keyId: 2, securityLevel: SecurityLevel.HIGH, source: 'passkey', privateKey: wallet.identityKey(0, 2).privateKey, wallet, credentialId: new Uint8Array(16).fill(1) });
  stashPasskeyUnlock(SEED_ID, prf.slice());
  t.auth.signIn(s);
}

/** One tab's ForumProvider: just the session slot (the real one also runs session/end.ts hooks, which are global to this test). */
const ForumCtx = createContext<unknown>(null);
h.useForum = () => useContext(ForumCtx);
function FakeForum({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const ref = useRef<AppSession | null>(null);
  const set = useCallback((s: AppSession | null) => {
    if (ref.current === s) return;
    ref.current?.close();
    ref.current = s;
    setSession(s);
  }, []);
  const signOut = useCallback(() => set(null), [set]);
  const value = useMemo(() => ({ session, signIn: set, signOut, balance: null, refreshBalance: () => {} }), [session, set, signOut]);
  return <ForumCtx.Provider value={value}>{children}</ForumCtx.Provider>;
}

interface Tab {
  auth: ReturnType<typeof UseAuth>;
  kr: ReturnType<typeof UseKeyring>;
  close(): Promise<void>;
}
const tabs: Tab[] = [];
afterEach(async () => {
  h.gate = null;
  h.absent = false;
  for (const t of tabs.splice(0)) await t.close();
  vi.restoreAllMocks();
});

/** Opens a tab and lets it ask the open tabs for the session (and open the keyring if it may). */
async function openTab(): Promise<Tab> {
  const t = {} as Tab;
  const Probe = () => {
    t.auth = useAuth();
    t.kr = useKeyring();
    return null;
  };
  const r = await render(
    <FakeForum>
      <AuthProvider>
        <KeyringProvider>
          <Probe />
        </KeyringProvider>
      </AuthProvider>
    </FakeForum>,
  );
  t.close = () => r.unmount();
  tabs.push(t);
  await settle();
  return t;
}
/** Lets the channel deliver and the hand-over sign-in (PBKDF2) and the keyring open finish. */
async function settle() {
  for (let i = 0; i < 30; i++) await flush();
}
const wiped = (k: { content: { keys: Array<{ privateKey: Uint8Array }> } }) => k.content.keys.every((x) => x.privateKey.every((b) => b === 0));

describe('the keyring lock covers every tab of the session (D-015)', () => {
  it('a fresh sign-in in a single tab opens the keyring with the seed, as before', async () => {
    const a = await openTab();
    expect(a.kr.status).toBe('signed-out');
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    expect(a.kr.status).toBe('open');
  });

  it('Lock now: the other tab wipes its keys; a new tab and a reload stay locked; the phrase unlocks one tab only', async () => {
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    const b = await openTab();
    expect(b.auth.session?.identityId).toBe(SEED_ID);
    expect(b.kr.status).toBe('open');
    const bRing = b.kr.keyring!;
    expect(wiped(bRing)).toBe(false);

    await act(async () => a.kr.lock());
    expect(wiped(bRing)).toBe(true); // synchronously, before React re-renders
    await settle();
    expect(a.kr.status).toBe('locked');
    expect(b.kr.status).toBe('locked');
    expect(b.kr.keyring).toBeNull();

    // a new tab (Ctrl+T) is signed in, with the keyring locked: the saved keyring is not even fetched
    const loads = h.loads;
    const c = await openTab();
    expect(c.auth.session?.identityId).toBe(SEED_ID);
    expect(c.kr.status).toBe('locked');
    // a reload of a with b and c open
    await a.close();
    const a2 = await openTab();
    expect(a2.auth.session?.identityId).toBe(SEED_ID);
    expect(a2.kr.status).toBe('locked');
    expect(h.loads).toBe(loads);

    // the phrase in b opens b; the open tabs stay locked; a tab opened from now on may open it with the seed
    await act(async () => b.kr.unlockWithPhrase(PHRASE));
    await settle();
    expect(b.kr.status).toBe('open');
    expect(c.kr.status).toBe('locked');
    expect(a2.kr.status).toBe('locked');
    const d = await openTab();
    expect(d.kr.status).toBe('open');
  });

  it('the idle lock propagates, and a new tab never beats an idle lock that is due but has not fired', async () => {
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    const b = await openTab();
    expect(a.kr.status).toBe('open');
    expect(b.kr.status).toBe('open');
    const aRing = a.kr.keyring!;
    const bRing = b.kr.keyring!;

    // both idle past the timeout; their 15 s checks have not run yet (throttled in the background) when a new tab asks
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 20 * 60_000);
    const loads = h.loads;
    const c = await openTab();
    expect(c.auth.session?.identityId).toBe(SEED_ID);
    expect(c.kr.status).toBe('locked');
    expect(h.loads).toBe(loads);
    expect(a.kr.status).toBe('locked');
    expect(b.kr.status).toBe('locked');
    expect(wiped(aRing) && wiped(bRing)).toBe(true);
  });

  it('the idle lock of one tab (its own 15 s check) locks the other tab, which was in use', async () => {
    // the idle checks each tab starts while its keyring is open
    const checks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 15_000) checks.push(fn);
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    const aCheck = checks.at(-1)!;
    const b = await openTab();
    expect(b.kr.status).toBe('open');
    const bRing = b.kr.keyring!;
    // a has been idle past the timeout and its check runs; b is the tab in use (its check is not run)
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 20 * 60_000);
    await act(async () => aCheck());
    expect(wiped(bRing)).toBe(true);
    await settle();
    expect(a.kr.status).toBe('locked');
    expect(a.kr.error).toMatch(/locked itself after being idle/);
    expect(b.kr.status).toBe('locked');
  });

  it('a wrong phrase does not unlock: the tab and the tabs opened later stay locked', async () => {
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    await act(async () => a.kr.lock());
    await act(async () => a.kr.unlockWithPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow').catch(() => {}));
    await settle();
    expect(a.kr.status).toBe('locked');
    expect(a.kr.error).toMatch(/doesn't unlock/);
    const b = await openTab();
    expect(b.auth.session?.identityId).toBe(SEED_ID);
    expect(b.kr.status).toBe('locked');
  });

  it('a lock in another tab while this tab is still opening the keyring: the open keeps nothing', async () => {
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    let release!: () => void;
    h.gate = new Promise<void>((r) => (release = r));
    const b = await openTab(); // takes the session over (unlocked) and starts opening: Platform is slow
    expect(b.auth.session?.identityId).toBe(SEED_ID);
    expect(b.kr.status).toBe('checking');
    await act(async () => a.kr.lock());
    await act(async () => release());
    await settle();
    expect(b.kr.status).toBe('locked');
    expect(b.kr.keyring).toBeNull();
    expect(wiped(h.rings.at(-1)!)).toBe(true);
  });

  it('no saved keyring: only this session\'s own phrase lifts the lock (any phrase "opens" a keyring that does not exist)', async () => {
    h.absent = true;
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    expect(a.kr.status).toBe('absent');
    await act(async () => a.kr.createKeyring(true)); // memory-only keys
    await settle();
    await act(async () => a.kr.lock());
    await act(async () => a.kr.unlockWithPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow'));
    await settle();
    expect((await openTab()).kr.status).toBe('locked'); // still locked: a new tab does not even look
    await act(async () => a.kr.unlockWithPhrase(PHRASE));
    await settle();
    expect((await openTab()).kr.status).toBe('absent'); // unlocked: a new tab looks with the seed (and finds none)
  });

  it('a passkey sign-in opens the keyring with its own ceremony (a single tab too), and unlocks it for the tabs opened later', async () => {
    const a = await openTab();
    await act(async () => passkeySignIn(a, GOOD_PRF));
    await settle();
    expect(a.kr.status).toBe('open');
    const b = await openTab();
    expect(b.kr.status).toBe('open');
  });

  it('a passkey added to the vault while the keyring is locked, then a passkey sign-in: still locked, in every tab', async () => {
    const a = await openTab();
    await act(async () => a.auth.signIn(seedSession()));
    await settle();
    await act(async () => a.kr.lock());
    // whoever got at the unlocked browser enrolled their own passkey (it seals the seed in the vault, but is no keyring unlocker)
    await act(async () => passkeySignIn(a, new Uint8Array(32).fill(9)));
    await settle();
    expect(a.auth.session?.source).toBe('passkey');
    expect(a.kr.status).toBe('locked');
    const b = await openTab();
    expect(b.auth.session?.source).toBe('passkey');
    expect(b.kr.status).toBe('locked');
  });
});
