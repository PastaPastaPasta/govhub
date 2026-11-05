// The superblocks behind the Past ledger, newest first, each read from the verified chain in the worker (pinned blocks below the
// quorum checkpoint cost one block read; newer ones the headers down to them, once). Results arrive one by one; what this browser
// read before comes from its cache.
import { useCallback, useEffect, useRef, useState } from 'react';
import { GOV_CHAIN_PARAMS, isSuperblockHeight } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import type { SuperblockRead } from '../lib/ledger.ts';
import { superblockHeights } from '../lib/ledger.ts';
import { unfinishedReason } from '../lib/netError.ts';
import { runVerification } from '../verify/client.ts';

export type SuperblockSlot = { height: number } & ({ state: 'reading' } | { state: 'read'; read: SuperblockRead } | { state: 'error'; error: string });

/** Superblocks shown at first and per "earlier" step: a year on Mainnet (monthly), a day on Testnet (hourly). */
export const LEDGER_STEP = { mainnet: 12, testnet: 24 } as const;
/** How far back: two years on Mainnet, which the build's pinned superblocks cover (packages/dapi quorumpins.ts); two days on Testnet. */
export const LEDGER_MAX = { mainnet: 24, testnet: 48 } as const;
const PARALLEL = 3;

export interface Ledger {
  /** Null until the last superblock's height is known (from the budget cycle), and in demo mode. */
  slots: SuperblockSlot[] | null;
  unavailable: string | null;
  canLoadMore: boolean;
  loadMore(): void;
  retry(): void;
}

export function useLedger(): Ledger {
  const { gov, source, mode } = useApp();
  const network = source.coreNetwork;
  // the next superblock as the budget cycle reports it, checked against consensus: only a real superblock height is read as one
  const cycle = GOV_CHAIN_PARAMS[network].superblockCycle;
  const next = gov.cycle.data?.value.superblockHeight ?? null;
  const last = next !== null && isSuperblockHeight(next, network) ? next - cycle : null;
  const [count, setCount] = useState<number>(LEDGER_STEP[network]);
  const [slots, setSlots] = useState<Map<number, SuperblockSlot>>(new Map());
  const [nonce, setNonce] = useState(0);
  const started = useRef(new Set<number>());
  const live = mode === 'live';

  useEffect(() => {
    started.current = new Set();
    setSlots(new Map());
    setCount(LEDGER_STEP[network]);
  }, [source, network]);

  const heights = last !== null && live ? superblockHeights(last, cycle, count) : [];
  const key = heights.join(',');
  useEffect(() => {
    if (!heights.length) return;
    let on = true;
    const todo = heights.filter((h) => !started.current.has(h));
    for (const h of todo) started.current.add(h);
    const done = new Set<number>();
    const put = (s: SuperblockSlot) => on && setSlots((prev) => new Map(prev).set(s.height, s));
    for (const h of todo) put({ height: h, state: 'reading' });
    let i = 0;
    const work = async () => {
      while (on && i < todo.length) {
        const height = todo[i++]!;
        try {
          const r = await runVerification({ kind: 'superblock', height, dapi: source.dapiDescriptor(), network });
          if (on) done.add(height);
          put({ height, state: 'read', read: r.read });
        } catch (e) {
          if (!on) continue; // cleaned up: the next run owns `started`
          started.current.delete(height);
          put({ height, state: 'error', error: unfinishedReason(e) });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, work));
    return () => {
      on = false;
      // what this run did not finish is read again by the next one
      for (const h of todo) if (!done.has(h)) started.current.delete(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for the heights
  }, [key, source, nonce]);

  const loadMore = useCallback(() => setCount((c) => Math.min(LEDGER_MAX[network], c + LEDGER_STEP[network])), [network]);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return {
    slots: heights.length ? heights.map((h) => slots.get(h) ?? { height: h, state: 'reading' }) : null,
    unavailable: !live
      ? 'The demo snapshot has no chain to read superblocks from; switch to live data to see what the treasury paid.'
      : next !== null && last === null
        ? `The budget cycle names block ${next.toLocaleString('en-US')} as the next superblock, which isn't a superblock height, so no superblock is read.`
        : null,
    canLoadMore: count < LEDGER_MAX[network],
    loadMore,
    retry,
  };
}
