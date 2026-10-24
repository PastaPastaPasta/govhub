// "Verify votes" (PLAN §2): check every signed vote against the MN voting key, recompute the
// weighted tally and voteSetHash, and compare with the Platform `tally` document.
import { decodeAddress, normalizeMnId, tallyVotes, verifyVoteSignature, EVONODE_WEIGHT, REGULAR_MN_WEIGHT, VOTE_SIGNAL, type Network, type TallyVote } from '@govhub/verify';
import type { BridgeMasternode, BridgeVote } from '../data/bridge.ts';
import type { Tally } from '../data/types.ts';
import { voteSetHash } from './voteset.ts';

/** SML entry as streamed by DAPI subscribeToMasternodeList (only what we cross-check). */
export interface SmlEntry {
  votingAddress: string;
  isValid: boolean;
  /** 0 regular, 1 evonode */
  nType: number;
}

export interface VoteCheckInput {
  govHash: string;
  votes: BridgeVote[];
  masternodes: BridgeMasternode[];
  network: Network;
  /** unix seconds; votes more than 1 h ahead are dropped like Core does */
  now: number;
  /** The Platform tally to compare against, if any. */
  expected?: Tally | null;
  /** proTxHash -> SML entry, when the SML cross-check ran. */
  sml?: ReadonlyMap<string, SmlEntry> | null;
}

export type VoteProblem = 'bad-signature' | 'unknown-masternode' | 'wrong-signal' | 'sml-mismatch';

export interface FieldCompare {
  field: string;
  expected: number | string;
  computed: number | string;
  ok: boolean;
}

export interface VoteCheckResult {
  total: number;
  verified: number;
  problems: Record<VoteProblem, number>;
  /** First few concrete problems, for display. */
  examples: Array<{ outpoint: string; problem: VoteProblem; detail: string }>;
  rejectedTime: number;
  weighted: { yes: number; no: number; abstain: number };
  unweighted: { yes: number; no: number; abstain: number };
  voteSetHash: string;
  smlChecked: number;
  compare: FieldCompare[];
  /** True when there is a tally to compare and every field matches. */
  matches: boolean | null;
}

const weightOf = (t: BridgeMasternode['type']) => (t === 'evo' ? EVONODE_WEIGHT : REGULAR_MN_WEIGHT);

export function verifyVotes(input: VoteCheckInput): VoteCheckResult {
  const byOutpoint = new Map<string, BridgeMasternode & { keyId: Uint8Array | null }>();
  for (const mn of input.masternodes) {
    const dec = decodeAddress(mn.votingAddress, input.network);
    byOutpoint.set(normalizeMnId(`${mn.collateralTxid}-${mn.collateralIndex}`), { ...mn, keyId: dec && dec.type === "p2pkh" ? dec.hash160 : null });
  }

  const problems: Record<VoteProblem, number> = { 'bad-signature': 0, 'unknown-masternode': 0, 'wrong-signal': 0, 'sml-mismatch': 0 };
  const examples: VoteCheckResult['examples'] = [];
  const note = (outpoint: string, problem: VoteProblem, detail: string) => {
    problems[problem]++;
    if (examples.length < 8) examples.push({ outpoint, problem, detail });
  };

  const good: TallyVote[] = [];
  const weights = new Map<string, number>();
  let smlChecked = 0;
  for (const v of input.votes) {
    const outpoint = normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`);
    if (v.signal !== VOTE_SIGNAL.FUNDING) {
      note(outpoint, 'wrong-signal', `signal ${v.signal}`);
      continue;
    }
    const mn = byOutpoint.get(outpoint);
    if (!mn || !mn.keyId) {
      note(outpoint, 'unknown-masternode', mn ? 'voting address is not P2PKH' : 'collateral outpoint not in the MN list');
      continue;
    }
    const fields = { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: input.govHash, signal: v.signal, outcome: v.outcome, time: v.time };
    if (!verifyVoteSignature(v.sig, fields, mn.keyId, input.network)) {
      note(outpoint, 'bad-signature', `does not recover to ${mn.votingAddress}`);
      continue;
    }
    if (input.sml) {
      const e = input.sml.get(mn.proTxHash.toLowerCase());
      smlChecked++;
      if (!e) {
        note(outpoint, 'sml-mismatch', `proTxHash ${mn.proTxHash.slice(0, 12)}… not in the DAPI masternode list`);
        continue;
      }
      if (e.votingAddress !== mn.votingAddress || (e.nType === 1) !== (mn.type === 'evo') || e.isValid !== mn.valid) {
        note(outpoint, 'sml-mismatch', 'voting address, type or validity differs from the DAPI masternode list');
        continue;
      }
    }
    good.push({ mn: outpoint, outcome: v.outcome, time: v.time });
    // Core only counts valid MNs (GetAbsoluteYesCount on the tip list).
    if (mn.valid) weights.set(outpoint, weightOf(mn.type));
  }

  const t = tallyVotes(good, weights, { now: input.now });
  const hash = voteSetHash(t.current, (id) => weights.has(id));
  const exp = input.expected;
  const compare: FieldCompare[] = exp
    ? [
        { field: 'Yes (weighted)', expected: exp.yesWeighted, computed: t.weighted.yes, ok: exp.yesWeighted === t.weighted.yes },
        { field: 'No (weighted)', expected: exp.noWeighted, computed: t.weighted.no, ok: exp.noWeighted === t.weighted.no },
        { field: 'Abstain (weighted)', expected: exp.abstainWeighted, computed: t.weighted.abstain, ok: exp.abstainWeighted === t.weighted.abstain },
        { field: 'Yes (MNs)', expected: exp.yesCount, computed: t.unweighted.yes, ok: exp.yesCount === t.unweighted.yes },
        { field: 'No (MNs)', expected: exp.noCount, computed: t.unweighted.no, ok: exp.noCount === t.unweighted.no },
        { field: 'Abstain (MNs)', expected: exp.abstainCount, computed: t.unweighted.abstain, ok: exp.abstainCount === t.unweighted.abstain },
        { field: 'voteSetHash', expected: exp.voteSetHash, computed: hash, ok: exp.voteSetHash.toLowerCase() === hash },
      ]
    : [];
  return {
    total: input.votes.length,
    verified: good.length,
    problems,
    examples,
    rejectedTime: t.rejected.length,
    weighted: t.weighted,
    unweighted: t.unweighted,
    voteSetHash: hash,
    smlChecked,
    compare,
    matches: exp ? compare.every((c) => c.ok) : null,
  };
}
