// Sign-in state for the real sessions (@govhub/auth: seed, pasted key, passkey). The app has ONE signed-in session, held by
// ForumProvider as the app-level `Session` (session/session.ts); a real sign-in is wrapped by appSessionFromAuth and handed to it, so
// every write goes through @govhub/auth's document writer. This provider adds what only real sessions have (funding records, the
// sign-in sheet, top-ups and passkeys). The signing key lives in this tab's memory only; keeping it across visits is opt-in and goes
// through the passkey vault, never plain storage.
import { storageFundingStore, type FundingStore, type Network, type PlatformPort, type Session } from '@govhub/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { appSessionFromAuth, type AppAuthSession } from '../session/authSession.ts';
import { getAuthDapi, getPlatformPort } from './runtime.ts';

export type SheetView = 'choose' | 'create' | 'phrase' | 'key' | 'passkey' | 'topup' | 'passkeys';

interface AuthCtx {
  /** The real auth session behind the app session, when the app is signed in through @govhub/auth. */
  session: Session | null;
  /** Credits; null while unknown. */
  balance: bigint | null;
  network: Network;
  forumContractId: string;
  signIn(s: Session): void;
  signOut(): void;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const { registry } = useApp();
  const forum = useForum();
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const store = useMemo(() => storageFundingStore(localStorage), []);
  const platform = useCallback(() => getPlatformPort(registry), [registry]);
  const dapi = useCallback(() => getAuthDapi(registry), [registry]);

  const session = (forum.session as Partial<AppAuthSession> | null)?.auth ?? null;
  const { signIn: forumSignIn, signOut: forumSignOut } = forum;
  const signIn = useCallback((s: Session) => forumSignIn(appSessionFromAuth(s, platform)), [forumSignIn, platform]);
  const signOut = useCallback(() => {
    forumSignOut(); // closes the app session, which ends the auth session (wipes the key and the seed)
    setSheet(null);
  }, [forumSignOut]);

  // Leaving the page signs out completely: the key is wiped and the session dropped, so a page restored from the back/forward cache
  // never shows a session whose key bytes are already zero (they would derive keys anyone can compute).
  useEffect(() => {
    const onHide = () => signOut();
    const onShow = (e: PageTransitionEvent) => e.persisted && signOut();
    addEventListener('pagehide', onHide);
    addEventListener('pageshow', onShow);
    return () => {
      removeEventListener('pagehide', onHide);
      removeEventListener('pageshow', onShow);
    };
  }, [signOut]);
  useEffect(() => {
    const open = () => setSheet('choose');
    addEventListener(OPEN_SIGNIN_EVENT, open);
    return () => removeEventListener(OPEN_SIGNIN_EVENT, open);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      session, balance: session ? forum.balance : null, network: registry.platformNetwork, forumContractId: registry.forum.contractId, signIn, signOut,
      refreshBalance: forum.refreshBalance, platform, dapi, store, sheet, openSheet: setSheet, closeSheet: () => setSheet(null),
    }),
    [session, forum.balance, forum.refreshBalance, registry.platformNetwork, registry.forum.contractId, signIn, signOut, platform, dapi, store, sheet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
