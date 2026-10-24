// Funding-vote tally. Mirrors the per-masternode "current vote" rules of CGovernanceObject::ProcessVote
// (src/governance/object.cpp:421-440) and CountMatchingVotes (object.cpp:880-893; weight = GetMnType(type).voting_weight, evo/dmn_types.h:26-44).
import { VOTE_OUTCOME, VOTE_OUTCOME_NAMES } from './vote.ts';

export const REGULAR_MN_WEIGHT = 1;
export const EVONODE_WEIGHT = 4;

export type OutcomeInput = number | 'yes' | 'no' | 'abstain' | 'none';

export interface TallyVote {
  /**
   * ONE canonical masternode identifier per masternode, used consistently for votes AND the weight map. Prefer the collateral
   * outpoint "txid-index" (what Core keys `mapCurrentMNVotes` by and what the vote signs) or the proTxHash; never mix the two
   * forms, or the same masternode would be counted twice. Compared case-insensitively; outpoint indexes are normalised.
   */
  mn: string;
  outcome: OutcomeInput;
  /** unix seconds as signed in the vote. */
  time: number | bigint;
}

export interface OutcomeCounts {
  yes: number;
  no: number;
  abstain: number;
}

export interface TallyResult {
  /** Sum of masternode weights (regular 1, evonode 4) per current outcome. */
  weighted: OutcomeCounts;
  /** Number of masternodes per current outcome. */
  unweighted: OutcomeCounts;
  /** weighted.yes - weighted.no: Core's "AbsoluteYesCount" that is compared with the funding threshold. */
  absoluteYes: number;
  /** The vote that counts for each masternode. */
  current: Map<string, { outcome: number; time: bigint }>;
  /** Masternodes that voted but have no entry in the weight map (not counted at all). */
  unknownMasternodes: string[];
  /** Votes dropped before tallying because Core would never have accepted them (see `TallyOptions.now`). */
  rejected: Array<{ mn: string; time: bigint; reason: 'negative-time' | 'future-time' }>;
}

export interface TallyOptions {
  /**
   * Current unix time. When given, votes with `time > now + 3600` are dropped (CGovernanceVote::IsValid, vote.cpp:213), so a
   * far-future vote signed once with a voting key cannot pin that masternode's vote forever. Always dropped regardless: time < 0
   * (Core's initial per-MN state has nCreationTime = 0, object.cpp:421).
   */
  now?: number;
}

/** Valid weights: GetMnType(...).voting_weight is 1 (regular), 4 (evonode), or 0 (invalid type). */
const VALID_WEIGHTS = new Set([0, REGULAR_MN_WEIGHT, EVONODE_WEIGHT]);

/** Lowercases, and for "txid-index" outpoints strips leading zeros of the index so "x-01" and "x-1" are one id. */
export function normalizeMnId(id: string): string {
  const m = /^([0-9a-fA-F]{64})-(\d+)$/.exec(id);
  return m ? `${m[1]!.toLowerCase()}-${BigInt(m[2]!).toString()}` : id.toLowerCase();
}

function outcomeNumber(o: OutcomeInput): number {
  if (typeof o === 'number') {
    if (!Number.isInteger(o) || o < VOTE_OUTCOME.NONE || o > VOTE_OUTCOME.ABSTAIN) throw new Error(`invalid outcome ${o}`);
    return o;
  }
  switch (o) {
    case 'none': return VOTE_OUTCOME.NONE;
    case 'yes': return VOTE_OUTCOME.YES;
    case 'no': return VOTE_OUTCOME.NO;
    case 'abstain': return VOTE_OUTCOME.ABSTAIN;
    default: throw new Error(`invalid outcome ${String(o)}`);
  }
}

/**
 * Per masternode the latest vote wins: a strictly newer `time` replaces; at EQUAL time Core keeps the vote with the
 * HIGHER outcome value (yes=1 < no=2 < abstain=3; "vote.GetOutcome() < currentInstance.eOutcome => rejected"), which makes
 * the result independent of arrival order. Input order does not matter.
 *
 * Only pass FUNDING-signal votes on the proposal being tallied (there is no signal field here), already signature-verified
 * against the voting key (verifyVoteSignature). `weights` maps the same identifiers as `TallyVote.mn` to 1 (regular) or 4 (evonode) as of the tally height. Masternodes
 * absent from the map are reported in `unknownMasternodes` and not counted (a vote from a non-registered / PoSe-banned MN
 * has no weight in Core either).
 */
export function tallyVotes(votes: Iterable<TallyVote>, weights: ReadonlyMap<string, number> | Readonly<Record<string, number>>, opts: TallyOptions = {}): TallyResult {
  const w = new Map<string, number>();
  const entries: Array<[string, number]> = weights instanceof Map ? [...weights] : Object.entries(weights);
  for (const [k, v] of entries) {
    if (!VALID_WEIGHTS.has(v)) throw new Error(`invalid masternode weight ${v} for ${k} (expected 1, 4 or 0)`);
    const id = normalizeMnId(k);
    if (w.has(id) && w.get(id) !== v) throw new Error(`conflicting weights for ${id}`);
    w.set(id, v);
  }

  const current = new Map<string, { outcome: number; time: bigint }>();
  const rejected: TallyResult['rejected'] = [];
  for (const v of votes) {
    const id = normalizeMnId(v.mn);
    const outcome = outcomeNumber(v.outcome);
    const time = BigInt(v.time);
    if (time < 0n) {
      rejected.push({ mn: id, time, reason: 'negative-time' });
      continue;
    }
    if (opts.now !== undefined && time > BigInt(Math.floor(opts.now)) + 3600n) {
      rejected.push({ mn: id, time, reason: 'future-time' });
      continue;
    }
    const cur = current.get(id);
    if (!cur || time > cur.time || (time === cur.time && outcome >= cur.outcome)) current.set(id, { outcome, time });
  }

  const weighted: OutcomeCounts = { yes: 0, no: 0, abstain: 0 };
  const unweighted: OutcomeCounts = { yes: 0, no: 0, abstain: 0 };
  const unknownMasternodes: string[] = [];
  for (const [id, { outcome }] of current) {
    const weight = w.get(id);
    if (weight === undefined) {
      unknownMasternodes.push(id);
      continue;
    }
    const key = VOTE_OUTCOME_NAMES[outcome];
    if (key === undefined || key === 'none') continue;
    weighted[key] += weight;
    unweighted[key] += 1;
  }
  unknownMasternodes.sort();
  return { weighted, unweighted, absoluteYes: weighted.yes - weighted.no, current, unknownMasternodes, rejected };
}
