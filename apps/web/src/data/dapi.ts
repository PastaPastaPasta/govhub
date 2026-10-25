// Core data over DAPI, through @govhub/dapi: node pool with failover (nodes from the user's quorum-service URL or a
// static list), the collateral transaction with its proof, and the agreed masternode list.
import { AllNodesFailedError, createDapi, GrpcError, VerificationError, type AnchoredChain, type Dapi, type DapiOptions, type VerifiedTransaction } from '@govhub/dapi';
import type { Registry } from '../config/registry.ts';
import type { CoreNetwork } from './types.ts';
import type { TxLookup } from '../verify/collateral.ts';

export interface DapiConfig {
  source: Registry['dapi']['source'];
  quorumUrl: string;
  nodes: string[];
  network: CoreNetwork;
  /** Where the verification worker gets quorum proofs (anchoring on ChainLocks; empty: proof of work only). */
  proofSources?: Registry['quorumProofs'];
}

export const dapiConfig = (r: Registry): DapiConfig => ({ source: r.dapi.source, quorumUrl: r.dapi.quorumUrl, nodes: r.dapi.nodes, network: r.coreNetwork, proofSources: r.quorumProofs });

/**
 * A client for the user's DAPI settings. Pass `verifiers` only where verification runs (the worker): they pull in X11 and BLS,
 * which the page never needs.
 */
export function createWebDapi(cfg: DapiConfig, verifiers?: DapiOptions['verifiers']): Dapi {
  const source: DapiOptions =
    cfg.source === 'quorum'
      ? { nodeListUrl: cfg.quorumUrl }
      : cfg.nodes.length
        ? { nodes: cfg.nodes }
        : { fetchNodes: () => Promise.reject(new Error('no DAPI nodes are configured (Settings, "My own nodes")')) };
  return createDapi({ network: cfg.network, ...source, ...(verifiers ? { verifiers } : {}) });
}

/** grpc-status NOT_FOUND. */
const NOT_FOUND = 5;

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

/** A node's answer contradicted itself (wrong bytes, tx not in its block, bad coinbase height...): evidence of a lying node, not of a flaky one. */
const isLie = (e: unknown): boolean => e instanceof VerificationError || (e instanceof AllNodesFailedError && e.errors.some((x) => x.error instanceof VerificationError));

/** The node's word for a transaction, with nothing proven (what the recorded fixture replay can offer, and the fallback when the proof fails). */
async function claimedTransaction(dapi: Dapi, txid: string, note: string): Promise<TxLookup> {
  const { value: c, node } = await dapi.call((core, signal) => core.getTransaction(txid, { signal }));
  return {
    raw: c.raw,
    height: c.height,
    confirmations: c.confirmations,
    chainLocked: c.isChainLocked ? 'claimed' : 'no',
    instantLocked: c.isInstantLocked ? 'claimed' : 'no',
    proof: { merkle: false, blockHash: 'claimed', chainLock: null, anchor: null, notes: [note] },
    node,
  };
}

/**
 * A second node's answer for the same transaction, for lookups whose block inclusion is not proven. NOT_FOUND is an answer (the
 * node contradicts the first one); only a node that could not be asked (unreachable, timeout) gives none.
 */
export async function secondOpinion(dapi: Pick<Dapi, 'pool' | 'core'>, txid: string, first: Pick<TxLookup, 'node' | 'raw'>): Promise<TxLookup['second']> {
  const [n] = dapi.pool.pick(1, [first.node]);
  if (!n) return null;
  try {
    dapi.pool.charge(n);
    const t = await dapi.core(n).getTransaction(txid);
    return { node: n, height: t.height, sameBytes: t.raw.length === first.raw.length && t.raw.every((b, i) => b === first.raw[i]) };
  } catch (e) {
    if (e instanceof GrpcError && e.code === NOT_FOUND) return { node: n, height: 0, sameBytes: false, notFound: true };
    return null;
  }
}

/**
 * The collateral transaction. With `verify` (live mode), `getVerifiedTransaction`: the block is fetched whole and its merkle root
 * recomputed, the height read from the coinbase, and, when the X11 and BLS verifiers are configured, the ChainLock is checked
 * (header chain + quorum signature). Whatever the helper could not prove stays a node claim, labelled so in the result. If the
 * proof machinery fails for transport reasons (nodes unreachable, timeouts), the node's claim is used and the reason is recorded in
 * `proof.notes`; if a node's answer was inconsistent, the lookup fails instead of quietly asking the next (possibly same) node.
 */
export async function lookupCollateral(dapi: Dapi, txid: string, o: { verify: boolean; anchor?: AnchoredChain; onProgress?: (message: string) => void }): Promise<TxLookup> {
  let lookup: TxLookup;
  if (o.verify) {
    try {
      const v: VerifiedTransaction = await dapi.getVerifiedTransaction(txid, o.anchor ? { anchor: o.anchor } : {});
      lookup = { raw: v.raw, height: v.height, confirmations: v.confirmations, chainLocked: v.chainLocked, instantLocked: v.instantLocked, proof: v.proof, node: v.node };
    } catch (e) {
      if (isAbort(e) || isLie(e)) throw e;
      o.onProgress?.('The block proof did not complete; asking a node for its claim');
      lookup = await claimedTransaction(dapi, txid, `block proof failed: ${(e as Error).message}`);
    }
  } else {
    lookup = await claimedTransaction(dapi, txid, 'node answer, block proof not requested');
  }
  // A merkle proof alone does not tie the block to the chain; the verified chain or a verified ChainLock does. Otherwise a second node weighs in.
  if (lookup.chainLocked !== 'verified' && !lookup.proof.anchor) {
    o.onProgress?.('Asking a second node for the same transaction');
    lookup.second = await secondOpinion(dapi, txid, lookup);
  }
  return lookup;
}
