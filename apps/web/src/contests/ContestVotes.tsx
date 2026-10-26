// Holds and sends this browser's signed contest votes (contests/held.ts) on every page, so a spread-out vote goes out whichever govhub
// page is open at its time. Storage is the truth for votes still to send (every tab reads and writes it); one tab sends at a time
// (a Web Lock). Sent and failed votes are kept in memory only, for the pages to show what happened.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { base64 } from '@scure/base';
import { useApp } from '../app/context.tsx';
import { cryptoRand32 } from '../voting/plan.ts';
import { dueVotes, loadHeld, respreadOverdue, retryDelayMs, saveHeld, storageKey, type HeldVote, type Network } from './held.ts';
import { useContestSource } from './useContests.ts';
import { classifySendError, sameChoice } from './vote.ts';

interface Ctx {
  /** this network's votes: still to send, and those sent or failed in this tab */
  held: readonly HeldVote[];
  /** Keeps signed votes; a vote still waiting for the same masternode and contest is replaced (it never went out). */
  add(votes: HeldVote[]): void;
  /** Drops a vote that has not gone out yet: it is never sent. */
  cancel(id: string): void;
  /** Sends these waiting votes at the next tick, whatever their time. */
  sendNow(ids: readonly string[]): void;
}

const VotesCtx = createContext<Ctx | null>(null);

export function useContestVotes(): Ctx {
  const c = useContext(VotesCtx);
  if (!c) throw new Error('useContestVotes outside ContestVotesProvider');
  return c;
}

const TICK_MS = 5000;
const LOCK = 'govhub-contest-votes';
const store = (): Storage | undefined => globalThis.localStorage;

/** Runs `fn` while holding the send lock, or not at all when another tab holds it. Without Web Locks it simply runs. */
async function withSendLock(fn: () => Promise<void>): Promise<void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return fn();
  await locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) await fn();
  });
}

export function ContestVotesProvider({ children }: { children: ReactNode }) {
  const { registry } = useApp();
  const src = useContestSource();
  const network = registry.platformNetwork as Network;
  // what this tab saw finish (sent or failed): memory only
  const done = useRef<HeldVote[]>([]);
  const read = useCallback((): HeldVote[] => [...loadHeld(store(), network), ...done.current.filter((v) => v.network === network)], [network]);
  const [held, setHeld] = useState<HeldVote[]>([]);

  /** Applies a change to the stored list (re-read first: another tab may have changed it) and shows the result. */
  const apply = useCallback(
    (f: (list: HeldVote[]) => HeldVote[]) => {
      const next = f(read());
      try {
        saveHeld(store(), network, next);
      } catch {
        // storage full: the change still shows in this tab
      }
      done.current = next.filter((v) => v.status === 'sent' || v.status === 'failed');
      setHeld(next);
    },
    [read, network],
  );

  // on load and on a network switch: overdue spread-out votes get new random times (a burst would link them)
  useEffect(() => {
    done.current = [];
    apply((l) => respreadOverdue(l, Date.now(), cryptoRand32));
  }, [apply]);

  // another tab added, sent or cancelled votes
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === storageKey(network)) setHeld(read());
    };
    addEventListener('storage', on);
    return () => removeEventListener('storage', on);
  }, [network, read]);

  // the sender's tick, so a new "now" vote goes at once instead of at the next tick
  const kick = useRef<() => void>(() => {});
  const add = useCallback(
    (votes: HeldVote[]) => {
      apply((l) => [...l.filter((x) => !(x.status === 'waiting' && votes.some((v) => v.proTxHash === x.proTxHash && v.label === x.label))), ...votes]);
      setTimeout(() => kick.current(), 0);
    },
    [apply],
  );
  const cancel = useCallback((id: string) => apply((l) => l.filter((x) => !(x.id === id && x.status === 'waiting'))), [apply]);
  const sendNow = useCallback(
    (ids: readonly string[]) => {
      const now = Date.now();
      apply((l) => l.map((x) => (ids.includes(x.id) && x.status === 'waiting' ? { ...x, releaseAt: now, nextTryAt: undefined } : x)));
      setTimeout(() => kick.current(), 0);
    },
    [apply],
  );

  // the sender: every few seconds, the due votes one after another, in one tab at a time
  const busy = useRef(false);
  useEffect(() => {
    let stopped = false;
    const set = (id: string, patch: Partial<HeldVote>) => apply((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const sendOne = async (v: HeldVote) => {
      const now = Date.now();
      // still waiting? (another tab may have sent or cancelled it)
      if (!read().some((x) => x.id === v.id && x.status === 'waiting')) return;
      if (v.endsAt !== null && now > v.endsAt) return set(v.id, { status: 'failed', note: 'Voting closed before this vote went out.', doneAt: now });
      set(v.id, { status: 'sending' });
      if (!src.live) return set(v.id, { status: 'sent', note: 'Demo data: nothing was sent.', doneAt: Date.now() });
      try {
        await src.broadcast(base64.decode(v.st));
        src.forget(v.label);
        set(v.id, { status: 'sent', doneAt: Date.now() });
      } catch (e) {
        const o = classifySendError(e);
        if (o.kind === 'same') {
          src.forget(v.label);
          return set(v.id, { status: 'sent', note: o.text, doneAt: Date.now() });
        }
        if (o.kind === 'check') {
          // the nonce was used: by this very vote (a lost answer), or by another vote of this masternode
          src.forget(v.label);
          const counted = await src
            .state(v.label)
            .then((s) => src.votesOf(v.label, s, [v.voterId]))
            .then((m) => m.get(v.voterId))
            .catch(() => undefined);
          if (counted && sameChoice(counted, v.choice)) return set(v.id, { status: 'sent', doneAt: Date.now() });
          return set(v.id, { status: 'failed', note: `${o.text} Vote again to replace that vote.`, doneAt: Date.now() });
        }
        if (o.kind === 'final') return set(v.id, { status: 'failed', note: o.text, doneAt: Date.now() });
        const tries = v.tries + 1;
        set(v.id, { status: 'waiting', tries, nextTryAt: Date.now() + retryDelayMs(tries), note: o.text });
      }
    };
    const tick = async () => {
      if (busy.current || stopped || !dueVotes(read(), Date.now()).length) return;
      busy.current = true;
      try {
        await withSendLock(async () => {
          for (const v of dueVotes(read(), Date.now())) {
            if (stopped) break;
            await sendOne(v);
          }
        });
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

  const value = useMemo<Ctx>(() => ({ held, add, cancel, sendNow }), [held, add, cancel, sendNow]);
  return <VotesCtx.Provider value={value}>{children}</VotesCtx.Provider>;
}
