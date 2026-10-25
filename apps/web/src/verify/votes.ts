// "Verify votes" (PLAN §2): check every signed vote against the MN voting key, recompute the
// weighted tally and voteSetHash, and compare with each published tally (Platform doc, bridge).
//
// Trust: signatures prove "the holder of voting key K signed this". With a proven masternode list (SML anchored to the verified
// chain) a vote is counted only when its masternode is in that list, the masternode's ProRegTx (hash-checked) proves the vote's
// collateral outpoint and the type (weight), and the signature recovers to the voting key the proven list assigns. Everything else is
// excluded and counted by reason. Without a proven list (demo data) the bridge's list stands in, and `keysFrom` says so.
import { countVotes, decodeAddress, normalizeMnId, verifyVoteSignature, EVONODE_WEIGHT, REGULAR_MN_WEIGHT, VOTE_SIGNAL, type Network, type TallyVote } from '@govhub/verify';
import type { BridgeMasternode, BridgeVote } from '../data/bridge.ts';
import type { Tally } from '../data/types.ts';

/** A masternode as the DAPI-agreed SML lists it (@govhub/dapi `SmlMasternode`; only what we cross-check). */
export interface SmlEntry {
  votingAddress: string;
  isValid: boolean;
  /** 0 regular, 1 evonode */
  nType: number;
  /** The list's merkle root covers nType (entry version >= 2). */
  typeProven: boolean;
}

/** A masternode's registration as its ProRegTx proves it (@govhub/dapi ProRegInfo). */
export interface ProReg {
  type: number;
  collateral: { txid: string; index: number };
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
  /** proTxHash -> ProRegTx facts: proves the outpoint -> proTxHash mapping and the type. */
  proReg?: ReadonlyMap<string, ProReg> | null;
}

/**
 * Why a vote was left out of the count. Without a proven masternode list only the first three apply; with one, a vote counts only
 * when its masternode is in that list, its outpoint and type are proven by its ProRegTx, and its signature recovers to the voting key
 * the proven list assigns (never the bridge's key).
 */
export type VoteProblem = 'bad-signature' | 'unknown-masternode' | 'duplicate-masternode' | 'not-in-proven-list' | 'unproven-key' | 'unproven-registration';

/** What each exclusion means, for the UI (a count follows or precedes it). */
export const PROBLEM_TEXT: Record<VoteProblem, string> = {
  'bad-signature': "signature doesn't check out",
  'unknown-masternode': "outpoint isn't a masternode in the bridge's list",
  'duplicate-masternode': "the bridge's list has its masternode twice",
  'not-in-proven-list': 'masternode not in the proven masternode list',
  'unproven-key': "not signed by the voting key the proven list gives its masternode",
  'unproven-registration': "collateral or type not proven by the masternode's registration (ProRegTx)",
};

/** "3 votes excluded (2 masternode not in the proven masternode list; 1 ...)", or null when nothing was excluded. */
export function excludedText(r: Pick<VoteCheckResult, 'excluded' | 'problems'>): string | null {
  if (r.excluded === 0) return null;
  const parts = (Object.entries(r.problems) as Array<[VoteProblem, number]>).filter(([, n]) => n > 0).map(([k, n]) => `${n.toLocaleString('en-US')}: ${PROBLEM_TEXT[k]}`);
  return `${r.excluded.toLocaleString('en-US')} vote${r.excluded === 1 ? '' : 's'} excluded (${parts.join('; ')})`;
}

export interface FieldCompare {
  field: string;
  expected: number | string;
  computed: number | string;
  ok: boolean;
}

export interface TargetResult {
  name: string;
  asOfHeight: number;
  /** The tally against the count made here (proven votes only, when a proven list was given). */
  compare: FieldCompare[];
  matches: boolean;
  /**
   * `matches`, or the tally equals the count made here plus the excluded votes whose signature recovers to the key the bridge lists
   * (at the bridge's weight), there is at least one such vote, and the bridge's list agrees with the proven key and type of every
   * counted voter. Then the difference is exactly those excluded votes: the tally counts votes this browser couldn't prove. When
   * this is false too, the tally and the votes contradict each other.
   */
  servedMatches: boolean;
}

export interface VoteCheckResult {
  total: number;
  /** Votes counted here (proven ones only, when a proven list was given). */
  verified: number;
  /** Votes on other signals (valid/delete/endorsed): not part of the funding tally, skipped. */
  otherSignal: number;
  /** Funding votes left out of the count, by reason. */
  problems: Record<VoteProblem, number>;
  /** Sum of `problems`. */
  excluded: number;
  /** First few concrete problems, for display. */
  examples: Array<{ outpoint: string; problem: VoteProblem; detail: string }>;
  rejectedTime: number;
  /** The count made here, of the counted votes only. */
  weighted: { yes: number; no: number; abstain: number };
  unweighted: { yes: number; no: number; abstain: number };
  voteSetHash: string;
  /** Where the voting keys were confirmed: only the bridge, or every counted vote's by the proven list (and nothing excluded). */
  keysFrom: 'bridge' | 'sml';
  /**
   * Counted votes whose masternode the bridge lists with another voting key or type than the proven list and ProRegTx: counted with
   * the proven ones, but the bridge misstated its list, so the result can't be "verified".
   */
  listDiffers: number;
  smlChecked: number;
  /** Counted votes whose outpoint -> proTxHash binding (and type) the masternode's ProRegTx proved. */
  collateralProven: number;
  targets: TargetResult[];
}

/** One recount: a vote set (at one height) checked and counted, with what it concluded about the tallies published for that height. */
export interface VoteRun {
  result: VoteCheckResult;
  /** Height of the bridge's tally record whose vote set was served: at or below the requested `?height=` (the tally in force there). */
  votesAsOf: number;
  /**
   * The `?height=` the set was asked for, when the bridge served the set in force at that height (null: its live set, including the
   * fallback when it no longer held that height's set). A tally at that height is then about exactly this set.
   */
  asked?: number | null;
  /** Height of the masternode-list snapshot the weights and keys came from. */
  mnlistHeight: number;
  /** The snapshot is the list the bridge says it built the tally from (null: not stated). A difference explains a mismatch. */
  listMatches: boolean | null;
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
  const problems: Record<VoteProblem, number> = { 'bad-signature': 0, 'unknown-masternode': 0, 'duplicate-masternode': 0, 'not-in-proven-list': 0, 'unproven-key': 0, 'unproven-registration': 0 };
  const examples: VoteCheckResult['examples'] = [];
  const exclude = (outpoint: string, problem: VoteProblem, detail: string) => {
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

  // Weights cover the whole MN list, PoSe-banned masternodes included (Core's CountMatchingVotes uses GetMNByCollateral, not
  // GetValidMNByCollateral: object.cpp:888, vote.cpp:231). Ambiguous entries get no weight, so their votes are never counted.
  // `counted` at the proven weights is the count made here. `explained` adds the excluded votes that verify under the bridge's key,
  // at the bridge's weight: a tally equal to that counts exactly the votes this browser couldn't prove, and is not a contradiction.
  const counted: TallyVote[] = [];
  const countedWeights = new Map<string, number>();
  const explained: TallyVote[] = [];
  const explainedWeights = new Map<string, number>();
  let smlChecked = 0;
  let otherSignal = 0;
  let collateralProven = 0;
  const listDiffers = new Set<string>();
  let explainedServed = 0;
  for (const v of input.votes) {
    const outpoint = normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`);
    if (v.signal !== VOTE_SIGNAL.FUNDING) {
      otherSignal++;
      continue;
    }
    const mn = byOutpoint.get(outpoint);
    if (!mn || !mn.keyId) {
      exclude(outpoint, 'unknown-masternode', mn ? 'voting address is not P2PKH' : 'collateral outpoint not in the MN list');
      continue;
    }
    if (mn.duplicate) {
      exclude(outpoint, 'duplicate-masternode', 'the MN list has this outpoint or proTxHash more than once');
      continue;
    }
    const fields = { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: input.govHash, signal: v.signal, outcome: v.outcome, time: v.time };
    const tv: TallyVote = { mn: outpoint, outcome: v.outcome, time: v.time };
    const servedOk = verifyVoteSignature(v.sig, fields, mn.keyId, input.network);
    const count = (weight: number) => {
      counted.push(tv);
      countedWeights.set(outpoint, weight);
      explained.push(tv);
      explainedWeights.set(outpoint, weight);
    };
    const excludeProven = (problem: VoteProblem, detail: string) => {
      exclude(outpoint, problem, detail);
      if (!servedOk) return;
      explainedServed++;
      explained.push(tv);
      explainedWeights.set(outpoint, weightOf(mn.type));
    };
    if (!input.sml) {
      // No proven list: the count is the bridge's list, labelled so (keysFrom 'bridge').
      if (servedOk) count(weightOf(mn.type));
      else exclude(outpoint, 'bad-signature', `does not recover to ${mn.votingAddress}`);
      continue;
    }
    // With a proven list, only proven facts count. The list is the CURRENT one (DAPI serves no other), the tally is as of an older
    // height: a masternode that left or changed its voting key since is excluded like one the bridge made up (Core drops the votes
    // of such masternodes too, once its list changes). The exclusion is shown with its reason, and the result can't be "verified".
    smlChecked++;
    const proTx = mn.proTxHash.toLowerCase();
    const e = input.sml.get(proTx);
    if (!e) {
      excludeProven('not-in-proven-list', `proTxHash ${proTx.slice(0, 12)}… is not in the proven masternode list (left since, or made up)`);
      continue;
    }
    const reg = input.proReg?.get(proTx);
    if (!reg || normalizeMnId(`${reg.collateral.txid}-${reg.collateral.index}`) !== outpoint) {
      excludeProven('unproven-registration', reg ? "the outpoint is not this masternode's collateral in its ProRegTx" : 'its registration (ProRegTx) could not be checked');
      continue;
    }
    // A version-1 entry's type is not covered by the list's hash; the ProRegTx's always is. Both, where both speak, must agree.
    if (e.typeProven && e.nType !== reg.type) {
      excludeProven('unproven-registration', "the proven list and the ProRegTx disagree on the masternode's type");
      continue;
    }
    const provenKey = decodeAddress(e.votingAddress, input.network);
    if (!provenKey || provenKey.type !== 'p2pkh' || !verifyVoteSignature(v.sig, fields, provenKey.hash160, input.network)) {
      excludeProven(servedOk ? 'unproven-key' : 'bad-signature', servedOk ? `signed by ${mn.votingAddress}, but the proven list gives this masternode ${e.votingAddress}` : `does not recover to ${e.votingAddress}`);
      continue;
    }
    collateralProven++;
    if (mn.votingAddress !== e.votingAddress || (mn.type === 'evo') !== (reg.type === 1)) listDiffers.add(outpoint);
    count(reg.type === 1 ? EVONODE_WEIGHT : REGULAR_MN_WEIGHT);
  }

  // The same counting function the bridge publishes its tally with (@govhub/verify countVotes).
  const t = countVotes(counted, countedWeights, { now: input.now });
  const all = explainedServed > 0 && listDiffers.size === 0 ? countVotes(explained, explainedWeights, { now: input.now }) : null;
  const excluded = Object.values(problems).reduce((a, b) => a + b, 0);
  return {
    total: input.votes.length,
    verified: counted.length,
    otherSignal,
    problems,
    excluded,
    examples,
    rejectedTime: t.rejected.length,
    weighted: t.weighted,
    unweighted: t.unweighted,
    voteSetHash: t.voteSetHash,
    // Keys, types and collateral of every counted vote proven (the proven list for keys, the ProRegTxs for collateral and type),
    // nothing excluded (an excluded vote is one the tally may count, so the count here could be missing what it stood for), and the
    // bridge's list agreeing with the proven facts (a bridge that misstates them is not one to vouch for).
    keysFrom: input.sml && input.proReg && excluded === 0 && listDiffers.size === 0 ? 'sml' : 'bridge',
    listDiffers: listDiffers.size,
    smlChecked,
    collateralProven,
    targets: input.targets.map((target) => {
      const compare = compareWith(target.tally, t.weighted, t.unweighted, t.voteSetHash);
      const matches = compare.every((c) => c.ok);
      const servedMatches = matches || (!!all && compareWith(target.tally, all.weighted, all.unweighted, all.voteSetHash).every((c) => c.ok));
      return { name: target.name, asOfHeight: target.tally.asOfHeight, compare, matches, servedMatches };
    }),
  };
}
