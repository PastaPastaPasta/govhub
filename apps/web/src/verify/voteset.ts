// voteSetHash: a commitment to the exact set of votes a tally counts, so a reader who
// re-verifies the votes can compare with the `tally` document byte for byte.
//
// Definition (govhub-voteset-v1; proposed here, to move into @govhub/verify and the bridge):
//   lines  = for every masternode whose current vote is counted (latest-wins per Core, MN present in
//            the weight map), sorted by normalised outpoint "txid-n" ascending:
//            `${txid}-${n}|${outcome}|${time}\n`   (txid display hex lowercase, outcome 1/2/3, time unix s)
//   hash   = SHA-256( "govhub-voteset-v1\n" || lines )   as 32 bytes, hex in natural order
// Votes from unknown masternodes and votes Core would drop (future/negative time) are excluded.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, normalizeMnId, utf8ToBytes } from '@govhub/verify';

export const VOTESET_DOMAIN = 'govhub-voteset-v1\n';

export function voteSetHash(current: ReadonlyMap<string, { outcome: number; time: bigint }>, counted: (mnId: string) => boolean): string {
  const ids = [...current.keys()].map(normalizeMnId).filter(counted).sort();
  let text = VOTESET_DOMAIN;
  for (const id of ids) {
    const v = current.get(id)!;
    text += `${id}|${v.outcome}|${v.time}\n`;
  }
  return bytesToHex(sha256(utf8ToBytes(text)));
}
