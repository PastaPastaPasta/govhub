// X11 (block-header hashing, WebAssembly, ~59 KB gzipped), BLS12-381 (ChainLock signatures, ~28 KB gzipped) and the DIP 175 quorum proof
// verifier (WebAssembly, ~107 KB gzipped) are separate entry points of @govhub/dapi. Only the verification worker imports this file, and
// only when a verification actually runs do the modules load.
import type { Verifiers } from '@govhub/dapi';

export async function loadVerifiers(): Promise<Verifiers> {
  // the proof verifier is optional: if its chunk fails to load, anchoring falls back to proof of work (and says so) instead of failing
  const [{ x11, x11Many }, { verifyChainLock }, coreproof] = await Promise.all([
    import('@govhub/dapi/x11'), import('@govhub/dapi/bls'), import('@govhub/dapi/coreproof').catch(() => null),
  ]);
  return { hashHeader: x11, hashHeaders: x11Many, verifyChainLock, ...(coreproof ? { verifyQuorumProof: coreproof.verifyQuorumProof } : {}) };
}
