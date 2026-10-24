// Social state shared by every page: the forum data source, the signed-in Session (and its balance), and the
// moderation lists the reader subscribes to, merged into one hide index.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildHideIndex, EMPTY_HIDE_INDEX, isIdentifier, type BlockList, type DocumentOp, type DocumentResult, type HideIndex } from '@govhub/forum';
import { createForum, fixtureForum, type ForumSource } from '../data/forum.ts';
import { seedFixtureForum } from '../data/fixtureForum.ts';
import { loadFixtures } from '../data/fixtures.ts';
import { errText, shortHash } from '../lib/format.ts';
import type { Session } from '../session/session.ts';
import { useApp } from './context.tsx';

/** Which lists the reader applies (PLAN §9): the default list unless turned off, plus subscribed list owners. */
export interface Subscriptions {
  defaultOff: boolean;
  lists: string[];
  /** where these came from: this browser, or the user's `blockSubs` document (id + revision for replacing it) */
  doc?: { id: string; revision: number };
}

const SUBS_KEY = 'govhub.blockSubs.v1';

export function loadLocalSubs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Subscriptions {
  try {
    const v = JSON.parse(storage?.getItem(SUBS_KEY) ?? 'null') as { defaultOff?: unknown; lists?: unknown } | null;
    const lists = Array.isArray(v?.lists) ? v.lists.filter(isIdentifier).slice(0, 160) : [];
    return { defaultOff: v?.defaultOff === true, lists: [...new Set(lists)] };
  } catch {
    return { defaultOff: false, lists: [] };
  }
}

const saveLocalSubs = (s: Subscriptions) => localStorage.setItem(SUBS_KEY, JSON.stringify({ defaultOff: s.defaultOff, lists: s.lists }));

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
  /** Signs and broadcasts through the session, then refreshes the balance. Throws when signed out. */
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
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [modNonce, setModNonce] = useState(0);
  const [moderation, setModeration] = useState<ModerationState>({ index: EMPTY_HIDE_INDEX, lists: [], subs: loadLocalSubs(), loading: true, ready: false });

  // A different network or data mode means a different identity space: sign out.
  useEffect(() => () => setSession((s) => (s?.close(), null)), [forum]);

  const refreshBalance = useCallback(() => {
    if (!session) return setBalance(null);
    session.balance().then(setBalance, () => setBalance(null));
  }, [session]);
  useEffect(refreshBalance, [refreshBalance]);

  const signIn = useCallback((s: Session) => {
    setSession((old) => (old?.close(), s));
  }, []);
  const signOut = useCallback(() => setSession((old) => (old?.close(), null)), []);

  const write = useCallback(
    async (op: DocumentOp) => {
      if (!session) throw new Error('sign in first');
      // Fixture mode shows sample data only: a real identity would sign real documents that never appear here.
      if (forum.store && 'auth' in session) throw new Error('Fixture mode shows sample data only. Switch to live data (Settings) to post with your identity.');
      try {
        return await session.signAndBroadcastDocument(op);
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
    (async () => {
      let subs = loadLocalSubs();
      if (session) {
        const doc = await reader.blockSubs(session.identityId).catch(() => null);
        if (doc) subs = { defaultOff: doc.defaultOff, lists: doc.lists, doc: { id: doc.id, revision: doc.revision } };
      }
      const wanted: Array<Promise<BlockList>> = [];
      if (!subs.defaultOff) wanted.push(reader.blocks('mod', mod.moderationIdentityId).then((blocks) => ({ source: 'default', ownerId: mod.moderationIdentityId, name: mod.moderationName, blocks })));
      for (const owner of subs.lists) wanted.push(reader.blocks('forum', owner).then((blocks) => ({ source: 'subscription', ownerId: owner, name: `list ${shortHash(owner, 4)}`, blocks })));
      if (session) wanted.push(reader.blocks('forum', session.identityId).then((blocks) => ({ source: 'mine', ownerId: session.identityId, name: 'your blocks', blocks })));
      const settled = await Promise.allSettled(wanted);
      const lists = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = settled.filter((r) => r.status === 'rejected').length;
      if (live) setModeration({ index: buildHideIndex(lists), lists, subs, loading: false, ready: true, ...(failed ? { error: `${failed} block list(s) could not be read` } : {}) });
    })().catch((e: unknown) => live && setModeration((m) => ({ ...m, loading: false, ready: true, error: errText(e) })));
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
