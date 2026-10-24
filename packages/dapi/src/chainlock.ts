// ChainLock signing rules, ported from Dash Core (no BLS here: see bls.ts for the signature check).
// Source tree: /Users/pasta/workspace/dash, commit f35a24cfca12 (develop). Citations are file:line in that tree.
import { compareBytes, concat, hashBytes, sha256d } from './bytes.ts';
import type { SmlQuorum } from './sml.ts';

export type Network = 'mainnet' | 'testnet';

export interface ChainLockParams {
  /** LLMQ type that signs ChainLocks (consensus.llmqTypeChainLocks). */
  llmqType: number;
  /** Blocks between DKG cycles; quorum base blocks are multiples of this. */
  dkgInterval: number;
  /** A quorum's commitment can only be mined in [cycleStart + start, cycleStart + end] of its own cycle. */
  miningWindowStart: number;
  miningWindowEnd: number;
  /** How many of the newest quorums are "active" for signing (signingActiveQuorumCount). */
  activeCount: number;
}

/**
 * mainnet: llmqTypeChainLocks = LLMQ_400_60 (src/chainparams.cpp:286), params at src/llmq/params.h:406-425
 *          (dkgInterval 24*12, mining window 20..28, signingActiveQuorumCount 4, useRotation false).
 * testnet: LLMQ_50_60 (src/chainparams.cpp:489), params at src/llmq/params.h:354-372 (24, 10..18, 24).
 */
export const CHAINLOCK_PARAMS: Record<Network, ChainLockParams> = {
  mainnet: { llmqType: 2, dkgInterval: 288, miningWindowStart: 20, miningWindowEnd: 28, activeCount: 4 },
  testnet: { llmqType: 1, dkgInterval: 24, miningWindowStart: 10, miningWindowEnd: 18, activeCount: 24 },
};

/** A ChainLock at height h is signed by a quorum chosen as of block h - 8: src/llmq/quorumsman.h:210 (SIGN_HEIGHT_OFFSET), quorumsman.cpp:717. */
export const SIGN_HEIGHT_OFFSET = 8;

/**
 * requestId = sha256d(CompactSize(5) || "clsig" || height i32 LE): chainlock/clsig.cpp:27 (prefix) and :248-251
 * (GenSigRequestId = SerializeHash(pair(prefix, height)); std::string_view serializes with a CompactSize length).
 * Returned in internal (wire) byte order, which is what every later hash consumes.
 */
export function chainLockRequestId(height: number): Uint8Array {
  const m = new Uint8Array(1 + 5 + 4);
  m[0] = 5; m.set(new TextEncoder().encode('clsig'), 1);
  new DataView(m.buffer).setInt32(6, height, true);
  return sha256d(m);
}

/** Selection score: sha256d(llmqType u8 || quorumHash || requestId), quorumsman.cpp:765-771. `quorumHash` is display hex. */
export function quorumScore(llmqType: number, quorumHash: string, requestId: Uint8Array): Uint8Array {
  return sha256d(concat(Uint8Array.of(llmqType), hashBytes(quorumHash), requestId));
}

/**
 * The hash the quorum signs: sha256d(llmqType u8 || quorumHash || requestId || msgHash), llmq/signhash.cpp:14-24, with
 * msgHash = the ChainLocked block hash (chainlock/clsig.cpp:259, 269). `blockHashInternal` is the wire-order hash from the CLSIG.
 */
export function chainLockSignHash(llmqType: number, quorumHash: string, requestId: Uint8Array, blockHashInternal: Uint8Array): Uint8Array {
  return sha256d(concat(Uint8Array.of(llmqType), hashBytes(quorumHash), requestId, blockHashInternal));
}

/** The signing quorum of a set: lowest score wins; scores compare as raw bytes (uint256 operator< is memcmp), quorumsman.cpp:772-773. */
export function selectQuorum<Q extends { quorumHash: string }>(set: readonly Q[], llmqType: number, requestId: Uint8Array): Q | undefined {
  let best: Q | undefined, bestScore: Uint8Array | undefined;
  for (const q of set) {
    const s = quorumScore(llmqType, q.quorumHash, requestId);
    if (!bestScore || compareBytes(s, bestScore) < 0) { best = q; bestScore = s; }
  }
  return best;
}

export interface CandidateSets {
  /** Possible "active quorum" sets Core could have used for this ChainLock height (newest first). Usually one; two when the
   *  signing height falls inside a mining window, because the SML does not say which block a commitment was mined in. */
  sets: SmlQuorum[][];
  /** Per set: it holds as many quorums as Core's would (activeCount), so selecting its rank 0 is exactly Core's choice. A shorter
   *  set means the SML lacks older quorums Core would also have considered: an older SML would be needed to be exact. */
  complete: boolean[];
  /** The store block is newer than the SML's tip, so quorums mined since may be missing: refetch the SML. */
  stale: boolean;
}

/**
 * Which quorums Core scans when verifying a ChainLock at `height`.
 *
 * Core: pindexStart = block (height - 8) (quorumsman.cpp:711-722); ScanQuorums(type, pindexStart, signingActiveQuorumCount)
 * (quorumsman.cpp:758) returns the newest N commitments mined at or before a store block (blockprocessor.cpp:687-730, newest
 * first). The store block is pindexStart itself only inside a DKG mining window; before the window it is the end of the previous
 * cycle's window, after it the end of this cycle's (quorumsman.cpp:184-196, "quorum sets can only change during the mining phase").
 *
 * The SML (tip set = GetMinedAndActiveCommitmentsUntilBlock(tip), evo/smldiff.cpp:34-35) holds the newest N quorums as of ITS tip,
 * each with the base-block height the caller resolved (`baseHeight`). A quorum with base height c is mined in [c + start, c + end]
 * (blockprocessor mining window), which decides membership exactly except while the store block sits inside that window.
 */
export function chainLockCandidateSets(quorums: readonly SmlQuorum[], height: number, p: ChainLockParams, smlHeight?: number | null): CandidateSets {
  const empty: CandidateSets = { sets: [], complete: [], stale: false };
  const start = height - SIGN_HEIGHT_OFFSET;
  if (start < 0) return empty;
  const mine = quorums.filter((q) => q.llmqType === p.llmqType);
  const cycleStart = start - (start % p.dkgInterval);
  const winStart = cycleStart + p.miningWindowStart, winEnd = cycleStart + p.miningWindowEnd;
  let store = start;
  if (start < winStart) { if (winEnd < p.dkgInterval) return empty; store = winEnd - p.dkgInterval; } else if (start > winEnd) store = winEnd;

  const sure: SmlQuorum[] = [], maybe: SmlQuorum[] = [];
  for (const q of mine) {
    if (q.baseHeight === undefined) throw new Error('chainlock: quorum base heights are required');
    const mineStart = q.baseHeight + p.miningWindowStart, mineEnd = q.baseHeight + p.miningWindowEnd;
    if (mineEnd <= store) sure.push(q); else if (mineStart <= store) maybe.push(q);
  }
  const newest = (a: SmlQuorum[]) => a.slice().sort((x, y) => y.baseHeight! - x.baseHeight!).slice(0, p.activeCount);
  const options = maybe.length ? [newest([...sure, ...maybe]), newest(sure)] : [newest(sure)];
  const seen = new Set<string>();
  const sets = options.filter((s) => { const k = s.map((q) => q.quorumHash).join(); if (!s.length || seen.has(k)) return false; seen.add(k); return true; });
  // a short set is only a problem when the SML itself was full: a chain that never had `activeCount` quorums has short sets in Core too
  const tipFull = mine.length >= p.activeCount;
  return { sets, complete: sets.map((s) => !tipFull || s.length >= p.activeCount), stale: smlHeight != null && store > smlHeight };
}
