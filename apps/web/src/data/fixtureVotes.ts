// Synthetic, deterministic masternodes and signed votes for fixture mode. The mainnet snapshot has
// vote COUNTS but Core's RPC does not expose vote signatures, so fixture mode invents one regular
// MN per counted vote with a throwaway key (sha256 of a public label: worthless by design) and
// signs real mainnet-scheme votes with it. The fixture tally's voteSetHash commits to exactly
// these votes, so "Verify votes" runs the real verifier end to end. Nothing here is real data.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, countVotes, hash160, p2pkhAddress, signVote, utf8ToBytes, VOTE_OUTCOME, VOTE_SIGNAL } from '@govhub/verify';
import type { BridgeMasternode, BridgeVote } from './bridge.ts';

export interface VoteCounts {
  yes: number;
  no: number;
  abstain: number;
}

const label = (kind: string, i: number) => sha256(utf8ToBytes(`govhub-fixture-${kind}:${i}`));
const mnPriv = (i: number) => label('mn', i);
/** The voting key of synthetic masternode i (fixture mode's demo keyring signs with it; never a real key). */
export const fixtureMnKey = mnPriv;
const mnCollateral = (i: number) => bytesToHex(label('collateral', i));

interface PlannedVote {
  mn: number;
  outcome: number;
  time: number;
}

/** MN i votes yes for i < yes, then no, then abstain. MN 0 also has an older, superseded "no". */
function plan(counts: VoteCounts, proposalTime: number): PlannedVote[] {
  const out: PlannedVote[] = [];
  const t0 = proposalTime + 3600;
  let i = 0;
  for (const [n, outcome] of [[counts.yes, VOTE_OUTCOME.YES], [counts.no, VOTE_OUTCOME.NO], [counts.abstain, VOTE_OUTCOME.ABSTAIN]] as const) {
    for (let k = 0; k < n; k++, i++) out.push({ mn: i, outcome, time: t0 + i * 60 });
  }
  if (out.length) out.push({ mn: 0, outcome: VOTE_OUTCOME.NO, time: t0 - 600 });
  return out;
}

export const fixtureMnCount = (counts: VoteCounts) => counts.yes + counts.no + counts.abstain;

/** voteSetHash of the synthetic vote set (cheap: no signatures needed). */
export function fixtureVoteSetHash(counts: VoteCounts, proposalTime: number): string {
  const votes = plan(counts, proposalTime).map((v) => ({ mn: `${mnCollateral(v.mn)}-0`, outcome: v.outcome, time: v.time }));
  const weights = new Map(votes.map((v) => [v.mn, 1]));
  return countVotes(votes, weights).voteSetHash;
}

/** Signs the synthetic votes (mainnet message scheme). ~1 ms per vote: run it in the worker. */
export function fixtureSignedVotes(govHash: string, counts: VoteCounts, proposalTime: number): BridgeVote[] {
  return plan(counts, proposalTime).map((v) => {
    const collateralTxid = mnCollateral(v.mn);
    const vote = { collateralTxid, collateralIndex: 0, govHashDisplay: govHash, signal: VOTE_SIGNAL.FUNDING, outcome: v.outcome, time: v.time };
    return { collateralTxid, collateralIndex: 0, signal: VOTE_SIGNAL.FUNDING, outcome: v.outcome, time: v.time, sig: signVote({ privKey: mnPriv(v.mn), vote, network: 'mainnet' }).base64 };
  });
}

export function fixtureMasternodes(n: number): BridgeMasternode[] {
  return Array.from({ length: n }, (_, i) => ({
    proTxHash: bytesToHex(label('protx', i)),
    collateralTxid: mnCollateral(i),
    collateralIndex: 0,
    votingAddress: p2pkhAddress(hash160(secp256k1.getPublicKey(mnPriv(i), true)), 'mainnet'),
    type: 'regular' as const,
    valid: true,
  }));
}
