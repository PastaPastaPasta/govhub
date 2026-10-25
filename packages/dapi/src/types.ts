// Public option/result types of the high-level client (type-only: nothing here ends up in a bundle).
import type { ChainLockCheck, VerifyChainLockOptions } from './bls.ts';
import type { BloomFilterData } from './bloom.ts';
import type { Network } from './chainlock.ts';
import type { ChainLock, InstantLock, MerkleBlock, Tx } from './dash.ts';
import type { NodePool } from './pool.ts';
import type { MergeStats } from './race.ts';
import type { Checkpoint, StoredChain } from './headerchain.ts';
import type { StoredLinkedChain, VerifiedChain } from './linkedchain.ts';
import type { ProofSource, ProofState, VerifiedQuorumProof } from './quorumproof.ts';
import type { Sml, SmlQuorum } from './sml.ts';
import type { SmlProof } from './smlproof.ts';

export interface Verifiers {
  /** X11 of an 80-byte header -> 32-byte internal-order hash. `x11` from '@govhub/dapi/x11'. */
  hashHeader?: (header: Uint8Array) => Uint8Array;
  /** X11 of n concatenated 80-byte headers -> n * 32 bytes. `x11Many` from '@govhub/dapi/x11'. Falls back to hashHeader. */
  hashHeaders?: (headers: Uint8Array) => Uint8Array;
  /** `verifyChainLock` from '@govhub/dapi/bls'. */
  verifyChainLock?: (cl: ChainLock, quorums: readonly SmlQuorum[], o?: VerifyChainLockOptions) => ChainLockCheck;
  /** `verifyQuorumProof` from '@govhub/dapi/coreproof' (DIP 175 proof chains, WebAssembly). Without it anchoring uses proof of work. */
  verifyQuorumProof?: (proof: Uint8Array, trusted: ProofState, minimumHeight?: number) => VerifiedQuorumProof;
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
    anchor: null | { tip: number; confirmations: number; chainLockHeight: number; weak: string | null; /** what the chain rests on */ trust: AnchorTrust['kind'] };
    /** Why the ChainLock was not verified, when it was not. */
    notes: string[];
  };
  node: string;
}

/** Where anchorChain keeps the verified header run between sessions (the web app uses IndexedDB). */
export interface HeaderStore<T extends { network: Network } = StoredChain> {
  load(network: Network): Promise<T | null>;
  save(chain: T): Promise<void>;
}

export interface AnchorOptions extends CallOptions {
  /** Lowest height that must be in the verified chain (a collateral block, say). Default: just the checkpoint region. */
  from?: number;
  /** The proof-of-work run (used when no quorum proof can be had). */
  store?: HeaderStore;
  /**
   * Untrusted sources of DIP 175 quorum proofs (a bridge's /v1/quorum-proof, the quorum list server's /proofs), tried in order. With
   * one that works and `verifiers.verifyQuorumProof`, the chain is anchored on ChainLocks proven from the pinned quorum checkpoint and
   * proof of work plays no part; otherwise anchoring falls back to proof of work and says why in `trust.fallback`.
   */
  proofSources?: readonly ProofSource[];
  /** The ChainLock-anchored run and its last verified state (later proofs start there and are short). */
  proofStore?: HeaderStore<StoredLinkedChain>;
  onProgress?: (message: string) => void;
  /** Reuse a result this young. Default 60 s. */
  maxAgeMs?: number;
  /** Heights kept in the store. Default 400,000 (~13 MB). */
  maxStoredHeights?: number;
  /** Test seams. */
  checkpoint?: Checkpoint;
  quorumCheckpoint?: ProofState;
  now?: () => number;
}

/** A full masternode list whose entries and quorums are proven by the coinbase of a block in the verified chain. */
export interface ProvenSml extends Sml {
  proof: SmlProof;
  /** The node that sent it (no trust placed in it). */
  node: string;
}

/** What an anchored chain rests on. */
export type AnchorTrust =
  | {
    /** ChainLocks: a DIP 175 proof chain from the pinned quorum checkpoint authenticates a ChainLocked block; no proof of work. */
    kind: 'quorum-proof';
    /** The pinned checkpoint: its ChainLock quorums (and those mined after it) are the trust root. */
    checkpoint: { height: number; hash: string };
    /** The state this run's proof started from: the checkpoint, or a later state this browser verified from it earlier. */
    from: { height: number; hash: string };
    /** Where the proof came from (untrusted: the proof authenticates itself). */
    source: string;
    /** ChainLock quorum handoffs in the proof, and its size. */
    links: number;
    proofBytes: number;
    /**
     * Set when the ChainLock this browser saved was used because no source served a newer proof: why each source failed (an HTTP
     * 502 is not "no newer one exists").
     */
    newerUnavailable?: string;
  }
  | {
    /** Headers with proof of work and difficulty from the pinned header checkpoint (see headerchain.ts). */
    kind: 'proof-of-work';
    checkpoint: { height: number; hash: string };
    /** Why the quorum proof path was not used (no source configured, every source failed, ...). */
    fallback: string | null;
  };

export interface AnchoredChain {
  network: Network;
  /** The pinned checkpoint the chain is verified from (the quorum checkpoint or the header checkpoint; see `trust`). */
  checkpoint: { height: number; hash: string };
  trust: AnchorTrust;
  /** Verified block hashes from `chain.lo` to `tip`: hash links down from the ChainLock (quorum proof), or work and difficulty above the
   *  header checkpoint and hash links below it (proof of work). */
  chain: VerifiedChain;
  /** The highest verified header (a node could withhold newer blocks: heights are lower bounds of the real tip). */
  tip: number;
  /** Set when proof of work cannot be relied on for this network (testnet) and the chain rests on it: the facts are consistent, not
   *  secure. Never set on the quorum-proof path. */
  weak: string | null;
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
