// Verified reads (loaded on first use): blocks, block heights, ChainLocks and transactions checked against their proofs.
import { getSml } from './agreed-sml.ts';
import type { ChainLockCheck } from './bls.ts';
import { bytesEqual, hashHex } from './bytes.ts';
import { CHAINLOCK_PARAMS } from './chainlock.ts';
import type { Dapi } from './client.ts';
import type { DapiCore } from './core.ts';
import { type Block, type ChainLock, coinbaseHeight, parseBlock, parseChainLock, parseHeader, parseTx } from './dash.ts';
import { VerificationError } from './errors.ts';
import { GrpcError } from './grpcweb.ts';
import type { CallOptions, GetVerifiedTransactionOptions, Tristate, VerifiedTransaction, Verifiers } from './types.ts';

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
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

export async function verifyChainLock(d: Dapi, cl: ChainLock, o: CallOptions = {}): Promise<ChainLockCheck> {
  const v = await d.crypto();
  if (!v.verifyChainLock) throw new Error('verifyChainLock verifier not configured (pass verifiers.verifyChainLock from @govhub/dapi/bls)');
  const p = CHAINLOCK_PARAMS[d.network];
  let r: ChainLockCheck | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sml = await getSml(d, { force: attempt > 0, signal: o.signal });
    await Promise.all(sml.quorums.filter((q) => q.llmqType === p.llmqType && q.baseHeight === undefined).map(async (q) => {
      q.baseHeight = await resolveBlockHeight(d, q.quorumHash, o);
    }));
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
    }
    return { claims, tx, merkle: true, blockHash: claims.blockHash, height: claims.height, hashChecked, instantLocked };
  }, o);

  const notes: string[] = [];
  let chainLock: VerifiedTransaction['proof']['chainLock'] = null;
  if (base.merkle && o.chainLock !== false) {
    if (!v.hashHeader) notes.push('no X11 verifier: block hash and header chain not checked');
    else if (!v.verifyChainLock) notes.push('no BLS verifier: ChainLock signature not checked');
    else {
      try {
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
    proof: { merkle: base.merkle, blockHash: base.hashChecked ? 'verified' : 'claimed', chainLock, notes }, node,
  };
}

async function proveChainLock(
  d: Dapi, core: DapiCore, height: number, blockHash: string, v: Verifiers, o: GetVerifiedTransactionOptions, signal?: AbortSignal,
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
    }, { idleTimeoutMs: 20_000, connectTimeoutMs: d.options.timeoutMs ?? 15000 });
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
