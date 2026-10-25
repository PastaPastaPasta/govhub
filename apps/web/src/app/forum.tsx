// Social state shared by every page: the forum data source, the signed-in Session (and its balance), and the
// moderation lists the reader subscribes to, merged into one hide index.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildHideIndex, EMPTY_HIDE_INDEX, type BlockList, type DocumentOp, type DocumentResult, type HideIndex } from '@govhub/forum';
import { createForum, fixtureForum, type ForumSource } from '../data/forum.ts';
import { seedFixtureForum } from '../data/fixtureForum.ts';
import { loadFixtures } from '../data/fixtures.ts';
import { errText } from '../lib/format.ts';
import { endSession } from '../session/end.ts';
import { assertCanAffordWrite, topUpFromError } from '../voting/funds.ts';
import type { Session } from '../session/session.ts';
import { useApp } from './context.tsx';
import { failedText, loadLocalSubs, readModeration, saveLocalSubs, type Subscriptions } from './moderationLoad.ts';

interface ModerationState {
  index: HideIndex;
  lists: BlockList[];
  subs: Subscriptions;
  loading: boolean;
  /** the lists have been read at least once for this identity and network: until then nothing may be shown unfiltered */
  ready: boolean;
  error?: string;
}

interface ForumCtx {
  forum: ForumSource;
  session: Session | null;
  signIn(s: Session): void;
  signOut(): void;
  /** credits, null while unknown */
  balance: bigint | null;
  refreshBalance(): void;
  /** Signs and broadcasts through the session, then refreshes the balance. Throws when signed out, and a `TopUpError` when the balance is too low. */
  write(op: DocumentOp): Promise<DocumentResult>;
  moderation: ModerationState;
  reloadModeration(): void;
  /** Changes the subscriptions locally (this browser); `publish` also writes them to the user's blockSubs document. */
  setSubs(s: Subscriptions, publish?: boolean): Promise<void>;
}

const Ctx = createContext<ForumCtx | null>(null);

export function useForum(): ForumCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useForum outside ForumProvider');
  return c;
}

export function ForumProvider({ children }: { children: ReactNode }) {
  const { mode, registry, source } = useApp();
  const tick = useRef(0);
  const forum = useMemo(
    () =>
      createForum(mode, registry, () =>
        fixtureForum(registry, async (store) => seedFixtureForum(store, registry, (await loadFixtures()).now * 1000), () => (source.now() || Math.floor(Date.now() / 1000)) * 1000 + ++tick.current * 1000),
      ),
    [mode, registry, source],
  );
  const [session, setSessionState] = useState<Session | null>(null);
  // The session is replaced or ended synchronously (not inside a state updater, which React may run later): its key and everything
  // derived from it (session/end.ts hooks: the masternode keyring) are wiped before the click or `pagehide` handler returns.
  const sessionRef = useRef<Session | null>(null);
  const setSession = useCallback((next: Session | null) => {
    const old = sessionRef.current;
    if (old === next) return;
    endSession(next?.identityId ?? null);
    sessionRef.current = next;
    old?.close();
    setSessionState(next);
  }, []);
  const [balance, setBalance] = useState<bigint | null>(null);
  const balanceRef = useRef<bigint | null>(null);
  balanceRef.current = balance;
  const [modNonce, setModNonce] = useState(0);
  const [moderation, setModeration] = useState<ModerationState>({ index: EMPTY_HIDE_INDEX, lists: [], subs: loadLocalSubs(), loading: true, ready: false });

  // A different network or data mode means a different identity space: sign out.
  useEffect(() => () => setSession(null), [forum, setSession]);

  const refreshBalance = useCallback(() => {
    if (!session) return setBalance(null);
    session.balance().then(setBalance, () => setBalance(null));
  }, [session]);
  useEffect(refreshBalance, [refreshBalance]);

  const signIn = useCallback((s: Session) => setSession(s), [setSession]);
  const signOut = useCallback(() => setSession(null), [setSession]);

  const write = useCallback(
    async (op: DocumentOp) => {
      if (!session) throw new Error('sign in first');
      // Fixture mode shows sample data only: a real identity would sign real documents that never appear here.
      if (forum.store && 'auth' in session) throw new Error('Fixture mode shows sample data only. Switch to live data (Settings) and sign in again to post with your identity.');
      // Platform wants more available than the fee (see `upfrontRequired`): say so before signing, and put its own refusal in plain
      // words (the balance read can lag, so the refusal is still worded the same way).
      assertCanAffordWrite(balanceRef.current, op);
      try {
        return await session.signAndBroadcastDocument(op);
      } catch (e) {
        throw topUpFromError(e, 'forum');
      } finally {
        refreshBalance();
      }
    },
    [session, refreshBalance, forum],
  );

  // A different identity or network has different lists: fail closed until they are read again.
  useEffect(() => setModeration((m) => ({ ...m, index: EMPTY_HIDE_INDEX, lists: [], ready: false })), [forum, session]);

  // Moderation lists: the subscriptions (Platform document when signed in and present, else this browser), then
  // every list they name plus the user's own list.
  useEffect(() => {
    let live = true;
    const { reader } = forum;
    const mod = registry.forum;
    setModeration((m) => ({ ...m, loading: true }));
    readModeration(reader, { identityId: session?.identityId ?? null, moderationIdentityId: mod.moderationIdentityId, moderationName: mod.moderationName, localSubs: loadLocalSubs() })
      .then(({ lists, subs, failed }) => {
        if (live) setModeration({ index: buildHideIndex(lists), lists, subs, loading: false, ready: true, ...(failed.length ? { error: failedText(failed) } : {}) });
      })
      .catch((e: unknown) => live && setModeration((m) => ({ ...m, loading: false, ready: true, error: errText(e) })));
    return () => {
      live = false;
    };
  }, [forum, registry.forum, session, modNonce]);

  const reloadModeration = useCallback(() => setModNonce((n) => n + 1), []);

  const setSubs = useCallback(
    async (s: Subscriptions, publish = false) => {
      saveLocalSubs(s);
      if (publish) await write(forum.ops.blockSubs(s.lists, s.defaultOff, s.doc));
      reloadModeration();
    },
    [forum, write, reloadModeration],
  );

  const value = useMemo<ForumCtx>(
    () => ({ forum, session, signIn, signOut, balance, refreshBalance, write, moderation, reloadModeration, setSubs }),
    [forum, session, signIn, signOut, balance, refreshBalance, write, moderation, reloadModeration, setSubs],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
