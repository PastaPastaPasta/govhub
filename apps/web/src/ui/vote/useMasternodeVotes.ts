// One masternode's funding votes on the active proposals, as the governance bridge reports them: the masternode from the bridge's
// list, then each proposal's vote set, read a few at a time so every row fills in as its answer arrives. Untrusted (shown as "as the
// bridge reports"); the proposal pages recount the same votes against the proven masternode list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/context.tsx';
import { BridgeError, type BridgeMasternode, type BridgeVote } from '../../data/bridge.ts';
import { makeBridge } from '../../data/bridgeFactory.ts';
import type { Proposal } from '../../data/types.ts';
import { unfinishedReason } from '../../lib/netError.ts';

export type VoteCell =
  | { kind: 'waiting' }
  | { kind: 'none' }
  | { kind: 'voted'; outcome: 1 | 2 | 3; time: number }
  | { kind: 'unread'; error: string };

export type MnLookup =
  | { kind: 'loading' }
  | { kind: 'no-bridge' }
  | { kind: 'absent'; height: number }
  | { kind: 'error'; message: string }
  | { kind: 'found'; mn: BridgeMasternode; height: number };

/** Vote sets read at once: enough to fill 25 rows in a few round trips, few enough not to be throttled. */
const PARALLEL = 6;
/** One quiet retry for a vote set that failed with anything but "none published" (a 502 under load clears on a second ask). */
const RETRY_MS = 1500;

/** This masternode's newest funding vote in a vote set: 1 yes, 2 no, 3 abstain; null when it has none (or only an unknown outcome). */
export function latestFundingVote(votes: readonly BridgeVote[], mn: Pick<BridgeMasternode, 'collateralTxid' | 'collateralIndex'>): { outcome: 1 | 2 | 3; time: number } | null {
  const txid = mn.collateralTxid.toLowerCase();
  let best: BridgeVote | null = null;
  for (const v of votes) {
    if (v.signal !== 1 || v.collateralIndex !== mn.collateralIndex || v.collateralTxid.toLowerCase() !== txid) continue;
    if (!best || v.time > best.time) best = v;
  }
  return best && (best.outcome === 1 || best.outcome === 2 || best.outcome === 3) ? { outcome: best.outcome, time: best.time } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MasternodeVotes {
  lookup: MnLookup;
  cells: ReadonlyMap<string, VoteCell>;
  /** Vote sets still being read (for "18 of 25 read"). */
  pending: number;
  retryLookup(): void;
  /** Reads the rows that could not be read again. */
  retryUnread(): void;
}

export function useMasternodeVotes(proTx: string, proposals: readonly Proposal[]): MasternodeVotes {
  const { source } = useApp();
  const descriptor = source.bridgeDescriptor();
  const descKey = descriptor ? JSON.stringify(descriptor) : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one bridge per descriptor
  const bridge = useMemo(() => (descriptor ? makeBridge(descriptor) : null), [descKey]);
  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState<MnLookup>({ kind: 'loading' });
  const [cells, setCells] = useState<ReadonlyMap<string, VoteCell>>(new Map());
  // the vote sets asked for (by govHash) for the masternode found in this lookup
  const asked = useRef(new Set<string>());
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    asked.current = new Set();
    setCells(new Map());
    if (!bridge) return setLookup({ kind: 'no-bridge' });
    let live = true;
    setLookup({ kind: 'loading' });
    (async () => {
      for (let i = 0; ; i++) {
        try {
          const list = await bridge.mnlist();
          const mn = list.masternodes.find((m) => m.proTxHash.toLowerCase() === proTx);
          if (live) setLookup(mn ? { kind: 'found', mn, height: list.height } : { kind: 'absent', height: list.height });
          return;
        } catch (e) {
          if (i === 0 && !(e instanceof BridgeError && e.status === 404)) {
            await sleep(RETRY_MS);
            if (live) continue;
          }
          if (live) setLookup({ kind: 'error', message: unfinishedReason(e) });
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [bridge, proTx, attempt]);

  const mn = lookup.kind === 'found' ? lookup.mn : null;
  const proposalKey = proposals.map((p) => p.govHash).join(',');
  useEffect(() => {
    if (!bridge || !mn) return;
    let live = true;
    const todo = proposals.filter((p) => !asked.current.has(p.govHash));
    if (!todo.length) return;
    for (const p of todo) asked.current.add(p.govHash);
    const done = new Set<string>();
    const set = (govHash: string, cell: VoteCell) => {
      if (!live) return;
      done.add(govHash);
      setCells((prev) => new Map(prev).set(govHash, cell));
    };
    setCells((prev) => {
      const next = new Map(prev);
      for (const p of todo) next.set(p.govHash, { kind: 'waiting' });
      return next;
    });
    const read = async (p: Proposal) => {
      for (let i = 0; ; i++) {
        try {
          const vote = latestFundingVote((await bridge.votes(p.govHash)).votes, mn);
          return set(p.govHash, vote ? { kind: 'voted', ...vote } : { kind: 'none' });
        } catch (e) {
          // no published vote set yet (a new proposal): nobody has voted on it
          if (e instanceof BridgeError && e.status === 404) return set(p.govHash, { kind: 'none' });
          if (i === 0) {
            await sleep(RETRY_MS);
            if (live) continue;
            return;
          }
          // a row the user can retry; a later effect run (retryUnread) asks again
          asked.current.delete(p.govHash);
          return set(p.govHash, { kind: 'unread', error: unfinishedReason(e) });
        }
      }
    };
    let next = 0;
    const work = async () => {
      while (live && next < todo.length) await read(todo[next++]!);
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, work));
    return () => {
      live = false;
      // the run was cut short: what it did not finish is asked again by the next run
      for (const p of todo) if (!done.has(p.govHash)) asked.current.delete(p.govHash);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- proposalKey stands for the proposals
  }, [bridge, mn, proposalKey, retryNonce]);

  const pending = useMemo(() => proposals.filter((p) => (cells.get(p.govHash)?.kind ?? 'waiting') === 'waiting').length, [proposals, cells]);
  const retryLookup = useCallback(() => setAttempt((n) => n + 1), []);
  const retryUnread = useCallback(() => setRetryNonce((n) => n + 1), []);
  return { lookup, cells, pending, retryLookup, retryUnread };
}
