// X11 (block-header hashing, WebAssembly, ~59 KB gzipped), BLS12-381 (ChainLock signatures, ~28 KB gzipped) and the DIP 175 quorum proof
// verifier (WebAssembly, ~107 KB gzipped) are separate entry points of @govhub/dapi. Only the verification worker imports this file, and
// only when a verification actually runs do the modules load.
import type { Verifiers } from '@govhub/dapi';

export async function loadVerifiers(): Promise<Verifiers> {
  const [{ x11, x11Many }, { verifyChainLock }, { verifyQuorumProof }] = await Promise.all([import('@govhub/dapi/x11'), import('@govhub/dapi/bls'), import('@govhub/dapi/coreproof')]);
  return { hashHeader: x11, hashHeaders: x11Many, verifyChainLock, verifyQuorumProof };
}
