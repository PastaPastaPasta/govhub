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
import { saveTrust, sharedRanking } from './store.ts';

export interface Run<T> {
  result: T | null;
  error: string | null;
  progress: string;
  running: boolean;
}
const idle = <T,>(): Run<T> => ({ result: null, error: null, progress: '', running: false });

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
  const [votes, setVotes] = useState<Run<VotesDone>>(idle);
  const collateralDone = !!collateral.verdict || !!collateral.error;
  useEffect(() => {
    if (!bridge || !collateralDone || talliesLoading || targets.length === 0) return;
    let on = true;
    setVotes({ result: null, error: null, progress: 'Recounting the signed votes', running: true });
    runVerification(
      { kind: 'votes', govHash: p.govHash, targets, bridge, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now(), crossCheckSml: mode === 'live' },
      (m) => on && setVotes((v) => ({ ...v, progress: m })),
    ).then(
      (result) => on && setVotes({ result, error: null, progress: '', running: false }),
      (e: Error) => on && setVotes({ result: null, error: e.message, progress: '', running: false }),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetsKey stands for targets
  }, [p.govHash, source, mode, collateralDone, talliesLoading, targetsKey, nonce, !!bridge]);

  // ---- the funding order, when it decides the funding status
  const netYes = provenNetYes(votes.result, shown);
  const nowS = source.now();
  const active = p.endEpoch > nowS;
  const wantRanking = needsRanking({ active, netYes, report: chain.report });
  const [ranking, setRanking] = useState<Run<RankingDone>>(idle);
  const activeList = useMemo(() => (gov.active.data ?? []).map((x) => x.value).filter((x) => checks.state(x).status !== 'failed'), [gov.active.data, checks]);
  const [forceRanking, setForceRanking] = useState(0);
  const forced = useRef(0);
  useEffect(() => {
    if (!wantRanking || !bridge) return;
    let on = true;
    // only the run right after "Re-check" skips the shared result
    const force = forced.current !== forceRanking;
    forced.current = forceRanking;
    setRanking({ result: null, error: null, progress: 'Ranking every active proposal', running: true });
    sharedRanking(source, activeList, { force, onProgress: (m) => on && setRanking((r) => ({ ...r, progress: m })) }).then(
      (result) => on && setRanking({ result, error: null, progress: '', running: false }),
      (e: Error) => on && setRanking({ result: null, error: e.message, progress: '', running: false }),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list matters by its members
  }, [wantRanking, source, activeList.map((x) => x.govHash).join(','), forceRanking, !!bridge]);

  const { agg, funded } = useMemo(() => {
    const content = contentComponent(contentFailure(p));
    const coll = collateralComponent({ verdict: collateral.verdict, error: collateral.error, progress: collateral.progress, publishedHeight: p.collateralHeight });
    const ch = chainComponent({ report: chain.report, error: chain.error, unavailable: chain.unavailable, progress: chain.progress });
    const vt = votesComponent({ shown, talliesLoading, bridge: !!bridge, result: votes.result, error: votes.error, progress: votes.progress });
    const fund = fundingComponent({
      proposal: p, nowS, chain: ch, votes: vt, report: chain.report, netYes,
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
  }, [p, collateral, chain, shown, talliesLoading, bridge, votes, nowS, netYes, wantRanking, ranking, mode]);

  // the last full result, for the list cards
  useEffect(() => {
    if (agg.level === 'checking' || agg.level === 'demo') return;
    saveTrust(source.scope, p, { level: agg.level, reason: agg.reason, tallyHeight: shown?.tally.asOfHeight ?? null, funded, at: Date.now() });
  }, [agg.level, agg.reason, source.scope, p, shown, funded]);

  const recheck = useCallback(() => {
    setNonce((n) => n + 1);
    setForceRanking((n) => n + 1);
    setVotes(idle);
    setRanking(idle);
  }, []);

  return { aggregate: agg, collateral, chain, votes, ranking: wantRanking ? ranking : null, funded, shown, targets, recheck };
}

