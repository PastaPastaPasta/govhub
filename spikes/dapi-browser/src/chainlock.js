// ChainLock BLS verification in the browser against a quorum public key from the SML (OPTIONAL module: pulls in
// noble BLS12-381 ~ see README for bundle cost). Dash's "basic" BLS scheme == IETF BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_,
// pubkeys in G1 (48 B), signatures in G2 (96 B).
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256d, unhex, reversed } from './dash.js';
import { concat as concat0 } from './pb.js';
import { LLMQ_TYPE } from './sml.js';

const bls = bls12_381.longSignatures;

/** requestId = sha256d(varstr("clsig") || height u32 LE)  (raw hash bytes, i.e. Core's uint256 memory order). */
export function chainLockRequestId(height) {
  const m = new Uint8Array(1 + 5 + 4);
  m[0] = 5; m.set(new TextEncoder().encode('clsig'), 1);
  new DataView(m.buffer).setUint32(6, height, true);
  return sha256d(m);
}

/** Core's quorum selection: lowest sha256d(llmqType || quorumHash || requestId) wins. Returns quorums sorted by score. */
export function rankQuorums(quorums, llmqType, requestId) {
  return quorums.map((quorum) => {
    const b = concat0([Uint8Array.of(llmqType), reversed(unhex(quorum.quorumHash)), requestId]);
    return { quorum, score: sha256d(b) };
  }).sort((a, b) => { for (let i = 0; i < 32; i++) if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i]; return 0; });
}

/**
 * Verify a parsed ChainLock ({height, blockHashInternal, signature}) against an SML snapshot (parseMasternodeListDiff result).
 * Tries the top `tryTop` ranked chainlock quorums (the SML tip can be a few blocks ahead of the signing height, so the
 * rotation may differ by one; dashcore-lib does the same retry).
 * KNOWN GAP vs Core: Core ranks only the newest `signingActiveQuorumCount` quorums as of (height - 8). We rank every
 * LLMQ_400_60 quorum in the SML tip (mainnet has exactly 4, which equals that count today). Accepting any of the top 3 is
 * looser than Core's "exactly rank 0"; tighten to tryTop=1 once the SML-at-height logic exists.
 */
export function verifyChainLock(cl, sml, { llmqType = LLMQ_TYPE.LLMQ_400_60, tryTop = 3 } = {}) {
  const requestId = chainLockRequestId(cl.height);
  const ranked = rankQuorums(sml.quorumsOfType(llmqType), llmqType, requestId);
  for (let i = 0; i < Math.min(tryTop, ranked.length); i++) {
    const { quorum } = ranked[i];
    const signHash = sha256d(concat0([Uint8Array.of(llmqType), reversed(unhex(quorum.quorumHash)), requestId, cl.blockHashInternal]));
    let ok = false;
    try { ok = bls.verify(cl.signature, bls.hash(signHash), unhex(quorum.quorumPublicKey)); } catch { ok = false; }
    if (ok) return { ok: true, rank: i, quorumHash: quorum.quorumHash };
  }
  return { ok: false, candidates: Math.min(tryTop, ranked.length) };
}
