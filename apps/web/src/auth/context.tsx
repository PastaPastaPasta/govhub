// Sign-in state for the real sessions (@govhub/auth: seed, pasted key, passkey). The app has ONE signed-in session, held by
// ForumProvider as the app-level `Session` (session/session.ts); a real sign-in is wrapped by appSessionFromAuth and handed to it, so
// every write goes through @govhub/auth's document writer. This provider adds what only real sessions have (funding records, the
// sign-in sheet, top-ups and passkeys). The signing key lives in memory only, shared with this browser's other open govhub tabs
// (session/tabShare.ts), and so is the masternode keyring's lock; keeping it across browser restarts is opt-in and goes through the
// passkey vault, never plain storage.
import { storageFundingStore, type FundingStore, type Network, type PlatformPort, type Session } from '@govhub/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { appSessionFromAuth, type AppAuthSession } from '../session/authSession.ts';
import { createTabShare, type TabShare } from '../session/tabShare.ts';
import { getAuthDapi, getPlatformPort } from './runtime.ts';

export type SheetView = 'choose' | 'create' | 'phrase' | 'key' | 'passkey' | 'topup' | 'passkeys';

/** The masternode keyring's lock (voting/KeyringContext.tsx), one for the open tabs of the session (session/tabShare.ts, D-015). */
export interface KeyringLockCtl {
  /** Locked for `identityId`: its saved keyring opens with the phrase or a passkey only, never with the session's seed. */
  locked(identityId: string): boolean;
  /** Locks the keyring in every tab (Lock now, idle lock). */
  lock(): void;
  /** The phrase or a passkey opened `identityId`'s keyring in this tab: a tab that takes the session over may open it with the seed. */
  unlocked(identityId: string): void;
  /**
   * Wires this tab's keyring in: `locked` runs when another tab locks it, `beforeShare` before this tab hands the session to a new
   * tab (an idle lock that is due locks first, so the new tab never beats it). Both synchronous. Returns the unwire function.
   */
  attach(k: KeyringHooks): () => void;
}
export interface KeyringHooks {
  locked(): void;
  beforeShare(): void;
}

interface AuthCtx {
  /** The real auth session behind the app session, when the app is signed in through @govhub/auth. */
  session: Session | null;
  /** True while a session handed over by another tab is being signed in with. */
  restoring: boolean;
  /** Credits; null while unknown. */
  balance: bigint | null;
  network: Network;
  forumContractId: string;
  /** Signs in this tab and the other open tabs of this profile. */
  signIn(s: Session): void;
  /** Signs out this tab and the other open tabs of this profile. */
  signOut(): void;
  keyringLock: KeyringLockCtl;
  refreshBalance(): void;
  platform(): Promise<PlatformPort>;
  dapi(): ReturnType<typeof getAuthDapi>;
  store: FundingStore;
  sheet: SheetView | null;
  openSheet(v: SheetView): void;
  closeSheet(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

/** Fired by `openSignIn()` (ui/SignIn.tsx): "Sign in to comment" buttons open the sheet. */
export const OPEN_SIGNIN_EVENT = 'govhub:signin';

/**
 * Every tab of an origin hears the tab-sharing channel, so the session is shared only where govhub has its origin to itself: not
 * from a sub-path (GitHub Pages before the custom domain, where the account's other Pages sites share the origin).
 */
const SHARE_TABS = import.meta.env.BASE_URL === '/';

export function AuthProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const forum = useForum();
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [restoring, setRestoring] = useState(false);
  const share = useRef<TabShare | null>(null);
  const keyringHooks = useRef<KeyringHooks | null>(null);
  // No sharing (a sub-path): this tab's own lock (voting/gate.ts KeyringLock) is the only one. Sharing but no channel yet: locked.
  const keyringLock = useMemo<KeyringLockCtl>(
    () => ({
      locked: (id) => (share.current ? share.current.keyringLocked(id) : SHARE_TABS),
      lock: () => share.current?.lockKeyring(),
      unlocked: (id) => share.current?.unlockKeyring(id),
      attach(k) {
        keyringHooks.current = k;
        return () => {
          if (keyringHooks.current === k) keyringHooks.current = null;
        };
      },
    }),
    [],
  );
  const store = useMemo(() => storageFundingStore(localStorage), []);
  const platform = useCallback(() => getPlatformPort(registry), [registry]);
  const dapi = useCallback(() => getAuthDapi(registry), [registry]);

  const session = (forum.session as Partial<AppAuthSession> | null)?.auth ?? null;
  const { signIn: forumSignIn, signOut: forumSignOut } = forum;
  const signInHere = useCallback((s: Session) => forumSignIn(appSessionFromAuth(s, platform)), [forumSignIn, platform]);
  const signOutHere = useCallback(() => {
    forumSignOut(); // closes the app session, which ends the auth session (wipes the key and the seed)
    setSheet(null);
  }, [forumSignOut]);
  const signIn = useCallback((s: Session) => {
    signInHere(s);
    share.current?.announce(s);
  }, [signInHere]);
  const signOut = useCallback(() => {
    share.current?.signOut();
    signOutHere();
  }, [signOutHere]);

  // The other open tabs of this profile share the session (live data only: fixture tabs neither send nor adopt). A new channel per
  // profile asks the open tabs for theirs, so a new tab, or a profile switch to one another tab is signed in to, comes up signed in.
  const current = useRef(session);
  useEffect(() => {
    current.current = session;
  }, [session]);
  // another tab signed out: the views that need the session close, a sign-in in progress here stays
  const drop = useCallback(() => {
    forumSignOut();
    setSheet((v) => (v === 'topup' || v === 'passkeys' ? null : v));
  }, [forumSignOut]);
  useEffect(() => {
    if (!SHARE_TABS) return;
    const s = createTabShare({
      profile: `${registry.platformNetwork}:${registry.forum.contractId}`,
      live: () => mode === 'live',
      current: () => current.current,
      platform,
      adopt: signInHere,
      drop,
      restoring: setRestoring,
      keyringLocked: () => keyringHooks.current?.locked(),
      beforeAnswer: () => keyringHooks.current?.beforeShare(),
    });
    share.current = s;
    s.request();
    return () => {
      share.current = null;
      s.close();
    };
  }, [registry.platformNetwork, registry.forum.contractId, mode, platform, signInHere, drop]);

  // Leaving the page wipes this tab's copy (the other tabs keep theirs: nothing is announced), so a page restored from the
  // back/forward cache never shows a session whose key bytes are already zero (they would derive keys anyone can compute). The
  // restored page asks the open tabs for the session again.
  useEffect(() => {
    const onHide = () => {
      share.current?.suspend();
      signOutHere();
    };
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      signOutHere();
      share.current?.resume();
    };
    addEventListener('pagehide', onHide);
    addEventListener('pageshow', onShow);
    return () => {
      removeEventListener('pagehide', onHide);
      removeEventListener('pageshow', onShow);
    };
  }, [signOutHere]);
  useEffect(() => {
    const open = () => setSheet('choose');
    addEventListener(OPEN_SIGNIN_EVENT, open);
    return () => removeEventListener(OPEN_SIGNIN_EVENT, open);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      session, restoring: restoring && !session, balance: session ? forum.balance : null, network: registry.platformNetwork, forumContractId: registry.forum.contractId, signIn, signOut, keyringLock,
      refreshBalance: forum.refreshBalance, platform, dapi, store, sheet, openSheet: setSheet, closeSheet: () => setSheet(null),
    }),
    [session, restoring, forum.balance, forum.refreshBalance, registry.platformNetwork, registry.forum.contractId, signIn, signOut, keyringLock, platform, dapi, store, sheet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
