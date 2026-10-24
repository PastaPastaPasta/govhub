// Session state. The signing key lives in this tab's memory only (a Session from @govhub/auth); signing out or closing the tab
// drops it. Keeping it across visits is opt-in and goes through the passkey vault, never plain storage.
import { storageFundingStore, type FundingStore, type Network, type PlatformPort, type Session } from '@govhub/auth';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { getAuthDapi, getPlatformPort } from './runtime.ts';

export type SheetView = 'choose' | 'create' | 'phrase' | 'key' | 'passkey' | 'topup' | 'passkeys';

interface AuthCtx {
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const { registry } = useApp();
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const current = useRef<Session | null>(null);
  const store = useMemo(() => storageFundingStore(localStorage), []);

  const platform = useCallback(() => getPlatformPort(registry), [registry]);
  const dapi = useCallback(() => getAuthDapi(registry), [registry]);

  const refreshBalance = useCallback(() => {
    const s = current.current;
    if (!s) return;
    platform()
      .then((p) => p.balance(s.identityId))
      .then((b) => current.current === s && setBalance(b), () => {});
  }, [platform]);

  const signIn = useCallback(
    (s: Session) => {
      if (current.current && current.current !== s) current.current.end();
      current.current = s;
      setSession(s);
      setBalance(null);
      refreshBalance();
    },
    [refreshBalance],
  );
  const signOut = useCallback(() => {
    current.current?.end();
    current.current = null;
    setSession(null);
    setBalance(null);
    setSheet(null);
  }, []);

  // A session belongs to one Platform network: switching networks in Settings signs out.
  useEffect(() => {
    if (current.current && current.current.network !== registry.platformNetwork) signOut();
  }, [registry.platformNetwork, signOut]);
  // Wipe the key when the tab goes away (best effort; the memory is released anyway).
  useEffect(() => {
    const end = () => current.current?.end();
    addEventListener('pagehide', end);
    return () => removeEventListener('pagehide', end);
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      session, balance, network: registry.platformNetwork, forumContractId: registry.forumContractId, signIn, signOut, refreshBalance, platform, dapi, store,
      sheet, openSheet: setSheet, closeSheet: () => setSheet(null),
    }),
    [session, balance, registry.platformNetwork, registry.forumContractId, signIn, signOut, refreshBalance, platform, dapi, store, sheet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
