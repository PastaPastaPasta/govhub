// Fee estimates for the UI, from the phase-0 measurements (spikes/sdk5 README §5.3, testnet PV14; mainnet PV13
// agreed within ~1% for identities and reactions, comments ran up to ~50% higher in single samples). evo-sdk's
// documentCreateCost throws at PV13, so the client cannot ask; these are labelled "about" everywhere they show.
// Deletes refund most of the storage fee (negative cost).

export const CREDITS_PER_DASH = 100_000_000_000;

/** Measured comment creates: [UTF-8 bytes, credits]. */
const COMMENT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [50, 42_925_560],
  [280, 56_175_700],
  [1000, 68_134_040],
  [5000, 178_395_000],
];

/** Linear interpolation (and extrapolation below 50 B) over the measured comment creates. */
export function commentCost(bytes: number): number {
  const pts = COMMENT_POINTS;
  let i = 0;
  while (i < pts.length - 2 && bytes > pts[i + 1]![0]) i++;
  const [x0, y0] = pts[i]!;
  const [x1, y1] = pts[i + 1]!;
  return Math.max(30_000_000, Math.round(y0 + ((bytes - x0) * (y1 - y0)) / (x1 - x0)));
}

export const COSTS = {
  /** a first reaction on a target costs about as much as a comment */
  reactionCreate: 50_109_000,
  /** replacing it with the other value */
  reactionFlip: 3_207_060,
  /** clearing it refunds storage */
  reactionDelete: -43_185_272,
  claim: 35_775_120,
  profileCreate: 33_121_580,
  profileReplace: 2_940_860,
  blockCreate: 22_541_040,
  modBlockCreate: 37_914_380,
  blockDelete: -19_574_449,
  blockSubsCreate: 25_187_660,
  blockSubsReplace: 4_525_580,
} as const;

/**
 * proposalPost: a create pays ~29k credits per stored byte over a ~40 M base (measured 1.5 KB = 79 M, 15 KB =
 * 491 M); a replace pays for the bytes it adds (measured +2.5 KB = 74 M) and little else.
 */
export function postCost(compressedBytes: number, previousBytes?: number): number {
  if (previousBytes === undefined) return Math.round(40_000_000 + compressedBytes * 29_000);
  return Math.round(3_000_000 + Math.max(0, compressedBytes - previousBytes) * 29_000);
}

/** Retracting a comment refunds roughly its per-byte storage. */
export const commentRetractRefund = (bytes: number): number => Math.round(-Math.max(0, commentCost(bytes) - 22_000_000));

export const creditsToDash = (credits: number | bigint): number => Number(credits) / CREDITS_PER_DASH;

/**
 * What Platform wants on the identity before it will take a write: not the fee, the pre-check. Drive estimates the worst case of
 * the transition (storage written to fresh trees plus processing, refunds ignored: `validate_fees_of_event`, "TODO: should take
 * into account refunds") and refuses it unless the balance covers that estimate. The settled fee is much lower, and the gap is
 * about the same for every create of this size: a 52 B comment settles near 43 M credits but was refused at 150 M with
 * "required 227,124,440". So the requirement is the fee plus about this much, not a multiple of it (a 5 KB comment is not asked
 * for 5 times its fee). Calibrated on that refusal; the keyring writes of `voting/funds.ts` were measured the same way.
 */
export const UPFRONT_HEADROOM = 185_000_000;

/** About what must be available on the identity for a write whose settled fee is about `cost` credits (refunds do not count towards it). */
export const upfrontRequired = (cost: number): number => Math.max(0, cost) + UPFRONT_HEADROOM;
