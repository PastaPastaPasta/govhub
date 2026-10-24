// voteSetHash (govhub-voteset-v1): a commitment to the exact set of votes behind a tally, so a reader who re-verifies the
// signed votes can compare its recount with a bridge's `tally` document byte for byte.
//
//   lines = one line per COUNTED masternode, i.e. every masternode whose current funding vote (latest wins, Core's rules,
//           see tallyVotes) is in the tally's weight map, sorted by the masternode id string ascending (JS string order =
//           ASCII order, so "...-10" sorts before "...-9"):
//             `${txid}-${n}|${outcome}|${time}\n`
//           txid = collateral txid, DISPLAY hex, lowercase; n = collateral index, decimal without leading zeros;
//           outcome = 1 yes, 2 no, 3 abstain (0 none is kept if it is the current vote); time = the signed nTime, decimal.
//   hash  = SHA-256( UTF-8("govhub-voteset-v1\n" || lines) ), 32 bytes; shown as lowercase hex in natural byte order
//           (no reversal). Stored on Platform in `tally.voteSetHash` as those 32 bytes.
//
// The signal (funding), the proposal hash and the signatures are not part of the line: the set is per proposal, only funding
// votes are tallied, and every signature is verified separately against the voting key.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from './bytes.ts';
import { normalizeMnId, tallyVotes, type TallyOptions, type TallyResult, type TallyVote } from './tally.ts';

export const VOTE_SET_DOMAIN = 'govhub-voteset-v1\n';

export interface VoteSetEntry {
  /** Collateral outpoint "txid-n" (display hex). Normalised with normalizeMnId. */
  mn: string;
  outcome: number;
  time: number | bigint;
}

/** The exact text that is hashed. Throws on a malformed id, a non-integer outcome/time, or a masternode listed twice. */
export function voteSetPreimage(entries: Iterable<VoteSetEntry>): string {
  const rows: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const id = normalizeMnId(e.mn);
    if (!/^[0-9a-f]{64}-\d+$/.test(id)) throw new Error(`voteSet: masternode id must be a collateral outpoint "txid-n", got ${JSON.stringify(e.mn)}`);
    if (seen.has(id)) throw new Error(`voteSet: masternode ${id} listed twice`);
    seen.add(id);
    if (!Number.isInteger(e.outcome) || e.outcome < 0 || e.outcome > 3) throw new Error(`voteSet: invalid outcome ${e.outcome}`);
    rows.push([id, `${id}|${e.outcome}|${BigInt(e.time)}\n`]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return VOTE_SET_DOMAIN + rows.map((r) => r[1]).join('');
}

/** SHA-256 of voteSetPreimage, lowercase hex. */
export function voteSetHash(entries: Iterable<VoteSetEntry>): string {
  return bytesToHex(sha256(utf8ToBytes(voteSetPreimage(entries))));
}

export interface CountedVotes extends TallyResult {
  /** The COUNTED set: the current vote of every masternode that is in the weight map (normalised ids). This is what `voteSetHash` commits to. */
  counted: Array<{ mn: string; outcome: number; time: bigint }>;
  /** voteSetHash of `counted`. */
  voteSetHash: string;
}

/**
 * THE counting rule, shared by the bridge (which publishes a tally) and by every client that recounts it:
 * `tallyVotes` (current vote per masternode by Core's rules; weights 1 / 4; masternodes absent from `weights` are not counted) plus
 * the voteSetHash over exactly the counted masternodes. PoSe-banned masternodes belong in `weights`: their votes count, only the
 * funding threshold ignores them (see `tallyVotes`). Callers must pass only signature-verified FUNDING votes whose signer is the
 * masternode's current voting key.
 */
export function countVotes(votes: Iterable<TallyVote>, weights: ReadonlyMap<string, number> | Readonly<Record<string, number>>, opts: TallyOptions = {}): CountedVotes {
  const t = tallyVotes(votes, weights, opts);
  const unknown = new Set(t.unknownMasternodes);
  const counted = [...t.current].filter(([mn]) => !unknown.has(mn)).map(([mn, v]) => ({ mn, outcome: v.outcome, time: v.time }));
  return { ...t, counted, voteSetHash: voteSetHash(counted) };
}
