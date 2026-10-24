// Public option/result types of the high-level client (type-only: nothing here ends up in a bundle).
import type { ChainLockCheck, VerifyChainLockOptions } from './bls.ts';
import type { BloomFilterData } from './bloom.ts';
import type { Network } from './chainlock.ts';
import type { ChainLock, InstantLock, MerkleBlock, Tx } from './dash.ts';
import type { NodePool } from './pool.ts';
import type { MergeStats } from './race.ts';
import type { Checkpoint, HeaderChain, StoredChain } from './headerchain.ts';
import type { Sml, SmlQuorum } from './sml.ts';
import type { SmlProof } from './smlproof.ts';

export interface Verifiers {
  /** X11 of an 80-byte header -> 32-byte internal-order hash. `x11` from '@govhub/dapi/x11'. */
  hashHeader?: (header: Uint8Array) => Uint8Array;
  /** X11 of n concatenated 80-byte headers -> n * 32 bytes. `x11Many` from '@govhub/dapi/x11'. Falls back to hashHeader. */
  hashHeaders?: (headers: Uint8Array) => Uint8Array;
  /** `verifyChainLock` from '@govhub/dapi/bls'. */
  verifyChainLock?: (cl: ChainLock, quorums: readonly SmlQuorum[], o?: VerifyChainLockOptions) => ChainLockCheck;
}

export interface DapiOptions {
  network?: Network;
  /** Static node list ("host:port" platform_https endpoints). When given, nothing is fetched at startup. */
  nodes?: readonly string[];
  /** Quorum-service-compatible URL to bootstrap nodes from. Replaceable by the user; defaults per network. */
  nodeListUrl?: string;
  /** Fully custom node source; overrides nodeListUrl. */
  fetchNodes?: () => Promise<string[]>;
  /** Crypto modules for verified results; pass the modules or an async loader to keep them out of the first bundle. */
  verifiers?: Verifiers | (() => Verifiers | Promise<Verifiers>);
  /** Per-node request budget per minute. Default 150. */
  maxPerMinute?: number;
  /** Per-request deadline. Default 15 s. */
  timeoutMs?: number;
  /** Distinct nodes tried per call before giving up. Default 4. */
  attempts?: number;
  /** Reuse an SML for this long. Default 5 min. */
  smlTtlMs?: number;
  /** Test seam: the pool, with its own clock/randomness. */
  pool?: NodePool;
}

export interface CallOptions {
  signal?: AbortSignal;
  attempts?: number;
  /** Return false for errors that every node would repeat; default: everything except INVALID_ARGUMENT/FAILED_PRECONDITION. */
  retryable?: (e: unknown) => boolean;
}

export interface SmlOptions {
  force?: boolean;
  /** Nodes asked first. Default 3. */
  nodes?: number;
  /** Identical answers required. Default 2. */
  minAgree?: number;
  /** Fresh batches of nodes to try when no agreement forms. Default 3. */
  rounds?: number;
  /** Ask `hedgeNodes` more nodes when agreement has not formed after this long (the first message is ~1.4 MB; slow nodes take 10-20 s). Default 6000. */
  hedgeAfterMs?: number;
  /** Default 2. */
  hedgeNodes?: number;
  signal?: AbortSignal;
}

export interface AgreedSml extends Sml {
  /** Nodes whose SML was identical in every field we use. */
  agreedBy: string[];
  /** Nodes that were asked (agreedBy is a subset). */
  asked: string[];
}

export type Tristate = 'verified' | 'claimed' | 'no';

export interface VerifiedTransaction {
  txid: string;
  raw: Uint8Array;
  tx: Tx;
  /** 0 while unconfirmed. Checked against the block's coinbase when `proof.merkle`. */
  height: number;
  /** Display-order block hash; null while unconfirmed. Recomputed (X11) when `proof.blockHash === 'verified'`. */
  blockHash: string | null;
  /** The node's claim, not independently checked (see proof.chainLock.verifiedConfirmations for what is proven). */
  confirmations: number;
  /** 'verified': a BLS-valid ChainLock covers a header chain that includes the tx's block. 'claimed': the node says so. */
  chainLocked: Tristate;
  /** Always a node claim: IS-lock verification needs the rotating LLMQ and is not implemented. */
  instantLocked: 'claimed' | 'no';
  proof: {
    /** The tx was recomputed into a block whose merkle root equals its header's. */
    merkle: boolean;
    /** The block's hash was recomputed (X11) and matches what the node claimed. */
    blockHash: 'verified' | 'claimed';
    chainLock: null | { height: number; blockHash: string; quorumHash: string; exact: boolean; verifiedConfirmations: number };
    /** The block is in the verified chain of `options.anchor`: `confirmations` = verified tip - height + 1 (a lower bound). */
    anchor: null | { tip: number; confirmations: number; chainLockHeight: number };
    /** Why the ChainLock was not verified, when it was not. */
    notes: string[];
  };
  node: string;
}

/** Where anchorChain keeps the verified header run between sessions (the web app uses IndexedDB). */
export interface HeaderStore {
  load(network: Network): Promise<StoredChain | null>;
  save(chain: StoredChain): Promise<void>;
}

export interface AnchorOptions extends CallOptions {
  /** Lowest height that must be in the verified chain (a collateral block, say). Default: just the checkpoint region. */
  from?: number;
  store?: HeaderStore;
  onProgress?: (message: string) => void;
  /** Reuse a result this young. Default 60 s. */
  maxAgeMs?: number;
  /** Heights kept in the store. Default 400,000 (~13 MB). */
  maxStoredHeights?: number;
  /** Test seams. */
  checkpoint?: Checkpoint;
  now?: () => number;
}

/** A full masternode list whose entries and quorums are proven by the coinbase of a block in the verified chain. */
export interface ProvenSml extends Sml {
  proof: SmlProof;
  /** The node that sent it (no trust placed in it). */
  node: string;
}

export interface AnchoredChain {
  network: Network;
  checkpoint: Checkpoint;
  /** Verified block hashes from `chain.lo` to `tip`: work and difficulty above the checkpoint, hash links below it. */
  chain: HeaderChain;
  /** The highest verified header (a node could withhold newer blocks: heights are lower bounds of the real tip). */
  tip: number;
  /** BLS-valid ChainLock on a block of `chain`: everything at or below `height` is final. */
  chainLock: { height: number; blockHash: string; quorumHash: string; exact: boolean; /** the locked header's time */ time: number };
  sml: ProvenSml;
  /** ms epoch when this was established. */
  at: number;
  stats: { cachedHeaders: number; fetchedHeaders: number; ms: Record<string, number> };
}

export interface GetVerifiedTransactionOptions extends CallOptions {
  /** Prove the block against this verified chain instead of streaming headers to a ChainLock (no height limit). */
  anchor?: AnchoredChain;
  /** Skip the ChainLock proof (one block fetch, no header stream, no SML). */
  chainLock?: boolean;
  /** Longest header chain to download and hash to reach a ChainLock. Default 2000 (about 3.5 days). */
  maxHeaderSpan?: number;
  /** How long the header stream may take. Default 20 s. */
  headerTimeoutMs?: number;
  /** When the newest ChainLock predates the tx's block, wait this long for a newer one. Default 0. */
  waitForChainLockMs?: number;
}

export interface DepositEvent { tx: Tx; raw: Uint8Array; /** output indexes paying the watched hash */ matches: number[]; node: string }
export interface IsLockEvent {
  lock: InstantLock;
  /** The exact bytes to persist: IS-locks are never replayed, and an instant asset-lock proof needs them. */
  bytes: Uint8Array;
  /** The txid was already delivered through onTx. */
  known: boolean;
  node: string;
}
export interface WatchHandlers {
  onTx(e: DepositEvent): void;
  /** Persist `e.bytes` here (await-able; errors go to onError). Called once per distinct lock. */
  onIsLock(e: IsLockEvent): void | Promise<void>;
  /** One call per block, with or without matches (a confirmation-progress heartbeat). Merkle root already checked. */
  onBlock?(b: MerkleBlock, node: string): void;
  onError?(e: unknown, ctx: { phase: string; node?: string }): void;
}
export interface WatchOptions {
  /** First block to replay. Default: best height - lookback. */
  fromHeight?: number;
  /** Blocks of replay before the tip when fromHeight is not given. Default 3. */
  lookback?: number;
  /** Parallel streams on distinct nodes. Default 3. */
  streams?: number;
  /** The returned promise resolves when this many streams are open. Default 2. */
  readyStreams?: number;
  /** Give up on becoming ready after this long. Default 15 s. */
  readyTimeoutMs?: number;
  /** A silent stream is replaced after this long. Blocks are the only heartbeat and come every 2.5 min on average (gaps over
   *  15 min are rare, about 0.3%). Replacing an idle stream is not counted against the node. Default 15 min. */
  idleTimeoutMs?: number;
  /** Cap on replacement streams over the watcher's lifetime. Default unlimited: replacements are paced by jittered backoff. */
  maxReplacements?: number;
  signal?: AbortSignal;
}
export interface Watcher {
  cancel(): void;
  /** Resolves when every stream is gone (after cancel, or when replacements ran out). */
  closed: Promise<void>;
  stats(): MergeStats;
  readonly filter: BloomFilterData;
  readonly fromHeight: number;
}
