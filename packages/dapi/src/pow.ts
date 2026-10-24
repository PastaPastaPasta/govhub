// Header consensus rules a light client can check: proof of work, Dark Gravity Wave difficulty, median-time-past and the
// future-time limit. Pure; 256-bit arithmetic with BigInt, truncated like arith_uint256.
// Dash Core: /Users/pasta/workspace/dash at f35a24cfca12; citations are file:line there.
import type { Network } from './chainlock.ts';

const U256 = (1n << 256n) - 1n;

/** arith_uint256::SetCompact (arith_uint256.cpp:193-211). */
export function compactToTarget(bits: number): { target: bigint; negative: boolean; overflow: boolean } {
  const size = bits >>> 24;
  let word = bits & 0x007fffff;
  let target: bigint;
  if (size <= 3) { word >>>= 8 * (3 - size); target = BigInt(word); } else target = (BigInt(word) << BigInt(8 * (size - 3))) & U256;
  return {
    target,
    negative: word !== 0 && (bits & 0x00800000) !== 0,
    overflow: word !== 0 && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32)),
  };
}

/** arith_uint256::GetCompact (arith_uint256.cpp:213-234), non-negative. */
export function targetToCompact(t: bigint): number {
  let size = t === 0n ? 0 : Math.ceil(t.toString(2).length / 8);
  let compact = size <= 3 ? Number((t << BigInt(8 * (3 - size))) & 0xffffffffn) : Number((t >> BigInt(8 * (size - 3))) & 0xffffffffn);
  if (compact & 0x00800000) { compact >>>= 8; size++; }
  return ((compact | (size << 24)) >>> 0);
}

export interface PowParams {
  /** consensus.powLimit as a number. */
  powLimit: bigint;
  /** consensus.nPowTargetSpacing, seconds. */
  targetSpacing: number;
  /** consensus.fPowAllowMinDifficultyBlocks (testnet). */
  allowMinDifficulty: boolean;
}

/**
 * powLimit 00000fff..ff and 2.5-minute spacing on both networks (chainparams.cpp:198-201 mainnet, :407-410 testnet); only testnet
 * allows minimum-difficulty blocks (:410). DGW is active far below any height this client checks (nPowDGWHeight 34140 / 4002).
 */
export const POW_PARAMS: Record<Network, PowParams> = {
  mainnet: { powLimit: (1n << 236n) - 1n, targetSpacing: 150, allowMinDifficulty: false },
  testnet: { powLimit: (1n << 236n) - 1n, targetSpacing: 150, allowMinDifficulty: true },
};

/** CheckProofOfWork (pow.cpp:239-256). `hash` is the X11 header hash in internal (little-endian) byte order. */
export function checkProofOfWork(hash: Uint8Array, bits: number, p: PowParams): boolean {
  const { target, negative, overflow } = compactToTarget(bits);
  if (negative || target === 0n || overflow || target > p.powLimit) return false;
  let h = 0n;
  for (let i = 31; i >= 0; i--) h = (h << 8n) | BigInt(hash[i]!);
  return h <= target;
}

/** What DGW and MTP need about one header. */
export interface HeaderTiming { bits: number; time: number }

/**
 * DarkGravityWave (pow.cpp:81-132) for the block after `prev`, which lists at least the last 24 headers, OLDEST FIRST (the last
 * element is pindexLast). The 25-instead-of-24 "average" and the 23-interval timespan are Core's, kept on purpose.
 */
export function darkGravityWave(prev: readonly HeaderTiming[], p: PowParams): number {
  const n = 24;
  if (prev.length < n) throw new Error('dgw: needs the previous 24 headers');
  const last = prev.length - 1;
  let avg = 0n;
  for (let c = 1; c <= n; c++) {
    const t = compactToTarget(prev[last - (c - 1)]!.bits).target;
    avg = c === 1 ? t : ((avg * BigInt(c) + t) / BigInt(c + 1)) & U256;
  }
  let actual = prev[last]!.time - prev[last - (n - 1)]!.time;
  const targetSpan = n * p.targetSpacing;
  if (actual < targetSpan / 3) actual = Math.trunc(targetSpan / 3);
  if (actual > targetSpan * 3) actual = targetSpan * 3;
  let next = ((avg * BigInt(actual)) & U256) / BigInt(targetSpan);
  if (next > p.powLimit) next = p.powLimit;
  return targetToCompact(next);
}

/** GetNextWorkRequired (pow.cpp:170-211) for a post-DGW block with time `time`, including testnet's minimum-difficulty rules (:191-204). */
export function nextWorkRequired(prev: readonly HeaderTiming[], time: number, p: PowParams): number {
  if (p.allowMinDifficulty) {
    const last = prev[prev.length - 1]!;
    if (time > last.time + 2 * 60 * 60) return targetToCompact(p.powLimit);
    if (time > last.time + p.targetSpacing * 4) {
      const t = (compactToTarget(last.bits).target * 10n) & U256;
      return targetToCompact(t > p.powLimit ? p.powLimit : t);
    }
  }
  return darkGravityWave(prev, p);
}

/** CBlockIndex::GetMedianTimePast (chain.h:281-295): median of the last 11 times (fewer at the start), `prev` oldest first. */
export function medianTimePast(prev: readonly HeaderTiming[]): number {
  const times = prev.slice(-11).map((h) => h.time).sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** MAX_FUTURE_BLOCK_TIME (chain.h:24). */
export const MAX_FUTURE_BLOCK_TIME = 2 * 60 * 60;
