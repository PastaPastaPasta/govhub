// Holds and sends this browser's signed contest votes (contests/held.ts) on every page, so a spread-out vote goes out whichever govhub
// page is open at its time. Storage is the truth for votes still to send: every change is a read-modify-write under an exclusive
// Web Lock (tabs never overwrite each other), and one tab sends at a time (a second lock). A vote is claimed ("sending", with the
// time) before it is sent, so no other tab sends, cancels or replaces it meanwhile. Sent and failed votes are kept in memory only.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { base64 } from '@scure/base';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { cryptoRand32 } from '../voting/plan.ts';
import { dueVotes, GUEST_OWNER, loadHeld, OLD_KEYS, OVERDUE_MS, reclaimCutOff, respreadOverdue, retryDelayMs, saveHeld, storageKey, type HeldVote } from './held.ts';
import { useContestSource } from './useContests.ts';
import { classifySendError, sameChoice } from './vote.ts';

interface Ctx {
  /** this reader's votes on this network: still to send, and those sent or failed in this tab */
  held: readonly HeldVote[];
  /** whose votes `held` shows: the signed-in identity, or GUEST_OWNER */
  owner: string;
  /** Every stored vote of this network, whoever signed it (for nonces), read now. */
  snapshot(): HeldVote[];
  /** Keeps signed votes; a vote still waiting (not being sent) for the same masternode and name is replaced. Throws when storage refuses. */
  add(votes: HeldVote[]): Promise<void>;
  /** Drops a vote that is still waiting: it is never sent. */
  cancel(id: string): Promise<void>;
  /** Sends these waiting votes at once, whatever their time. */
  sendNow(ids: readonly string[]): Promise<void>;
}

const VotesCtx = createContext<Ctx | null>(null);

export function useContestVotes(): Ctx {
  const c = useContext(VotesCtx);
  if (!c) throw new Error('useContestVotes outside ContestVotesProvider');
  return c;
}

const TICK_MS = 5000;
/** How often an unconfirmed vote (its nonce used, the read-back failed) is read back before it is given up on. */
const MAX_CHECKS = 5;
/** A vote with no known close (the open list could not be read) is not retried forever: about two hours of tries. */
const MAX_TRIES_NO_CLOSE = 30;
const SEND_LOCK = 'govhub-contest-votes-send';
const STORE_LOCK = 'govhub-contest-votes-store';
const store = (): Storage | undefined => globalThis.localStorage;
const locks = (): LockManager | undefined => (globalThis.navigator as Navigator | undefined)?.locks;

/** Runs `fn` holding the send lock (`exclusive`), or not at all when another tab holds it. Without Web Locks it simply runs. */
async function withSendLock(fn: (exclusive: boolean) => Promise<void>): Promise<void> {
  const l = locks();
  if (!l) return fn(false);
  await l.request(SEND_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) await fn(true);
  });
}

/** Runs `fn` holding the store lock (waits for it): a read-modify-write of the list that no other tab interleaves with. */
async function withStoreLock<T>(fn: () => T): Promise<T> {
  const l = locks();
  return l ? (l.request(STORE_LOCK, async () => fn()) as Promise<T>) : fn();
}

export function ContestVotesProvider({ children }: { children: ReactNode }) {
  const { registry } = useApp();
  const { session } = useForum();
  const src = useContestSource();
  const live = src.live;
  const network = registry.platformNetwork;
  const owner = session?.identityId ?? GUEST_OWNER;
  const scopeKey = storageKey(live, network);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  // what this tab saw finish (sent or failed): memory only
  const done = useRef<HeldVote[]>([]);
  const read = useCallback((): HeldVote[] => [...loadHeld(store(), live, network), ...done.current], [live, network]);
  const [all, setAll] = useState<HeldVote[]>([]);

  /** Applies a change to the stored list under the store lock (re-read first) and shows the result. Throws when storage refuses. */
  const apply = useCallback(
    (f: (list: HeldVote[]) => HeldVote[]) =>
      withStoreLock(() => {
        // a send that finishes after a switch to another network or mode writes its own list, and shows nothing here
        const current = scopeRef.current === storageKey(live, network);
        const next = f(current ? read() : loadHeld(store(), live, network));
        saveHeld(store(), live, network, next);
        if (current) {
          done.current = next.filter((v) => v.status === 'sent' || v.status === 'failed');
          setAll(next);
        }
        return next;
      }),
    [read, live, network],
  );

  // on load and on a switch: overdue spread-out votes get new random times (a burst would link them)
  useEffect(() => {
    done.current = [];
    try {
      for (const k of OLD_KEYS) store()?.removeItem(k);
    } catch {
      // nothing to clean
    }
    void apply((l) => respreadOverdue(l, Date.now(), cryptoRand32)).catch(() => setAll(read()));
  }, [apply, read]);

  // another tab added, sent or cancelled votes
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === scopeKey) setAll(read());
    };
    addEventListener('storage', on);
    return () => removeEventListener('storage', on);
  }, [scopeKey, read]);

  const kick = useRef<() => void>(() => {});
  const add = useCallback(
    async (votes: HeldVote[]) => {
      await apply((l) => [...l.filter((x) => !(x.status === 'waiting' && votes.some((v) => v.proTxHash === x.proTxHash && v.label === x.label))), ...votes]);
      setTimeout(() => kick.current(), 0);
    },
    [apply],
  );
  const cancel = useCallback(async (id: string) => void (await apply((l) => l.filter((x) => !(x.id === id && x.status === 'waiting')))), [apply]);
  const sendNow = useCallback(
    async (ids: readonly string[]) => {
      const now = Date.now();
      await apply((l) => l.map((x) => (ids.includes(x.id) && x.status === 'waiting' ? { ...x, releaseAt: now, nextTryAt: undefined } : x)));
      setTimeout(() => kick.current(), 0);
    },
    [apply],
  );

  // the sender: every few seconds, the due votes one after another, in one tab at a time
  const busy = useRef(false);
  useEffect(() => {
    let stopped = false;
    let lastTick = Date.now();
    const set = (id: string, patch: Partial<HeldVote>) => apply((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const finish = (id: string, status: 'sent' | 'failed', note?: string) => set(id, { status, note, sendingSince: undefined });
    const again = (v: HeldVote, note: string) => {
      const tries = v.tries + 1;
      if (v.endsAt === null && tries >= MAX_TRIES_NO_CLOSE) return finish(v.id, 'failed', `Platform could not be reached for this vote (${note}). Vote again.`);
      return set(v.id, { status: 'waiting', sendingSince: undefined, tries, nextTryAt: Date.now() + retryDelayMs(tries), note });
    };
    const sendOne = async (v: HeldVote) => {
      // claim it: only a vote still waiting, and from now on no other tab sends, cancels or replaces it
      const since = Date.now();
      const claimed = (await apply((l) => l.map((x) => (x.id === v.id && x.status === 'waiting' ? { ...x, status: 'sending' as const, sendingSince: since } : x)))).some((x) => x.id === v.id && x.status === 'sending' && x.sendingSince === since);
      if (!claimed) return;
      if (v.endsAt !== null && since > v.endsAt) return finish(v.id, 'failed', 'Voting closed before this vote went out.');
      if (!src.live) return finish(v.id, 'sent', 'Demo data: nothing was sent.');
      try {
        await src.broadcast(base64.decode(v.st));
        src.forget(v.label);
        await finish(v.id, 'sent');
      } catch (e) {
        const o = classifySendError(e);
        if (o.kind === 'same') {
          src.forget(v.label);
          return finish(v.id, 'sent', o.text);
        }
        if (o.kind === 'final') return finish(v.id, 'failed', o.text);
        if (o.kind === 'retry') return again(v, o.text);
        // the nonce was used: by this very vote (its answer lost), or by another vote of this masternode
        src.forget(v.label);
        let counted;
        try {
          counted = (await src.votesOf(v.label, [v.voterId])).get(v.voterId);
        } catch {
          counted = undefined;
        }
        if (counted === undefined) {
          const checks = (v.checks ?? 0) + 1;
          if (checks >= MAX_CHECKS) return finish(v.id, 'failed', 'Could not confirm whether this vote counts. Check the masternode’s current vote on the page.');
          await set(v.id, { checks });
          return again({ ...v, checks }, 'Checking whether this vote counts…');
        }
        if (counted && sameChoice(counted, v.choice)) return finish(v.id, 'sent');
        return finish(v.id, 'failed', `${o.text} Vote again to replace that vote.`);
      }
    };
    const tick = async () => {
      if (busy.current || stopped) return;
      busy.current = true;
      try {
        // a long gap since the last tick (sleep, a frozen tab): what fell due meanwhile is spread out again, not sent as one burst
        const now = Date.now();
        if (now - lastTick > OVERDUE_MS) await apply((l) => respreadOverdue(l, now, cryptoRand32));
        lastTick = now;
        const cutOff = read().some((v) => v.status === 'sending');
        if (!cutOff && !dueVotes(read(), now).length) return;
        await withSendLock(async (exclusive) => {
          // holding the lock no other tab is sending: a vote still "sending" was cut off and is due again
          if (cutOff) await apply((l) => reclaimCutOff(l, Date.now(), exclusive));
          for (const v of dueVotes(read(), Date.now())) {
            if (stopped) break;
            await sendOne(v);
          }
        });
      } catch {
        // storage refused a write: the votes stay as they were and the next tick tries again
      } finally {
        busy.current = false;
      }
    };
    kick.current = () => void tick();
    void tick();
    const t = setInterval(() => void tick(), TICK_MS);
    return () => {
      stopped = true;
      kick.current = () => {};
      clearInterval(t);
    };
  }, [apply, read, src]);

  const held = useMemo(() => all.filter((v) => v.owner === owner), [all, owner]);
  const value = useMemo<Ctx>(() => ({ held, owner, snapshot: read, add, cancel, sendNow }), [held, owner, read, add, cancel, sendNow]);
  return <VotesCtx.Provider value={value}>{children}</VotesCtx.Provider>;
}
