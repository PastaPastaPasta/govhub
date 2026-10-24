// High-level client. This file is the always-loaded core (node pool, failover, request budget, broadcast); the heavier helpers
// (verified transactions, SML agreement, deposit watching) live in their own modules and are loaded on first use, so bundlers
// that split dynamic imports keep them out of the initial chunk.
import type { ChainLockCheck } from './bls.ts';
import type { BloomFilterData } from './bloom.ts';
import { DapiCore } from './core.ts';
import type { Block, ChainLock, Tx } from './dash.ts';
import { parseTx } from './dash.ts';
import { AllNodesFailedError, VerificationError } from './errors.ts';
import { GrpcError, isAbort } from './grpcweb.ts';
import { MAINNET_NODE_LIST, TESTNET_NODE_LIST, fetchNodes } from './nodes.ts';
import { NodePool, backoffMs, sleep } from './pool.ts';
import type { Network } from './chainlock.ts';
import type {
  AgreedSml, CallOptions, DapiOptions, GetVerifiedTransactionOptions, SmlOptions, VerifiedTransaction, Verifiers, WatchHandlers, WatchOptions, Watcher,
} from './types.ts';

const defaultRetryable = (e: unknown): boolean => !(e instanceof GrpcError && (e.code === 3 || e.code === 9));

export class Dapi {
  readonly network: Network;
  readonly pool: NodePool;
  /** @internal read by the lazily loaded helper modules */
  readonly options: DapiOptions;
  #boot?: Promise<void>;
  #verifiers?: Promise<Verifiers>;

  constructor(o: DapiOptions = {}) {
    this.options = o;
    this.network = o.network ?? 'mainnet';
    this.pool = o.pool ?? new NodePool(o.nodes ?? [], { maxPerMinute: o.maxPerMinute });
  }

  /** @internal */
  core(node: string): DapiCore { return new DapiCore(node, { timeoutMs: this.options.timeoutMs ?? 15000 }); }
  /** @internal The configured crypto modules, loaded once. */
  crypto(): Promise<Verifiers> {
    const v = this.options.verifiers;
    return (this.#verifiers ??= Promise.resolve(typeof v === 'function' ? v() : (v ?? {})));
  }

  /** Make sure the pool has nodes: a static list is used as is, otherwise they are fetched once from the node-list URL. */
  ready(): Promise<string[]> {
    if (this.pool.size) return Promise.resolve(this.pool.list());
    const o = this.options;
    this.#boot ??= (o.fetchNodes?.() ?? fetchNodes(o.nodeListUrl ?? (this.network === 'testnet' ? TESTNET_NODE_LIST : MAINNET_NODE_LIST)))
      .then((nodes) => {
        if (!nodes.length) throw new Error('node source returned no usable nodes');
        this.pool.setNodes(nodes);
      })
      .catch((e) => { this.#boot = undefined; throw e; });
    return this.#boot.then(() => this.pool.list());
  }

  /**
   * Run fn against one node, failing over to another on any error that says "try another node" (a browser cannot tell TLS, CORS
   * and offline apart, so every network error is one). Attempts use distinct nodes with full-jitter backoff between them; each
   * attempt is charged against the node's request budget; failed nodes cool down. NOT_FOUND is retried once on a second node.
   */
  async call<T>(fn: (core: DapiCore, signal?: AbortSignal) => Promise<T>, o: CallOptions = {}): Promise<{ value: T; node: string }> {
    await this.ready();
    const attempts = o.attempts ?? this.options.attempts ?? 4, retryable = o.retryable ?? defaultRetryable;
    const tried = new Set<string>(), errors: { node: string; error: unknown }[] = [];
    let notFound = 0;
    for (let i = 0; i < attempts; i++) {
      const node = this.pool.pick(1, tried)[0];
      if (!node) break;
      tried.add(node);
      try {
        this.pool.charge(node);
        const value = await fn(this.core(node), o.signal);
        this.pool.ok(node);
        return { value, node };
      } catch (e) {
        if (isAbort(e) || o.signal?.aborted) throw e;
        errors.push({ node, error: e });
        if (!retryable(e)) throw e;
        const budget = e instanceof GrpcError && e.budget;
        if (e instanceof GrpcError && e.code === 5) { if (++notFound >= 2) throw e; } else if (!budget) this.pool.fail(node, e);
        if (i < attempts - 1 && !budget) await sleep(backoffMs(i), o.signal);
      }
    }
    throw new AllNodesFailedError(errors);
  }

  /** Height the node says it is at. A claim, but only from a node that reports itself synced. */
  async getBestBlockHeight(o?: CallOptions): Promise<{ height: number; bestBlockHash: string; node: string }> {
    const { value, node } = await this.call(async (core, signal) => {
      const s = await core.getBlockchainStatus({ signal });
      if (!s.chain.isSynced) throw new GrpcError(14, 'node is not synced', { network: true });
      return s;
    }, o);
    return { height: value.chain.blocksCount, bestBlockHash: value.chain.bestBlockHash, node };
  }

  /**
   * Submit a signed raw transaction. The raw bytes are parsed first, the node's returned txid must equal the locally computed one,
   * network errors move to another node (re-sending the same tx is harmless), and a node saying it already has the tx counts as success.
   */
  async broadcastTransaction(raw: Uint8Array, o: CallOptions & { allowHighFees?: boolean; bypassLimits?: boolean } = {}): Promise<{ txid: string; node: string }> {
    const tx = parseTx(raw);
    const { value, node } = await this.call(async (core, signal) => {
      try {
        const id = await core.broadcastTransaction(raw, { allowHighFees: o.allowHighFees, bypassLimits: o.bypassLimits }, { signal });
        if (id.toLowerCase() !== tx.txid) throw new VerificationError('txid', `node reported txid ${id}, expected ${tx.txid}`);
        return id;
      } catch (e) {
        if (e instanceof GrpcError && /already (in|known)|txn-already|already have/i.test(e.message)) return tx.txid;
        throw e;
      }
    }, o);
    return { txid: value, node };
  }

  // ---- loaded on first use ----

  /** A block by height or display hash, parsed, with its merkle root recomputed from the txids (hard failure when it does not match). */
  getBlock(q: { height: number } | { hash: string }, o?: CallOptions): Promise<{ block: Block; raw: Uint8Array; node: string }> {
    return import('./verified.ts').then((m) => m.getBlock(this, q, o));
  }

  /** Height of the block with this display hash (cached): the height its coinbase commits to. */
  resolveBlockHeight(hash: string, o?: CallOptions): Promise<number> {
    return import('./verified.ts').then((m) => m.resolveBlockHeight(this, hash, o));
  }

  /**
   * A transaction with what is proven and what is only claimed. Each step is a hard failure (next node) when inconsistent:
   * the raw bytes hash to the txid; the claimed block, parsed in full, recomputes to its header's merkle root and contains the
   * tx; the coinbase's height equals the claimed height; with X11, the header hashes to the claimed block hash. Then, with X11
   * and BLS verifiers: a header chain from that block to the newest ChainLocked block (every link X11-checked) and a BLS-valid
   * ChainLock on it make `chainLocked: 'verified'`. If that step cannot complete the result degrades to the node's claim and says why.
   */
  getVerifiedTransaction(txid: string, o?: GetVerifiedTransactionOptions): Promise<VerifiedTransaction> {
    return import('./verified.ts').then((m) => m.getVerifiedTransaction(this, txid, o));
  }

  /**
   * Verify a ChainLock against the agreed SML with Core's quorum selection. Needs `verifiers.verifyChainLock`. Resolves the
   * base heights of the signing-type quorums (one getBlock each, cached) and refetches the SML once if it is older than the lock.
   */
  verifyChainLock(cl: ChainLock, o?: CallOptions): Promise<ChainLockCheck> {
    return import('./verified.ts').then((m) => m.verifyChainLock(this, cl, o));
  }

  /**
   * The full SML from several nodes, accepted only when at least `minAgree` of them return identical content (same tip, roots,
   * quorum keys and evonode endpoints). The first stream message is ~1.4 MB, so this is cached (smlTtlMs) and every stream is
   * cancelled after its first message.
   */
  getSml(o?: SmlOptions): Promise<AgreedSml> {
    return import('./agreed-sml.ts').then((m) => m.getSml(this, o));
  }

  /**
   * Replace (or extend) the node list with the evonodes that advertise platform_https in the agreed SML. About half of the ones the
   * quorum service filters out (versionCheck != success) do not answer, so 'append' (default) keeps the service's nodes first.
   */
  refreshNodesFromSml(o?: { mode?: 'append' | 'replace'; sml?: AgreedSml }): Promise<{ count: number; added: number; sml: AgreedSml }> {
    return import('./agreed-sml.ts').then((m) => m.refreshNodesFromSml(this, o));
  }

  /**
   * Watch a bloom filter on several nodes at once (IS-locks arrive 1-3 s after the tx, are never replayed, and each node sees
   * them at different times). Resolves only after `readyStreams` streams are open, so a QR code can be shown on resolve.
   * Each distinct tx / IS-lock / block is delivered once, from whichever node was first. Dead streams are replaced from the pool.
   */
  watchTransactions(filter: BloomFilterData, handlers: WatchHandlers, o?: WatchOptions, match?: (tx: Tx) => number[]): Promise<Watcher> {
    return import('./watch.ts').then((m) => m.watchTransactions(this, filter, handlers, o, match));
  }

  /**
   * Watch an address (its 20-byte pubkey/script hash) for deposits. The filter is a >= 200 byte BIP37 filter with the hash inserted,
   * update flag ALL; streams run on 3 nodes. Resolves when the subscription is live. Persist IS-lock bytes in handlers.onIsLock:
   * if the page reloads after the lock was sent, the lock is gone for good (only a ChainLock proof remains).
   */
  watchAddressForDeposit(pubKeyHash: Uint8Array, handlers: WatchHandlers, o?: WatchOptions): Promise<Watcher> {
    if (pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes');
    return import('./watch.ts').then((m) => m.watchAddressForDeposit(this, pubKeyHash, handlers, o));
  }
}

export const createDapi = (o?: DapiOptions): Dapi => new Dapi(o);
