// Badge epochs, keyed to Core superblocks (PLAN §8.2). Readers, clients and issuers all compute epochs from
// these parameters, so they are part of the reader rules: changing any of them for a network is a new
// `badge` contract version (the badge message commits to the contract id).
//
//   L  = epoch length in blocks = superblockCycle * epochCycles
//   S(E) = E * L                    (a superblock height: superblocks are the multiples of superblockCycle)
//   epoch(h) = floor(h / L)
//   tokens for E are minted only while S(E-1) <= h < S(E)            (the issuance window)
//   badges for E are posted at a uniformly random height in [S(E), S(E) + W]
//   a badge for E is shown while S(E) <= h <= S(E+1) + W, and its own height must be in that range too
//   the issuerKey for E must have been created before S(E-1)
//
// Heights are Core block heights. On Platform the relevant height is `$createdAtCoreBlockHeight` (Drive sets it to the
// block's core chain-locked height, so it cannot be back-dated) and the coreChainLockedHeight in proved metadata.

export type BadgeNetwork = 'mainnet' | 'testnet' | 'devnet' | 'regtest';

export interface EpochParams {
  /** Core's nSuperblockCycle (blocks). */
  superblockCycle: number;
  /** Superblock cycles per badge epoch. */
  epochCycles: number;
  /** W: grace after the epoch ends during which the old badge still shows, and the posting window after S(E). */
  graceBlocks: number;
  /**
   * Clients stay this far from epoch boundaries when requesting tokens and posting badges, because Platform's core height
   * lags the Core tip by a few blocks (the issuer uses its dashd tip, Drive uses the chain-locked height).
   */
  boundaryMarginBlocks: number;
}

/**
 * - mainnet: 1 cycle (16,616 blocks, about 28.8 days), W = 2,016 blocks (3.5 days), as PLAN §8.2.
 * - testnet: superblocks every 24 blocks (1 h). 24 cycles = 576 blocks, about 1 day; W = 72 blocks (3 h), the same
 *   ~12% of an epoch as mainnet. One cycle would mean a new token and a new paid badge document every hour, and a
 *   browser open every hour to renew; a day keeps renewal at a demo-friendly daily rhythm while a new badge still shows
 *   within about a day (see README "Testnet timing").
 * - devnet: same as testnet (devnets use testnet's 24-block cycle).
 * - regtest: Core's 10-block cycle, 1 cycle per epoch, W = 5 (tests only).
 */
export const EPOCH_PARAMS: Readonly<Record<BadgeNetwork, Readonly<EpochParams>>> = Object.freeze({
  mainnet: Object.freeze({ superblockCycle: 16616, epochCycles: 1, graceBlocks: 2016, boundaryMarginBlocks: 8 }),
  testnet: Object.freeze({ superblockCycle: 24, epochCycles: 24, graceBlocks: 72, boundaryMarginBlocks: 3 }),
  devnet: Object.freeze({ superblockCycle: 24, epochCycles: 24, graceBlocks: 72, boundaryMarginBlocks: 3 }),
  regtest: Object.freeze({ superblockCycle: 10, epochCycles: 1, graceBlocks: 5, boundaryMarginBlocks: 0 }),
});

/** Average Core block time, for showing estimated times only (never for any rule). */
export const BLOCK_SECONDS = 157.5;

function checkHeight(h: number): void {
  if (!Number.isSafeInteger(h) || h < 0) throw new Error('height must be a non-negative integer');
}
function checkEpoch(e: number): void {
  if (!Number.isInteger(e) || e < 1 || e > 0xffffffff) throw new Error('epoch must be an integer in 1..2^32-1');
}

export const epochLength = (p: EpochParams): number => p.superblockCycle * p.epochCycles;

/** S(E): the first height of epoch E (a superblock height). */
export function epochStart(p: EpochParams, epoch: number): number {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('epoch must be a non-negative integer');
  return epoch * epochLength(p);
}

export function epochOf(p: EpochParams, height: number): number {
  checkHeight(height);
  return Math.floor(height / epochLength(p));
}

export interface HeightRange {
  /** inclusive */
  from: number;
  /** exclusive unless stated otherwise */
  to: number;
}

/** The epoch an issuer mints tokens for at `height`: the next one. */
export const issuingEpochAt = (p: EpochParams, height: number): number => epochOf(p, height) + 1;

/** Tokens for E: S(E-1) <= h < S(E). */
export function issuanceWindow(p: EpochParams, epoch: number): HeightRange {
  checkEpoch(epoch);
  return { from: epochStart(p, epoch - 1), to: epochStart(p, epoch) };
}

/** Where a client schedules its request: the issuance window minus the boundary margins on both sides. */
export function clientIssuanceWindow(p: EpochParams, epoch: number): HeightRange {
  const w = issuanceWindow(p, epoch);
  return { from: w.from + p.boundaryMarginBlocks, to: w.to - p.boundaryMarginBlocks };
}

/** Badges for E are posted in [S(E), S(E) + W] (inclusive); clients start `boundaryMarginBlocks` after S(E). */
export function postingWindow(p: EpochParams, epoch: number): HeightRange {
  checkEpoch(epoch);
  const s = epochStart(p, epoch);
  return { from: s, to: s + p.graceBlocks };
}

/** A badge for E is shown, and may have been created, in [S(E), S(E+1) + W] (both inclusive). */
export function displayWindow(p: EpochParams, epoch: number): HeightRange {
  checkEpoch(epoch);
  return { from: epochStart(p, epoch), to: epochStart(p, epoch + 1) + p.graceBlocks };
}

export const inDisplayWindow = (p: EpochParams, epoch: number, height: number): boolean => {
  const w = displayWindow(p, epoch);
  return height >= w.from && height <= w.to;
};

/** Epochs whose badges are shown at `height` (newest first): the current one, and the previous one during its grace. */
export function displayEpochsAt(p: EpochParams, height: number): number[] {
  const e = epochOf(p, height);
  return [e, e - 1].filter((x) => x >= 1 && inDisplayWindow(p, x, height));
}

/** The issuerKey for E must exist before minting for E starts: created strictly before S(E-1). */
export const keyDeadline = (p: EpochParams, epoch: number): number => issuanceWindow(p, epoch).from;
