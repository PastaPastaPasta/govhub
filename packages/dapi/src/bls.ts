// ChainLock BLS verification (own entry point: pulls in @noble/curves bls12-381, ~27 KB gz).
// Dash's "basic" BLS scheme is the IETF BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_ ciphersuite: public keys in G1 (48 B),
// signatures in G2 (96 B), and Core signs the 32-byte sign hash as the message (CBLSSignature::VerifyInsecure, llmq/quorumsman.cpp:796).
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { compareBytes, unhex } from './bytes.ts';
import {
  CHAINLOCK_PARAMS, type ChainLockParams, type Network, chainLockCandidateSets, chainLockRequestId, chainLockSignHash, quorumScore,
} from './chainlock.ts';
import type { ChainLock } from './dash.ts';
import type { SmlQuorum } from './sml.ts';


const bls = bls12_381.longSignatures;

/** Verify one signature of `signHash` under a quorum public key. Never throws: malformed input is simply "not valid". */
export function blsVerify(signature: Uint8Array, signHash: Uint8Array, publicKey: Uint8Array): boolean {
  try { return bls.verify(signature, bls.hash(signHash), publicKey); } catch { return false; }
}

export type ChainLockCheck =
  | {
    ok: true;
    quorumHash: string;
    /** True when the signing quorum is exactly the one Core's SelectQuorumForSigning picks (the quorum set was complete).
     *  False when the SML lacked older quorums Core would have considered: the signature is still a real quorum signature. */
    exact: boolean;
  }
  | { ok: false; reason: 'bad-signature' | 'no-quorum' | 'stale-sml'; exact: boolean };

export interface VerifyChainLockOptions {
  network?: Network;
  /** Override the per-network parameters (custom devnets). */
  params?: ChainLockParams;
  /** Height of the SML's tip block (Sml.height); enables the staleness check. */
  smlHeight?: number | null;
}

/**
 * Verify a parsed ChainLock against the SML's quorums. Every quorum of the ChainLock type must carry `baseHeight`
 * (the height of its quorumHash block); the client resolves those. Selection follows Core exactly (see chainlock.ts): the
 * lowest-scoring quorum of the set active at height-8 must have signed. No "try the top 3" looseness.
 */
export function verifyChainLock(cl: ChainLock, quorums: readonly SmlQuorum[], o: VerifyChainLockOptions = {}): ChainLockCheck {
  const p = o.params ?? CHAINLOCK_PARAMS[o.network ?? 'mainnet'];
  const { sets, complete, stale } = chainLockCandidateSets(quorums, cl.height, p, o.smlHeight);
  if (!sets.length) return { ok: false, reason: 'no-quorum', exact: true };
  const requestId = chainLockRequestId(cl.height);
  for (const [i, set] of sets.entries()) {
    // Complete set: only the rank-0 quorum counts. Incomplete set: Core's rank-0 may be a quorum this SML lacks, so any known
    // quorum of the set whose signature verifies is accepted and reported as inexact.
    const exact = complete[i]! && !stale;
    const ranked = set.map((q) => ({ q, s: quorumScore(p.llmqType, q.quorumHash, requestId) })).sort((a, b) => compareBytes(a.s, b.s));
    for (const { q } of complete[i]! ? ranked.slice(0, 1) : ranked) {
      if (blsVerify(cl.signature, chainLockSignHash(p.llmqType, q.quorumHash, requestId, cl.blockHashInternal), unhex(q.quorumPublicKey))) {
        return { ok: true, quorumHash: q.quorumHash, exact };
      }
    }
  }
  return { ok: false, reason: stale ? 'stale-sml' : 'bad-signature', exact: complete.every(Boolean) && !stale };
}
