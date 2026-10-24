// High-level client: node pool + failover + budget, SML agreement, verified transactions, deposit watching, broadcast.
import { bytesEqual, hashHex, hex } from './bytes.ts';
import { BloomFilter, type BloomFilterData } from './bloom.ts';
import { CHAINLOCK_PARAMS, type Network } from './chainlock.ts';
import type { ChainLockCheck, VerifyChainLockOptions } from './bls.ts';
import { DapiCore } from './core.ts';
import {
  type Block, type ChainLock, type InstantLock, type MerkleBlock, type Tx,
  classifyScript, coinbaseHeight, parseBlock, parseChainLock, parseHeader, parseInstantLock, parseMerkleBlock, parseTx,
} from './dash.ts';
import { AllNodesFailedError, VerificationError } from './errors.ts';
import { GrpcError } from './grpcweb.ts';
import { MAINNET_NODE_LIST, TESTNET_NODE_LIST, fetchNodes } from './nodes.ts';
import { NodePool, backoffMs, sleep } from './pool.ts';
import { type MergeStats, mergeStreams } from './race.ts';
import { type Sml, type SmlQuorum, parseSml } from './sml.ts';

export interface Verifiers {
  /** X11 of an 80-byte header -> 32-byte internal-order hash. `x11` from '@govhub/dapi/x11'. */
  hashHeader?: (header: Uint8Array) => Uint8Array;
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
  /** Crypto modules for verified results; pass the module or an async loader to keep them out of the first bundle. */
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

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
const defaultRetryable = (e: unknown): boolean => !(e instanceof GrpcError && (e.code === 3 || e.code === 9));

export interface AgreedSml extends Sml {
  /** Nodes whose SML was byte-for-byte equal in every field we use. */
  agreedBy: string[];
  /** Nodes that were asked (agreedBy is a subset). */
  asked: string[];
}

export type Tristate = 'verified' | 'claimed' | 'no';

export interface VerifiedTransaction {
  txid: string;
  raw: Uint8Array;
  tx: Tx;
  /** 0 while unconfirmed. Verified against the block's coinbase when `proof.merkle`. */
  height: number;
  /** Display-order block hash; null while unconfirmed. Verified (X11) when `proof.blockHash === 'verified'`. */
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
    /** Why the ChainLock was not verified, when it was not. */
    notes: string[];
  };
  node: string;
}

export interface GetVerifiedTransactionOptions extends CallOptions {
  /** Skip the ChainLock proof (one block fetch, no header stream). */
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
  /** A silent stream is replaced after this long (blocks arrive every 2.5 min on average). Default 5 min. */
  idleTimeoutMs?: number;
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

type WatchItem =
  | { k: 'tx'; e: DepositEvent }
  | { k: 'is'; e: IsLockEvent }
  | { k: 'block'; b: MerkleBlock };

export class Dapi {
  readonly network: Network;
  readonly pool: NodePool;
  readonly #o: DapiOptions;
  #boot?: Promise<void>;
  #verifiers?: Promise<Verifiers>;
  #sml?: { at: number; value: AgreedSml };
  #smlInflight?: Promise<AgreedSml>;
  readonly #heights = new Map<string, number>();

  constructor(o: DapiOptions = {}) {
    this.#o = o;
    this.network = o.network ?? 'mainnet';
    this.pool = o.pool ?? new NodePool(o.nodes ?? [], { maxPerMinute: o.maxPerMinute });
  }

  get #timeoutMs(): number { return this.#o.timeoutMs ?? 15000; }
  #core(node: string): DapiCore { return new DapiCore(node, { timeoutMs: this.#timeoutMs }); }
  #crypto(): Promise<Verifiers> {
    const v = this.#o.verifiers;
    return (this.#verifiers ??= Promise.resolve(typeof v === 'function' ? v() : (v ?? {})));
  }

  /** Make sure the pool has nodes: a static list is used as is, otherwise they are fetched once from the node-list URL. */
  ready(): Promise<string[]> {
    if (this.pool.size) return Promise.resolve(this.pool.list());
    this.#boot ??= (this.#o.fetchNodes?.() ?? fetchNodes(this.#o.nodeListUrl ?? (this.network === 'testnet' ? TESTNET_NODE_LIST : MAINNET_NODE_LIST)))
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
    const attempts = o.attempts ?? this.#o.attempts ?? 4, retryable = o.retryable ?? defaultRetryable;
    const tried = new Set<string>(), errors: { node: string; error: unknown }[] = [];
    let notFound = 0;
    for (let i = 0; i < attempts; i++) {
      const node = this.pool.pick(1, tried)[0];
      if (!node) break;
      tried.add(node);
      try {
        this.pool.charge(node);
        const value = await fn(this.#core(node), o.signal);
        this.pool.ok(node);
        return { value, node };
      } catch (e) {
        if (isAbort(e) || o.signal?.aborted) throw e;
        errors.push({ node, error: e });
        if (!retryable(e)) throw e;
        if (e instanceof GrpcError && e.code === 5) { if (++notFound >= 2) throw e; } else if (!(e instanceof GrpcError && e.budget)) this.pool.fail(node, e);
        if (i < attempts - 1 && !(e instanceof GrpcError && e.budget)) await sleep(backoffMs(i), o.signal);
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

  /** A block by height or display hash, parsed, with its merkle root recomputed from the txids (hard failure when it does not match). */
  async getBlock(q: { height: number } | { hash: string }, o?: CallOptions): Promise<{ block: Block; raw: Uint8Array; node: string }> {
    const { value, node } = await this.call(async (core, signal) => {
      const raw = await core.getBlock(q, { signal });
      const block = parseBlock(raw);
      if (!block.merkleOk) throw new VerificationError('merkle', 'block merkle root does not match its header');
      return { raw, block };
    }, o);
    return { ...value, node };
  }

  /** Height of the block with this display hash (cached): the height the coinbase commits to. */
  async resolveBlockHeight(hash: string, o?: CallOptions): Promise<number> {
    const hit = this.#heights.get(hash);
    if (hit !== undefined) return hit;
    const v = await this.#crypto();
    const { value } = await this.call(async (core, signal) => {
      const block = parseBlock(await core.getBlock({ hash }, { signal }));
      const cb = block.txs[0];
      const h = cb ? coinbaseHeight(cb) : null;
      if (!block.merkleOk || h === null) throw new VerificationError('block', 'block has no verifiable coinbase height');
      if (v.hashHeader && hashHex(v.hashHeader(block.header.raw)) !== hash) throw new VerificationError('block-hash', 'block does not hash to the requested hash');
      return h;
    }, o);
    this.#heights.set(hash, value);
    return value;
  }

  /**
   * The full SML from several nodes, accepted only when at least `minAgree` of them return identical content (same tip, roots,
   * quorum keys and evonode endpoints). The first stream message is ~1.4 MB, so this is cached (smlTtlMs) and every stream is
   * cancelled after its first message.
   */
  getSml(o: { force?: boolean; nodes?: number; minAgree?: number; rounds?: number; signal?: AbortSignal } = {}): Promise<AgreedSml> {
    const ttl = this.#o.smlTtlMs ?? 300_000;
    if (!o.force && this.#sml && Date.now() - this.#sml.at < ttl) return Promise.resolve(this.#sml.value);
    if (!o.force && this.#smlInflight) return this.#smlInflight;
    const p = this.#fetchAgreedSml(o).then((value) => { this.#sml = { at: Date.now(), value }; return value; });
    const clear = () => { if (this.#smlInflight === p) this.#smlInflight = undefined; };
    this.#smlInflight = p;
    p.then(clear, clear);
    return p;
  }

  async #fetchAgreedSml({ nodes = 3, minAgree = 2, rounds = 3, signal }: { nodes?: number; minAgree?: number; rounds?: number; signal?: AbortSignal }): Promise<AgreedSml> {
    await this.ready();
    const used = new Set<string>(), digests: Record<string, string[]> = {};
    for (let round = 0; round < rounds; round++) {
      const picked = this.pool.pick(nodes, used);
      if (!picked.length) break;
      picked.forEach((n) => used.add(n));
      const ctrl = new AbortController();
      const onExt = () => ctrl.abort(signal?.reason);
      signal?.addEventListener('abort', onExt, { once: true });
      const groups = new Map<string, { sml: Sml; nodes: string[] }>();
      try {
        const winner = await new Promise<{ sml: Sml; nodes: string[] } | null>((resolve) => {
          let pending = picked.length;
          for (const node of picked) {
            this.#fetchSmlFrom(node, ctrl.signal).then((sml) => {
              const g = groups.get(sml.digest) ?? { sml, nodes: [] };
              g.nodes.push(node); groups.set(sml.digest, g);
              (digests[sml.digest] ??= []).push(node);
              if (g.nodes.length >= minAgree) resolve(g);
            }, (e) => { if (!isAbort(e)) this.pool.fail(node, e); }).finally(() => { if (--pending === 0) resolve(null); });
          }
        });
        if (winner) return { ...winner.sml, agreedBy: winner.nodes, asked: [...used] };
      } finally {
        ctrl.abort();
        signal?.removeEventListener('abort', onExt);
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      await sleep(backoffMs(round), signal);
    }
    throw new VerificationError('sml-disagree', `no ${minAgree} nodes returned the same SML (${Object.values(digests).map((n) => n.length).join('/') || 'none answered'})`);
  }

  async #fetchSmlFrom(node: string, signal: AbortSignal): Promise<Sml> {
    this.pool.charge(node);
    return new Promise<Sml>((resolve, reject) => {
      const h = this.#core(node).subscribeToMasternodeList((b) => {
        h.cancel();
        try { resolve(parseSml(b)); } catch (e) { reject(e); }
      }, { signal, idleTimeoutMs: 45_000, connectTimeoutMs: this.#timeoutMs });
      void h.closed.then((r) => reject(
        r.reason === 'error' ? r.error : signal.aborted ? new DOMException('aborted', 'AbortError') : new GrpcError(14, 'SML stream ended without a message', { network: true }),
      ));
    });
  }

  /**
   * Replace (or extend) the node list with the evonodes that advertise platform_https in the agreed SML. About half of the ones the
   * quorum service filters out (versionCheck != success) do not answer, so 'append' (default) keeps the service's nodes first.
   */
  async refreshNodesFromSml(o: { mode?: 'append' | 'replace'; sml?: AgreedSml } = {}): Promise<{ count: number; added: number; sml: AgreedSml }> {
    const sml = o.sml ?? await this.getSml();
    const endpoints = sml.evonodes.map((e) => e.endpoint);
    const before = this.pool.size;
    this.pool.setNodes(endpoints, o.mode ?? 'append');
    return { count: this.pool.size, added: Math.max(0, this.pool.size - before), sml };
  }

  /**
   * Verify a ChainLock against the agreed SML, with Core's quorum selection. Needs `verifiers.verifyChainLock`. Resolves the
   * base heights of the signing-type quorums (one getBlock each, cached) and refetches the SML once if it is older than the lock.
   */
  async verifyChainLock(cl: ChainLock, o: CallOptions = {}): Promise<ChainLockCheck> {
    const v = await this.#crypto();
    if (!v.verifyChainLock) throw new Error('verifyChainLock verifier not configured (pass verifiers.verifyChainLock from @govhub/dapi/bls)');
    const p = CHAINLOCK_PARAMS[this.network];
    let r: ChainLockCheck | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const sml = await this.getSml({ force: attempt > 0, signal: o.signal });
      await Promise.all(sml.quorums.filter((q) => q.llmqType === p.llmqType && q.baseHeight === undefined).map(async (q) => {
        q.baseHeight = await this.resolveBlockHeight(q.quorumHash, o);
      }));
      r = v.verifyChainLock(cl, sml.quorums, { network: this.network, smlHeight: sml.height });
      if (r.ok || r.reason !== 'stale-sml') return r;
    }
    return r!;
  }

  /**
   * A transaction with what is proven and what is only claimed. Steps, each a hard failure (next node) when inconsistent:
   * the raw bytes hash to the txid; the claimed block, parsed in full, recomputes to its header's merkle root and contains the
   * tx; the coinbase's height equals the claimed height; with X11, the header hashes to the claimed block hash. Then, with X11
   * and BLS verifiers: a header chain from that block to the newest ChainLocked block (every link X11-checked) and a BLS-valid
   * ChainLock on it make `chainLocked: 'verified'`. If that step cannot complete the result degrades to the node's claim and says why.
   */
  async getVerifiedTransaction(txid: string, o: GetVerifiedTransactionOptions = {}): Promise<VerifiedTransaction> {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('txid must be 64 hex characters');
    txid = txid.toLowerCase();
    const v = await this.#crypto();
    const { value: base, node } = await this.call(async (core, signal) => {
      const claims = await core.getTransaction(txid, { signal });
      const tx = parseTx(claims.raw);
      if (tx.txid !== txid) throw new VerificationError('txid', 'node returned a different transaction');
      const lock = claims.isInstantLocked ? 'claimed' as const : 'no' as const;
      if (!claims.blockHash || claims.height === 0) {
        return { claims, tx, merkle: false, blockHash: null, height: 0, hashChecked: false, instantLocked: lock };
      }
      const block = parseBlock(await core.getBlock({ hash: claims.blockHash }, { signal }));
      const cb = block.txs[0], ch = cb ? coinbaseHeight(cb) : null;
      if (!block.merkleOk) throw new VerificationError('merkle', 'block merkle root does not match its header');
      if (!block.txs.some((t) => t.txid === txid)) throw new VerificationError('merkle', 'transaction is not in the claimed block');
      if (ch !== claims.height) throw new VerificationError('height', `claimed height ${claims.height} but the coinbase commits to ${ch}`);
      let hashChecked = false;
      if (v.hashHeader) {
        if (hashHex(v.hashHeader(block.header.raw)) !== claims.blockHash) throw new VerificationError('block-hash', 'block header does not hash to the claimed block hash');
        hashChecked = true;
      }
      return { claims, tx, merkle: true, blockHash: claims.blockHash, height: claims.height, hashChecked, instantLocked: lock };
    }, o);

    const notes: string[] = [];
    let chainLock: VerifiedTransaction['proof']['chainLock'] = null;
    if (base.merkle && o.chainLock !== false) {
      if (!v.hashHeader) notes.push('no X11 verifier: block hash and header chain not checked');
      else if (!v.verifyChainLock) notes.push('no BLS verifier: ChainLock signature not checked');
      else {
        try {
          const r = await this.call((core, signal) => this.#proveChainLock(core, base.height, base.blockHash!, v, o, signal), { ...o, attempts: 2 });
          if ('chainLock' in r.value) chainLock = r.value.chainLock; else notes.push(r.value.reason);
        } catch (e) {
          if (isAbort(e)) throw e;
          notes.push(`chainlock proof failed: ${(e as Error).message}`);
        }
      }
    }
    const chainLocked: Tristate = chainLock ? 'verified' : base.claims.isChainLocked ? 'claimed' : 'no';
    return {
      txid, raw: base.claims.raw, tx: base.tx, height: base.height, blockHash: base.blockHash,
      confirmations: base.claims.confirmations, chainLocked, instantLocked: base.instantLocked,
      proof: { merkle: base.merkle, blockHash: base.hashChecked ? 'verified' : 'claimed', chainLock, notes }, node,
    };
  }

  async #proveChainLock(
    core: DapiCore, height: number, blockHash: string, v: Verifiers, o: GetVerifiedTransactionOptions, signal?: AbortSignal,
  ): Promise<{ chainLock: NonNullable<VerifiedTransaction['proof']['chainLock']> } | { reason: string }> {
    const maxSpan = o.maxHeaderSpan ?? 2000, headers: Uint8Array[] = [];
    let cl: ChainLock | null = null;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); unlink(); h.cancel(); if (err) reject(err); else resolve(); };
      const onAbort = () => done(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      const unlink = () => signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const waitUntil = Date.now() + (o.waitForChainLockMs ?? 0);
      const check = () => {
        if (!cl) return;
        if (cl.height < height) { if (Date.now() >= waitUntil) done(); return; }
        if (cl.height - height > maxSpan || headers.length > cl.height - height) done();
      };
      const timer = setTimeout(() => done(new GrpcError(4, 'header stream timed out')), o.headerTimeoutMs ?? 20_000);
      const h = core.subscribeToBlockHeadersWithChainLocks({ fromHeight: height }, (ev) => {
        try {
          if (ev.type === 'headers') { for (const x of ev.headers) if (headers.length <= maxSpan + 8) headers.push(x); } else cl = parseChainLock(ev.chainLock);
          check();
        } catch (e) { done(e); }
      }, { idleTimeoutMs: 20_000, connectTimeoutMs: this.#timeoutMs });
      void h.closed.then((r) => { if (r.reason !== 'cancelled') done(r.reason === 'error' ? r.error : new GrpcError(14, 'header stream ended early', { network: true })); });
    });
    const lock = cl as ChainLock | null;
    if (!lock) return { reason: 'no ChainLock received from the node' };
    if (lock.height < height) return { reason: `newest ChainLock (${lock.height}) predates the block (${height})` };
    if (lock.height - height > maxSpan) return { reason: `block is ${lock.height - height} blocks below the newest ChainLock (maxHeaderSpan ${maxSpan})` };

    const hash = v.hashHeader!;
    const span = lock.height - height;
    let prev = hash(headers[0] ?? new Uint8Array(0));
    if (hashHex(prev) !== blockHash) throw new VerificationError('header-chain', 'first streamed header is not the claimed block');
    for (let i = 1; i <= span; i++) {
      const raw = headers[i];
      if (!raw || parseHeader(raw).prevHash !== hashHex(prev)) throw new VerificationError('header-chain', `header chain breaks at +${i}`);
      prev = hash(raw);
    }
    if (!bytesEqual(prev, lock.blockHashInternal)) throw new VerificationError('header-chain', 'the ChainLocked block is not on the streamed header chain');
    const r = await this.verifyChainLock(lock, { signal });
    if (!r.ok) throw new VerificationError('chainlock', `ChainLock signature not accepted (${r.reason})`);
    return { chainLock: { height: lock.height, blockHash: lock.blockHash, quorumHash: r.quorumHash, exact: r.exact, verifiedConfirmations: span + 1 } };
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

  /**
   * Watch a bloom filter on several nodes at once (IS-locks arrive 1-3 s after the tx, are never replayed, and each node sees
   * them at different times). Resolves only after `readyStreams` streams are open, so a QR code can be shown on resolve.
   * Each distinct tx / IS-lock / block is delivered once, from whichever node was first. Dead streams are replaced from the pool.
   */
  async watchTransactions(
    filter: BloomFilterData, handlers: WatchHandlers, o: WatchOptions = {}, match: (tx: Tx) => number[] = () => [0],
  ): Promise<Watcher> {
    if (filter.vData.length < 200) throw new Error('bloom filter must be at least 200 bytes (smaller ones match everything on DAPI nodes)');
    await this.ready();
    const wanted = o.streams ?? 3, readyNeeded = Math.min(o.readyStreams ?? 2, wanted);
    const fromHeight = o.fromHeight ?? Math.max(0, (await this.getBestBlockHeight({ signal: o.signal })).height - (o.lookback ?? 3));
    const live = new Set<string>(), seenTx = new Set<string>();
    const onError = handlers.onError ?? (() => {});
    let open = 0, readyDone = false, resolveReady!: () => void;
    const ready = new Promise<void>((r) => { resolveReady = r; });
    const noteOpen = () => { open++; if (!readyDone && open >= readyNeeded) { readyDone = true; resolveReady(); } };

    const merged = mergeStreams<WatchItem>(
      () => { const n = this.pool.pick(1, live)[0]; if (n) live.add(n); return n; },
      (node, emit) => {
        let opened = false;
        this.pool.charge(node);
        const h = this.#core(node).subscribeToTransactionsWithProofs(filter, { fromHeight }, (ev) => {
          try {
            if (ev.type === 'rawtxs') {
              for (const raw of ev.txs) {
                const tx = parseTx(raw), matches = match(tx);
                if (matches.length) emit('tx:' + tx.txid, { k: 'tx', e: { tx, raw, matches, node } });
              }
            } else if (ev.type === 'islocks') {
              for (const bytes of ev.messages) {
                try { emit('is:' + hex(bytes), { k: 'is', e: { lock: parseInstantLock(bytes), bytes, known: false, node } }); } catch (e) { onError(e, { phase: 'islock-parse', node }); }
              }
            } else {
              const b = parseMerkleBlock(ev.merkleBlock);
              if (!b.rootOk) throw new VerificationError('merkle', 'merkleblock root does not match its header');
              emit('mb:' + hex(b.header.raw), { k: 'block', b });
            }
          } catch (e) { onError(e, { phase: 'stream-event', node }); }
        }, { idleTimeoutMs: o.idleTimeoutMs ?? 300_000, connectTimeoutMs: this.#timeoutMs, onOpen: () => { opened = true; noteOpen(); } });
        void h.closed.then(() => { live.delete(node); if (opened) open--; });
        return h;
      },
      (item, node) => {
        if (item.k === 'tx') { seenTx.add(item.e.tx.txid); handlers.onTx(item.e); }
        else if (item.k === 'is') {
          const e = { ...item.e, known: seenTx.has(item.e.lock.txid), node };
          void Promise.resolve().then(() => handlers.onIsLock(e)).catch((err) => onError(err, { phase: 'islock-persist', node }));
        } else handlers.onBlock?.(item.b, node);
      },
      {
        n: wanted, maxReplacements: o.maxReplacements ?? 100, replaceDelayMs: (k) => backoffMs(Math.min(k, 6), 200, 5000),
        onClose: (node, res) => {
          const r = res as { reason?: string; error?: unknown };
          if (r.reason === 'error') { this.pool.fail(node, r.error); onError(r.error, { phase: 'stream-closed', node }); }
        },
      },
    );
    const abort = () => merged.cancel();
    o.signal?.addEventListener('abort', abort, { once: true });
    void merged.closed.then(() => o.signal?.removeEventListener('abort', abort));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AllNodesFailedError(merged.stats().failed.map((f) => ({ node: f.node, error: new Error(f.error) })))), o.readyTimeoutMs ?? 15_000);
      void merged.closed.then(() => { if (!readyDone) reject(new AllNodesFailedError(merged.stats().failed.map((f) => ({ node: f.node, error: new Error(f.error) })))); });
    });
    try {
      await Promise.race([ready, failed]);
    } catch (e) {
      merged.cancel();
      throw e;
    } finally {
      clearTimeout(timer);
      failed.catch(() => {}); // the losing branch must not surface as an unhandled rejection
    }
    return { cancel: () => merged.cancel(), closed: merged.closed, stats: merged.stats, filter, fromHeight };
  }

  /**
   * Watch an address (its 20-byte pubkey/script hash) for deposits. The filter is a >= 200 byte BIP37 filter with the hash inserted,
   * update flag ALL; streams run on 3 nodes. Resolves when the subscription is live. Persist IS-lock bytes in handlers.onIsLock:
   * if the page reloads after the lock was sent, the lock is gone for good (only a ChainLock proof remains).
   */
  watchAddressForDeposit(pubKeyHash: Uint8Array, handlers: WatchHandlers, o: WatchOptions = {}): Promise<Watcher> {
    if (pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes');
    const filter = new BloomFilter(1).insert(pubKeyHash).toJSON();
    const paysHash = (tx: Tx): number[] => tx.outputs.flatMap((out, i) => {
      const c = classifyScript(out.script);
      return (c.type === 'p2pkh' || c.type === 'p2sh') && bytesEqual(c.hash, pubKeyHash) ? [i] : [];
    });
    return this.watchTransactions(filter, handlers, o, paysHash);
  }
}

export const createDapi = (o?: DapiOptions): Dapi => new Dapi(o);
