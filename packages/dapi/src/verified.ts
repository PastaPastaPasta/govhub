// Verified reads (loaded on first use): blocks, block heights, ChainLocks and transactions checked against their proofs.
import { getSml } from './agreed-sml.ts';
import type { ChainLockCheck } from './bls.ts';
import { bytesEqual, hashHex } from './bytes.ts';
import { CHAINLOCK_PARAMS } from './chainlock.ts';
import type { Dapi } from './client.ts';
import type { DapiCore } from './core.ts';
import { type Block, type ChainLock, coinbaseHeight, parseBlock, parseChainLock, parseHeader, parseTx } from './dash.ts';
import { VerificationError } from './errors.ts';
import { GrpcError, abortReason, isAbort } from './grpcweb.ts';
import type { AnchoredChain, CallOptions, GetVerifiedTransactionOptions, Tristate, VerifiedTransaction, Verifiers } from './types.ts';

const heights = new WeakMap<Dapi, Map<string, number>>();

export async function getBlock(d: Dapi, q: { height: number } | { hash: string }, o?: CallOptions): Promise<{ block: Block; raw: Uint8Array; node: string }> {
  const { value, node } = await d.call(async (core, signal) => {
    const raw = await core.getBlock(q, { signal });
    const block = parseBlock(raw);
    if (!block.merkleOk) throw new VerificationError('merkle', 'block merkle root does not match its header');
    return { raw, block };
  }, o);
  return { ...value, node };
}

/** A block of the verified chain, by height: fetched by its verified hash, its merkle root recomputed and its header hashed (X11) to that hash. */
export async function getAnchoredBlock(d: Dapi, anchor: AnchoredChain, height: number, o?: CallOptions): Promise<{ block: Block; raw: Uint8Array; node: string }> {
  const want = anchor.chain.hashHexAt(height);
  if (!want) throw new Error(`block ${height} is outside the verified chain (${anchor.chain.lo}..${anchor.tip})`);
  const v = await d.crypto();
  if (!v.hashHeader) throw new Error('getAnchoredBlock needs verifiers.hashHeader');
  const { value, node } = await d.call(async (core, signal) => {
    const raw = await core.getBlock({ hash: want }, { signal });
    const block = parseBlock(raw);
    if (!block.merkleOk) throw new VerificationError('merkle', 'block merkle root does not match its header');
    if (hashHex(v.hashHeader!(block.header.raw)) !== want) throw new VerificationError('block-hash', `block ${height} is not the verified one`);
    return { raw, block };
  }, o);
  return { ...value, node };
}

export async function resolveBlockHeight(d: Dapi, hash: string, o?: CallOptions): Promise<number> {
  const cache = heights.get(d) ?? new Map<string, number>();
  heights.set(d, cache);
  const hit = cache.get(hash);
  if (hit !== undefined) return hit;
  const v = await d.crypto();
  const { value } = await d.call(async (core, signal) => {
    const block = parseBlock(await core.getBlock({ hash }, { signal }));
    const cb = block.txs[0], h = cb ? coinbaseHeight(cb) : null;
    if (!block.merkleOk || h === null) throw new VerificationError('block', 'block has no verifiable coinbase height');
    if (v.hashHeader && hashHex(v.hashHeader(block.header.raw)) !== hash) throw new VerificationError('block-hash', 'block does not hash to the requested hash');
    return h;
  }, o);
  cache.set(hash, value);
  return value;
}

/** The agreed SML with the base height of every signing-type quorum resolved (the inputs of Core's quorum selection). */
async function loadQuorums(d: Dapi, o: CallOptions, force = false) {
  const p = CHAINLOCK_PARAMS[d.network];
  const sml = await getSml(d, { force, signal: o.signal });
  await Promise.all(sml.quorums.filter((q) => q.llmqType === p.llmqType && q.baseHeight === undefined).map(async (q) => {
    q.baseHeight = await resolveBlockHeight(d, q.quorumHash, o);
  }));
  return sml;
}

export async function verifyChainLock(d: Dapi, cl: ChainLock, o: CallOptions = {}): Promise<ChainLockCheck> {
  const v = await d.crypto();
  if (!v.verifyChainLock) throw new Error('verifyChainLock verifier not configured (pass verifiers.verifyChainLock from @govhub/dapi/bls)');
  let r: ChainLockCheck | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sml = await loadQuorums(d, o, attempt > 0);
    r = v.verifyChainLock(cl, sml.quorums, { network: d.network, smlHeight: sml.height });
    if (r.ok || r.reason !== 'stale-sml') return r;
  }
  return r!;
}

export async function getVerifiedTransaction(d: Dapi, txid: string, o: GetVerifiedTransactionOptions = {}): Promise<VerifiedTransaction> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('txid must be 64 hex characters');
  txid = txid.toLowerCase();
  const v = await d.crypto();
  const { value: base, node } = await d.call(async (core, signal) => {
    const claims = await core.getTransaction(txid, { signal });
    const tx = parseTx(claims.raw);
    if (tx.txid !== txid) throw new VerificationError('txid', 'node returned a different transaction');
    const instantLocked = claims.isInstantLocked ? 'claimed' as const : 'no' as const;
    if (!claims.blockHash || claims.height === 0) {
      return { claims, tx, merkle: false, blockHash: null, height: 0, hashChecked: false, instantLocked };
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
      const known = o.anchor?.chain.hashHexAt(claims.height);
      if (known && known !== claims.blockHash) throw new VerificationError('block-hash', `block ${claims.height} is not the one in the verified chain`);
    }
    return { claims, tx, merkle: true, blockHash: claims.blockHash, height: claims.height, hashChecked, instantLocked };
  }, o);

  const notes: string[] = [];
  let chainLock: VerifiedTransaction['proof']['chainLock'] = null;
  let anchored: VerifiedTransaction['proof']['anchor'] = null;
  const a = o.anchor;
  if (base.merkle && base.hashChecked && a && a.chain.hashHexAt(base.height) === base.blockHash) {
    // the block is in the verified chain: inclusion, height and depth are proven without another header stream
    const pinned = a.chain.pinOf?.(base.height) ?? null;
    anchored = { tip: a.tip, confirmations: a.tip - base.height + 1, chainLockHeight: a.chainLock.height, weak: a.weak, trust: a.trust.kind, ...(pinned ? { pinned } : {}) };
    if (base.height <= a.chainLock.height) {
      chainLock = { height: a.chainLock.height, blockHash: a.chainLock.blockHash, quorumHash: a.chainLock.quorumHash, exact: a.chainLock.exact, verifiedConfirmations: a.chainLock.height - base.height + 1 };
    } else notes.push(`the block is newer than the newest verified ChainLock (${a.chainLock.height})`);
  } else if (base.merkle && o.chainLock !== false) {
    if (!v.hashHeader) notes.push('no X11 verifier: block hash and header chain not checked');
    else if (!v.verifyChainLock) notes.push('no BLS verifier: ChainLock signature not checked');
    else {
      try {
        // quorum data first, outside the per-node retry: an SML that cannot be agreed on is nobody's header-stream fault
        await loadQuorums(d, o);
        const r = await d.call((core, signal) => proveChainLock(d, core, base.height, base.blockHash!, v, o, signal), { ...o, attempts: 2 });
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
    proof: { merkle: base.merkle, blockHash: base.hashChecked ? 'verified' : 'claimed', chainLock, anchor: anchored, notes }, node,
  };
}

async function proveChainLock(
  d: Dapi, core: DapiCore, height: number, blockHash: string, v: Verifiers, o: GetVerifiedTransactionOptions, signal?: AbortSignal,
): Promise<{ chainLock: NonNullable<VerifiedTransaction['proof']['chainLock']> } | { reason: string }> {
  const maxSpan = o.maxHeaderSpan ?? 2000, headers: Uint8Array[] = [];
  let cl: ChainLock | null = null;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(wake); unlink(); h.cancel(); if (err) reject(err); else resolve(); };
    const onAbort = () => done(abortReason(signal!));
    const unlink = () => signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) return reject(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const wait = o.waitForChainLockMs ?? 0, waitUntil = Date.now() + wait;
    const check = () => {
      if (!cl) return;
      if (cl.height < height) { if (Date.now() >= waitUntil) done(); return; } // no newer lock yet: keep waiting until waitUntil
      if (cl.height - height > maxSpan || headers.length > cl.height - height) done();
    };
    const timer = setTimeout(() => done(new GrpcError(4, 'header stream timed out')), (o.headerTimeoutMs ?? 20_000) + wait);
    const wake = wait > 0 ? setTimeout(() => { try { check(); } catch (e) { done(e); } }, wait + 50) : undefined;
    const h = core.subscribeToBlockHeadersWithChainLocks({ fromHeight: height }, (ev) => {
      try {
        if (ev.type === 'headers') { for (const x of ev.headers) if (headers.length <= maxSpan + 8) headers.push(x); } else cl = parseChainLock(ev.chainLock);
        check();
      } catch (e) { done(e); }
    }, { idleTimeoutMs: Math.max(20_000, wait + 5000), connectTimeoutMs: d.options.timeoutMs ?? 15000 });
    void h.closed.then((r) => { if (r.reason !== 'cancelled') done(r.reason === 'error' ? r.error : new GrpcError(14, 'header stream ended early', { network: true })); });
  });
  const lock = cl as ChainLock | null;
  if (!lock) return { reason: 'no ChainLock received from the node' };
  if (lock.height < height) return { reason: `newest ChainLock (${lock.height}) predates the block (${height})` };
  if (lock.height - height > maxSpan) return { reason: `block is ${lock.height - height} blocks below the newest ChainLock (maxHeaderSpan ${maxSpan})` };

  // every link of the header chain is hashed with X11 and compared with the next header's prevHash
  const hash = v.hashHeader!, span = lock.height - height;
  let prev = hash(headers[0] ?? new Uint8Array(0));
  if (hashHex(prev) !== blockHash) throw new VerificationError('header-chain', 'first streamed header is not the claimed block');
  for (let i = 1; i <= span; i++) {
    const raw = headers[i];
    if (!raw || parseHeader(raw).prevHash !== hashHex(prev)) throw new VerificationError('header-chain', `header chain breaks at +${i}`);
    prev = hash(raw);
  }
  if (!bytesEqual(prev, lock.blockHashInternal)) throw new VerificationError('header-chain', 'the ChainLocked block is not on the streamed header chain');
  const r = await verifyChainLock(d, lock, { signal });
  if (!r.ok) throw new VerificationError('chainlock', `ChainLock signature not accepted (${r.reason})`);
  return { chainLock: { height: lock.height, blockHash: lock.blockHash, quorumHash: r.quorumHash, exact: r.exact, verifiedConfirmations: span + 1 } };
}
