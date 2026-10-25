// Every check of one proposal, run automatically in the verification worker when its page opens, and the one trust signal they add
// up to (verify/aggregate.ts). Order: the collateral first (it anchors the chain), then the chain facts and the vote recount (both
// reuse the anchored chain), then the funding order only when the proposal is active and passing on proven numbers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/context.tsx';
import type { Proposal } from '../../data/types.ts';
import type { Row } from '../../lib/view.ts';
import {
  aggregate, chainComponent, collateralComponent, contentComponent, fundingComponent, needsRanking, provenFunded, provenNetYes, votesComponent, type Aggregate, type ShownTally,
} from '../../verify/aggregate.ts';
import { contentFailure } from '../../verify/checks.ts';
import { runVerification } from '../../verify/client.ts';
import type { RankingDone, VotesDone } from '../../verify/protocol.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET } from '../../verify/verdict.ts';
import type { VoteTarget } from '../../verify/votes.ts';
import { useChainReport, useCollateralCheck, type ChainCheck, type CollateralCheck } from '../hooks.ts';
import { saveTrust, sharedRanking, trustScope } from './store.ts';

export interface Run<T> {
  result: T | null;
  error: string | null;
  progress: string;
  running: boolean;
}
const idle = <T,>(): Run<T> => ({ result: null, error: null, progress: '', running: false });
const started = <T,>(progress: string): Run<T> => ({ result: null, error: null, progress, running: true });
const finished = <T,>(result: T): Run<T> => ({ result, error: null, progress: '', running: false });
const errored = <T,>(error: string): Run<T> => ({ result: null, error, progress: '', running: false });

/**
 * A run's state, tagged with the run (an object identity per set of inputs): a newer run never sees an older run's result, not even in
 * the render before its effect starts it. That keeps a stale recount out of the aggregate (and out of the cards' cache).
 */
function useTaggedRun<T>(run: object): [Run<T>, (f: (r: Run<T>) => Run<T>) => void] {
  const [held, setHeld] = useState<{ run: object; state: Run<T> }>({ run, state: idle<T>() });
  const set = useCallback((f: (r: Run<T>) => Run<T>) => setHeld((h) => ({ run, state: f(h.run === run ? h.state : idle<T>()) })), [run]);
  return [held.run === run ? held.state : idle<T>(), set];
}

export interface ProposalTrust {
  aggregate: Aggregate;
  collateral: CollateralCheck;
  chain: ChainCheck;
  votes: Run<VotesDone>;
  ranking: Run<RankingDone> | null;
  /** In the next budget, on proven data only (null: not proven; the page then shows the source's flag). */
  funded: boolean | null;
  shown: ShownTally | null;
  targets: VoteTarget[];
  /** Runs every check again (the funding order too, not from the shared cache). */
  recheck(): void;
  /** Ranks every active proposal when it did not run on its own (not passing, unproven votes); null when it ran or can't. */
  rankNow: (() => void) | null;
}

export function useProposalTrust(p: Proposal, row: Row, talliesLoading: boolean): ProposalTrust {
  const { source, mode, gov, checks } = useApp();
  const [nonce, setNonce] = useState(0);
  const collateral = useCollateralCheck(p, nonce);
  const chain = useChainReport(p, collateral.verdict, nonce);
  const bridge = source.bridgeDescriptor();

  // This page's full check counts for the lists too (a hidden proposal is still shown here, under a banner).
  useEffect(() => {
    if (collateral.verdict) checks.record(p, collateral.verdict, { full: true });
  }, [checks, p, collateral.verdict]);

  const shown = useMemo<ShownTally | null>(() => (row.tally ? { name: row.tally === row.bridgeTally ? BRIDGE_TARGET : PLATFORM_TARGET, tally: row.tally.value } : null), [row.tally, row.bridgeTally]);
  const targets = useMemo<VoteTarget[]>(
    () => [
      ...(row.platformTally ? [{ name: PLATFORM_TARGET, tally: row.platformTally.value }] : []),
      ...(row.bridgeTally ? [{ name: BRIDGE_TARGET, tally: row.bridgeTally.value }] : []),
    ],
    [row.platformTally, row.bridgeTally],
  );
  const targetsKey = targets.map((t) => `${t.name}@${t.tally.asOfHeight}`).join(',');

  // ---- the vote recount, after the collateral check (so the anchored chain is cached for it)
  const collateralDone = !!collateral.verdict || !!collateral.error;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity per run
  const votesRun = useMemo(() => ({}), [p.govHash, source, mode, collateralDone, talliesLoading, targetsKey, nonce, !!bridge]);
  const [votes, setVotes] = useTaggedRun<VotesDone>(votesRun);
  useEffect(() => {
    if (!bridge || !collateralDone || talliesLoading || targets.length === 0) return;
    let on = true;
    setVotes(() => started('Recounting the signed votes'));
    runVerification(
      { kind: 'votes', govHash: p.govHash, targets, bridge, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now(), crossCheckSml: mode === 'live' },
      (m) => on && setVotes((v) => ({ ...v, progress: m })),
    ).then(
      (result) => on && setVotes(() => finished(result)),
      (e: Error) => on && setVotes(() => errored(e.message)),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- votesRun stands for its inputs
  }, [votesRun]);

  // ---- the funding order, when it decides the funding status
  const netYes = provenNetYes(votes.result, shown);
  const nowS = source.now();
  const active = p.endEpoch > nowS;
  // On its own when it decides the funding status; on request ("Rank every active proposal" in the drawer) otherwise.
  const [rankAsked, setRankAsked] = useState(false);
  const wantRanking = needsRanking({ active, netYes, report: chain.report }) || (rankAsked && active);
  const activeList = useMemo(() => (gov.active.data ?? []).map((x) => x.value).filter((x) => checks.state(x).status !== 'failed'), [gov.active.data, checks]);
  const listKey = activeList.map((x) => x.govHash).join(',');
  const [forceRanking, setForceRanking] = useState(0);
  const forced = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity per run
  const rankingRun = useMemo(() => ({}), [wantRanking, source, listKey, forceRanking, !!bridge]);
  const [ranking, setRanking] = useTaggedRun<RankingDone>(rankingRun);
  useEffect(() => {
    if (!wantRanking || !bridge) return;
    let on = true;
    // only the run right after "Re-check" skips the shared result
    const force = forced.current !== forceRanking;
    forced.current = forceRanking;
    setRanking(() => started('Ranking every active proposal'));
    sharedRanking(source, activeList, { force, onProgress: (m) => on && setRanking((r) => ({ ...r, progress: m })) }).then(
      (result) => on && setRanking(() => finished(result)),
      (e: Error) => on && setRanking(() => errored(e.message)),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankingRun stands for its inputs
  }, [rankingRun]);

  const { agg, funded } = useMemo(() => {
    const content = contentComponent(contentFailure(p));
    const coll = collateralComponent({ verdict: collateral.verdict, error: collateral.error, progress: collateral.progress, publishedHeight: p.collateralHeight });
    // the chain check waits for the collateral (it anchors the chain): when that could not run, neither can this
    const ch =
      collateral.error && !chain.report
        ? ({ status: 'error', reason: "The chain wasn't checked: the collateral check couldn't run" } as const)
        : chainComponent({ report: chain.report, error: chain.error, unavailable: chain.unavailable, progress: chain.progress });
    const vt = votesComponent({
      shown, live: row.bridgeTally?.value ?? null, tip: chain.report?.anchor.tip ?? null, talliesLoading, bridge: !!bridge, result: votes.result, error: votes.error, progress: votes.progress,
    });
    const fund = fundingComponent({
      proposal: p, nowS, chain: ch, votes: vt, report: chain.report, payments: chain.payments, netYes,
      ranking: wantRanking ? (bridge ? { result: ranking.result, error: ranking.error, progress: ranking.progress } : { result: null, error: 'no bridge is configured' }) : null,
    });
    const agg = aggregate(
      [
        { id: 'content', state: content },
        { id: 'collateral', state: coll },
        { id: 'chain', state: ch },
        { id: 'votes', state: vt },
        { id: 'funding', state: fund },
      ],
      { demo: mode === 'fixtures' },
    );
    return { agg, funded: agg.level === 'verified' ? provenFunded({ funding: fund, govHash: p.govHash, netYes, report: chain.report, ranking: ranking.result }) : null };
  }, [p, collateral, chain, shown, row.bridgeTally, talliesLoading, bridge, votes, nowS, netYes, wantRanking, ranking, mode]);

  // the last full result, for the list cards
  useEffect(() => {
    if (agg.level === 'checking' || agg.level === 'demo') return;
    saveTrust(trustScope(source), p, { level: agg.level, reason: agg.reason, tallyHeight: shown?.tally.asOfHeight ?? null, voteSetHash: shown?.tally.voteSetHash ?? null, funded, at: Date.now() });
  }, [agg.level, agg.reason, source, p, shown, funded]);

  const recheck = useCallback(() => {
    setNonce((n) => n + 1);
    setForceRanking((n) => n + 1);
  }, []);
  const rankNow = useCallback(() => setRankAsked(true), []);

  return { aggregate: agg, collateral, chain, votes, ranking: wantRanking ? ranking : null, funded, shown, targets, recheck, rankNow: active && !wantRanking && !!bridge ? rankNow : null };
}

