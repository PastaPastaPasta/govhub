// X11 (block-header hashing, WebAssembly, ~59 KB gzipped) and BLS12-381 (ChainLock signatures, ~28 KB gzipped) are separate entry points of
// @govhub/dapi. Only the verification worker imports this file, and only when a verification actually runs does either module load.
import type { Verifiers } from '@govhub/dapi';

export async function loadVerifiers(): Promise<Verifiers> {
  const [{ x11, x11Many }, { verifyChainLock }] = await Promise.all([import('@govhub/dapi/x11'), import('@govhub/dapi/bls')]);
  return { hashHeader: x11, hashHeaders: x11Many, verifyChainLock };
}
