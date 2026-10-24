// "Verify votes" (PLAN §2): check every signed vote against the MN voting key, recompute the
// weighted tally and voteSetHash, and compare with each published tally (Platform doc, bridge).
//
// Trust: signatures prove "the holder of voting key K signed this". Which key belongs to which
// collateral outpoint comes from the bridge's MN list. The DAPI SML cross-check confirms key, type
// and validity per proTxHash, but the SML has no collateral outpoint, so the outpoint -> proTxHash
// mapping stays bridge-reported unless the collateral is inside the ProRegTx itself
// (collateralTxid == proTxHash). `keysFrom` tells the UI how far the result can be trusted.
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

export interface VoteTarget {
  /** "Platform tally" / "Bridge live tally" */
  name: string;
  tally: Tally;
}

export interface VoteCheckInput {
  govHash: string;
  votes: BridgeVote[];
  masternodes: BridgeMasternode[];
  network: Network;
  /** unix seconds; votes more than 1 h ahead are dropped like Core does */
  now: number;
  /** Published tallies to compare the recount with. */
  targets: VoteTarget[];
  /** proTxHash -> SML entry, when the SML cross-check ran. */
  sml?: ReadonlyMap<string, SmlEntry> | null;
}

export type VoteProblem = 'bad-signature' | 'unknown-masternode' | 'duplicate-masternode' | 'sml-mismatch';

export interface FieldCompare {
  field: string;
  expected: number | string;
  computed: number | string;
  ok: boolean;
}

export interface TargetResult {
  name: string;
  asOfHeight: number;
  compare: FieldCompare[];
  matches: boolean;
}

export interface VoteCheckResult {
  total: number;
  verified: number;
  /** Votes on other signals (valid/delete/endorsed): not part of the funding tally, skipped. */
  otherSignal: number;
  problems: Record<VoteProblem, number>;
  /** First few concrete problems, for display. */
  examples: Array<{ outpoint: string; problem: VoteProblem; detail: string }>;
  rejectedTime: number;
  weighted: { yes: number; no: number; abstain: number };
  unweighted: { yes: number; no: number; abstain: number };
  voteSetHash: string;
  /** Where the voting keys were confirmed: only the bridge, or also the DAPI masternode list. */
  keysFrom: 'bridge' | 'sml';
  smlChecked: number;
  /** Counted MNs whose outpoint -> proTxHash binding is checkable without a ProRegTx fetch. */
  internalCollateral: number;
  targets: TargetResult[];
}

const weightOf = (t: BridgeMasternode['type']) => (t === 'evo' ? EVONODE_WEIGHT : REGULAR_MN_WEIGHT);

function compareWith(t: Tally, w: VoteCheckResult['weighted'], u: VoteCheckResult['unweighted'], hash: string): FieldCompare[] {
  const row = (field: string, expected: number | string, computed: number | string): FieldCompare => ({
    field,
    expected,
    computed,
    ok: typeof expected === 'string' ? expected.toLowerCase() === computed : expected === computed,
  });
  return [
    row('Yes (weighted)', t.yesWeighted, w.yes),
    row('No (weighted)', t.noWeighted, w.no),
    row('Abstain (weighted)', t.abstainWeighted, w.abstain),
    row('Yes (MNs)', t.yesCount, u.yes),
    row('No (MNs)', t.noCount, u.no),
    row('Abstain (MNs)', t.abstainCount, u.abstain),
    row('voteSetHash', t.voteSetHash, hash),
  ];
}

export function verifyVotes(input: VoteCheckInput): VoteCheckResult {
  const problems: Record<VoteProblem, number> = { 'bad-signature': 0, 'unknown-masternode': 0, 'duplicate-masternode': 0, 'sml-mismatch': 0 };
  const examples: VoteCheckResult['examples'] = [];
  const note = (outpoint: string, problem: VoteProblem, detail: string) => {
    problems[problem]++;
    if (examples.length < 8) examples.push({ outpoint, problem, detail });
  };

  // A bridge could list one real proTxHash (or one outpoint) several times to multiply a key's
  // weight; entries that are not unique on both are refused outright.
  const outpointCount = new Map<string, number>();
  const proTxCount = new Map<string, number>();
  for (const mn of input.masternodes) {
    const op = normalizeMnId(`${mn.collateralTxid}-${mn.collateralIndex}`);
    outpointCount.set(op, (outpointCount.get(op) ?? 0) + 1);
    proTxCount.set(mn.proTxHash.toLowerCase(), (proTxCount.get(mn.proTxHash.toLowerCase()) ?? 0) + 1);
  }
  const byOutpoint = new Map<string, BridgeMasternode & { keyId: Uint8Array | null; duplicate: boolean }>();
  for (const mn of input.masternodes) {
    const op = normalizeMnId(`${mn.collateralTxid}-${mn.collateralIndex}`);
    const dec = decodeAddress(mn.votingAddress, input.network);
    const duplicate = outpointCount.get(op)! > 1 || proTxCount.get(mn.proTxHash.toLowerCase())! > 1;
    byOutpoint.set(op, { ...mn, keyId: dec && dec.type === 'p2pkh' ? dec.hash160 : null, duplicate });
  }

  const good: TallyVote[] = [];
  const weights = new Map<string, number>();
  let smlChecked = 0;
  let otherSignal = 0;
  let internalCollateral = 0;
  for (const v of input.votes) {
    const outpoint = normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`);
    if (v.signal !== VOTE_SIGNAL.FUNDING) {
      otherSignal++;
      continue;
    }
    const mn = byOutpoint.get(outpoint);
    if (!mn || !mn.keyId) {
      note(outpoint, 'unknown-masternode', mn ? 'voting address is not P2PKH' : 'collateral outpoint not in the MN list');
      continue;
    }
    if (mn.duplicate) {
      note(outpoint, 'duplicate-masternode', 'the MN list has this outpoint or proTxHash more than once');
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
      if (e.votingAddress !== mn.votingAddress || (e.nType === 1) !== (mn.type === 'evo')) {
        note(outpoint, 'sml-mismatch', 'voting address or type differs from the DAPI masternode list');
        continue;
      }
    }
    good.push({ mn: outpoint, outcome: v.outcome, time: v.time });
    // Core counts every MN in the tip list, PoSe-banned ones included: CountMatchingVotes and
    // CGovernanceVote::IsValid use GetMNByCollateral, not GetValidMNByCollateral (object.cpp:888, vote.cpp:231).
    weights.set(outpoint, weightOf(mn.type));
    if (mn.collateralTxid.toLowerCase() === mn.proTxHash.toLowerCase()) internalCollateral++;
  }

  const t = tallyVotes(good, weights, { now: input.now });
  const hash = voteSetHash(t.current, (id) => weights.has(id));
  return {
    total: input.votes.length,
    verified: good.length,
    otherSignal,
    problems,
    examples,
    rejectedTime: t.rejected.length,
    weighted: t.weighted,
    unweighted: t.unweighted,
    voteSetHash: hash,
    keysFrom: input.sml ? 'sml' : 'bridge',
    smlChecked,
    internalCollateral,
    targets: input.targets.map((target) => {
      const compare = compareWith(target.tally, t.weighted, t.unweighted, hash);
      return { name: target.name, asOfHeight: target.tally.asOfHeight, compare, matches: compare.every((c) => c.ok) };
    }),
  };
}
