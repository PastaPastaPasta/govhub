// Chain anchoring (loaded on first use): a header chain this client verified itself, from a pinned checkpoint (and down to any
// older block of interest) up to the tip, a masternode list proven against the coinbase of a block in that chain, and a BLS-valid
// ChainLock from a quorum that list proves. Results are cached per network through a pluggable HeaderStore (the web app uses
// IndexedDB) so later checks only fetch the headers they do not have.
//
// Order matters for soundness: headers (work + difficulty from the checkpoint) -> SML proven into a block of that chain -> quorum
// keys from the proven SML -> ChainLock signature -> the locked block is in the chain. Nothing node-supplied is used before it is
// tied to the checkpoint.
import { bytesEqual, hashHex } from './bytes.ts';
import { CHAINLOCK_PARAMS, type Network } from './chainlock.ts';
import type { Dapi } from './client.ts';
import { type Cbor, decodeCbor } from './cbor.ts';
import { type ChainLock, parseChainLock, parseHeader } from './dash.ts';
import { VerificationError } from './errors.ts';
import { GrpcError, abortReason, isAbort } from './grpcweb.ts';
import { CHECKPOINTS, type Checkpoint, DGW_WINDOW, HeaderChain, type HeaderRun, type StoredChain } from './headerchain.ts';
import { POW_PARAMS } from './pow.ts';
import { type Sml, type SmlQuorum, parseSmlDecoded } from './sml.ts';
import { type SmlProof, proveSml } from './smlproof.ts';
import type { AnchorOptions, AnchoredChain, ProvenSml, Verifiers } from './types.ts';

/** Headers per stream request. Nodes stream ~1-2k headers/s each, with a heavy tail, so ranges are split and run in parallel. */
const CHUNK = 2000;
const PARALLEL = 16;
/** Stored heights cap (~13 MB of hashes): the low end is dropped first. */
const MAX_STORED = 400_000;

interface State { stored?: StoredChain; last?: AnchoredChain; inflight?: Promise<AnchoredChain> }
const states = new WeakMap<Dapi, State>();

const now = () => Math.floor(Date.now() / 1000);

function hashMany(v: Verifiers): (headers: Uint8Array) => Uint8Array {
  if (v.hashHeaders) return v.hashHeaders;
  const one = v.hashHeader;
  if (!one) throw new Error('anchoring needs verifiers.hashHeader (or hashHeaders) from @govhub/dapi/x11');
  return (h) => {
    const out = new Uint8Array((h.length / 80) * 32);
    for (let i = 0; i < h.length / 80; i++) out.set(one(h.subarray(i * 80, i * 80 + 80)), i * 32);
    return out;
  };
}

/**
 * The verified chain, reusing (and extending) what is cached. Concurrent callers share one run; a result younger than `maxAgeMs`
 * that already covers `from` is returned as is.
 */
export function anchorChain(d: Dapi, o: AnchorOptions = {}): Promise<AnchoredChain> {
  const st = states.get(d) ?? {};
  states.set(d, st);
  const fresh = st.last && Date.now() - st.last.at < (o.maxAgeMs ?? 60_000) && (o.from === undefined || o.from >= st.last.chain.lo);
  if (fresh) return Promise.resolve(st.last!);
  if (st.inflight) return st.inflight.then((r) => (o.from === undefined || o.from >= r.chain.lo ? r : anchorChain(d, o)));
  const p = run(d, st, o).finally(() => { if (st.inflight === p) st.inflight = undefined; });
  st.inflight = p;
  return p;
}

async function run(d: Dapi, st: State, o: AnchorOptions): Promise<AnchoredChain> {
  const t0 = Date.now(), ms: Record<string, number> = {};
  const lap = (k: string, t: number) => { ms[k] = (ms[k] ?? 0) + Date.now() - t; };
  const v = await d.crypto();
  if (!v.verifyChainLock) throw new Error('anchoring needs verifiers.verifyChainLock from @govhub/dapi/bls');
  const hash = hashMany(v);
  const cp: Checkpoint = o.checkpoint ?? CHECKPOINTS[d.network];
  const pow = POW_PARAMS[d.network], clock = o.now ?? now;
  const progress = o.onProgress ?? (() => {});

  // 1. what we already have (memory, then the store)
  let t = Date.now();
  st.stored ??= (await o.store?.load(d.network).catch(() => null)) ?? undefined;
  let chain = st.stored ? HeaderChain.fromStored(st.stored, cp) : null;
  const cached = chain ? chain.hi - chain.lo + 1 : 0;
  lap('cache', t);

  // 2. the tip a node claims, the masternode list and the newest ChainLock, in parallel with the header download
  t = Date.now();
  const best = await tipHint(d, o);
  const smlP = fetchSml(d, o);
  smlP.catch(() => {});
  const want = Math.min(o.from ?? Infinity, cp.height - DGW_WINDOW);
  let fetched = 0;
  const fetchRun = async (from: number, to: number): Promise<HeaderRun> => {
    progress(`Downloading ${(to - from + 1).toLocaleString('en-US')} block headers`);
    const r = await fetchHeaders(d, from, to, hash, o);
    fetched += to - from + 1;
    return r;
  };
  if (!chain || chain.lo > cp.height || chain.hi < cp.height - 1) {
    const r = await fetchRun(Math.min(want, cp.height - DGW_WINDOW), Math.max(best.height, cp.height));
    chain = await applyRun(d, r, hash, (x) => HeaderChain.fromCheckpoint(d.network, cp, x, { pow, now: clock() }), o);
  } else {
    const c = chain;
    const [down, up] = await Promise.all([
      want < c.lo ? fetchRun(want, c.lo - 1) : null,
      best.height > c.hi ? fetchRun(c.hi + 1, best.height) : null,
    ]);
    if (down) await applyRun(d, down, hash, (x) => c.extendDown(x), o);
    if (up) await applyRun(d, up, hash, (x) => c.extendUp(x, { pow, now: clock() }), o);
  }
  lap('headers', t);
  const extendTo = async (h: number) => {
    if (h > chain!.hi) await applyRun(d, await fetchRun(chain!.hi + 1, h), hash, (x) => chain!.extendUp(x, { pow, now: clock() }), o);
  };

  // 3. the masternode list, proven into a block of the chain (its coinbase commits to both merkle roots)
  t = Date.now();
  progress('Proving the masternode list against the chain');
  const first = await smlP;
  const sml = await proveAgainstChain(d, chain, first, hash, extendTo, o).catch(async (e) => {
    if (isAbort(e)) throw e;
    // one more node: the first may have sent a list from a block we cannot place, or a bad one
    return proveAgainstChain(d, chain!, await fetchSml(d, o, [first.node]), hash, extendTo, o);
  });
  lap('sml', t);

  // 4. the newest ChainLock: signed by a quorum the proven list holds, on a block of the chain
  t = Date.now();
  progress('Checking the newest ChainLock');
  const cl = await newestChainLock(d, chain.hi, o);
  await extendTo(cl.height);
  if (chain.hashHexAt(cl.height) !== cl.blockHash) throw new VerificationError('chainlock', `the ChainLocked block ${cl.height} is not in the verified chain`);
  const p = CHAINLOCK_PARAMS[d.network];
  const quorums = await quorumsWithHeights(d, chain, sml.quorums, p.llmqType, p.dkgInterval, o);
  const check = v.verifyChainLock(cl, quorums, { network: d.network, smlHeight: sml.height });
  if (!check.ok) throw new VerificationError('chainlock', `ChainLock on block ${cl.height} not accepted (${check.reason})`);
  lap('chainlock', t);

  // 5. persist the final part (up to the lock); never anything above it
  const stored = chain.toStored({ height: cl.height, blockHash: cl.blockHash }, o.maxStoredHeights ?? MAX_STORED);
  if (stored && (!st.stored || stored.chainLock.height >= st.stored.chainLock.height || stored.lo < st.stored.lo)) {
    st.stored = stored;
    await o.store?.save(stored).catch(() => {});
  }
  const out: AnchoredChain = {
    network: d.network, checkpoint: cp, chain, tip: chain.hi,
    chainLock: { height: cl.height, blockHash: cl.blockHash, quorumHash: check.quorumHash, exact: check.exact },
    sml, at: Date.now(),
    stats: { cachedHeaders: cached, fetchedHeaders: fetched, ms: { ...ms, total: Date.now() - t0 } },
  };
  st.last = out;
  return out;
}

/**
 * Where the tip is, as a hint for how far to download: a synced node's height, else (testnet DAPI nodes report "not synced"
 * while Platform is down even though Core is current) the block count of a node whose headers and blocks agree. Everything
 * fetched up to it is verified; a node can only make the tip look lower, never fake a block.
 */
async function tipHint(d: Dapi, o: { signal?: AbortSignal }): Promise<{ height: number }> {
  try {
    return await d.getBestBlockHeight({ ...o, attempts: 2 });
  } catch (e) {
    if (isAbort(e)) throw e;
    const { value } = await d.call(async (core, signal) => {
      const s = await core.getBlockchainStatus({ signal });
      if (!s.chain.blocksCount || s.chain.blocksCount < s.chain.headersCount) throw new GrpcError(14, 'node is still syncing blocks', { network: true });
      return s.chain.blocksCount;
    }, o);
    return { height: value };
  }
}

// ---- headers --------------------------------------------------------------------------------------------------------------

/** Ask one node for `count` headers from `from`; resolves with exactly that many or fails. */
function streamHeaders(d: Dapi, node: string, from: number, count: number, signal: AbortSignal): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let got = 0;
  return new Promise<Uint8Array>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const h = d.core(node).subscribeToBlockHeadersWithChainLocks({ fromHeight: from, count }, (ev) => {
      if (ev.type !== 'headers') return;
      for (const x of ev.headers) {
        if (x.length !== 80) throw new VerificationError('header', 'header is not 80 bytes');
        if (got < count) { parts.push(x); got++; }
      }
      if (got >= count) h.cancel();
    }, { signal, idleTimeoutMs: 20_000, connectTimeoutMs: d.options.timeoutMs ?? 15000 });
    void h.closed.then((r) => {
      if (got >= count) {
        const out = new Uint8Array(count * 80);
        parts.forEach((x, i) => out.set(x, i * 80));
        resolve(out);
      } else if (r.reason === 'error') reject(r.error);
      else reject(signal.aborted ? abortReason(signal) : new GrpcError(14, `header stream ended after ${got} of ${count}`, { network: true }));
    });
  });
}

/**
 * Heights from..to as one run: chunks of CHUNK headers on up to PARALLEL nodes; a chunk that is slow (2.5x the median so far,
 * at least 4 s) is also asked from another node and the first complete answer wins; a chunk that fails or does not link inside
 * itself is retried elsewhere. Linkage across chunks, work and difficulty are checked by the caller (HeaderChain).
 */
export async function fetchHeaders(d: Dapi, from: number, to: number, hash: (h: Uint8Array) => Uint8Array, o: { signal?: AbortSignal } = {}): Promise<HeaderRun> {
  await d.ready();
  const n = to - from + 1;
  if (n <= 0) throw new Error('fetchHeaders: empty range');
  const chunks = Array.from({ length: Math.ceil(n / CHUNK) }, (_, i) => ({ from: from + i * CHUNK, count: Math.min(CHUNK, n - i * CHUNK) }));
  const headers = new Uint8Array(n * 80), hashes = new Uint8Array(n * 32);
  const durations: number[] = [], sources: NonNullable<HeaderRun['sources']> = [];
  const outer = new AbortController();
  const onAbort = () => outer.abort(abortReason(o.signal!));
  o.signal?.addEventListener('abort', onAbort, { once: true });

  const one = async (c: { from: number; count: number }): Promise<void> => {
    const tried = new Set<string>();
    const errors: unknown[] = [];
    const t0 = Date.now();
    for (let round = 0; round < 5; round++) {
      const ctrl = new AbortController();
      const stop = () => ctrl.abort(outer.signal.reason);
      outer.signal.addEventListener('abort', stop, { once: true });
      try {
        const winner = await new Promise<{ raw: Uint8Array; hashes: Uint8Array; node: string }>((resolve, reject) => {
          let pending = 0, done = false, hedge: ReturnType<typeof setTimeout> | undefined;
          const ask = () => {
            const node = d.pool.pick(1, tried)[0];
            if (!node) { if (pending === 0 && !done) reject(new Error('no node left for headers')); return; }
            tried.add(node);
            pending++;
            try { d.pool.charge(node); } catch (e) { pending--; errors.push(e); ask(); return; }
            streamHeaders(d, node, c.from, c.count, ctrl.signal).then((raw) => {
              const hs = hash(raw);
              for (let i = 1; i < c.count; i++) {
                if (!raw.subarray(i * 80 + 4, i * 80 + 36).every((b, j) => b === hs[(i - 1) * 32 + j])) throw new VerificationError('header-chain', `headers from ${node} do not link`);
              }
              d.pool.ok(node);
              if (!done) { done = true; clearTimeout(hedge); resolve({ raw, hashes: hs, node }); }
            }).catch((e) => {
              if (!isAbort(e)) { errors.push(e); d.pool.fail(node, e); }
              if (--pending === 0 && !done) { if (ctrl.signal.aborted) reject(abortReason(ctrl.signal)); else ask(); }
            });
          };
          ask();
          const sorted = durations.slice().sort((a, b) => a - b);
          const median = sorted[sorted.length >> 1] ?? 3000;
          hedge = setTimeout(() => { if (!done) ask(); }, Math.max(3000, median * 2));
        });
        headers.set(winner.raw, (c.from - from) * 80);
        hashes.set(winner.hashes, (c.from - from) * 32);
        sources.push({ ...c, node: winner.node });
        durations.push(Date.now() - t0);
        return;
      } catch (e) {
        if (outer.signal.aborted) throw abortReason(outer.signal);
        errors.push(e);
      } finally {
        ctrl.abort();
        outer.signal.removeEventListener('abort', stop);
      }
    }
    throw new Error(`headers ${c.from}..${c.from + c.count - 1}: ${(errors[errors.length - 1] as Error)?.message ?? 'no node answered'}`);
  };

  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
      while (next < chunks.length) await one(chunks[next++]!);
    }));
  } catch (e) {
    outer.abort(e);
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }
  return { from, headers, hashes, sources };
}

/**
 * Apply a header run to the chain; when a header fails a rule, the node that sent it (and the one before, for a broken link)
 * is put on cooldown and those parts are fetched again from others, at most twice.
 */
async function applyRun<T>(d: Dapi, r: HeaderRun, hash: (h: Uint8Array) => Uint8Array, apply: (r: HeaderRun) => T, o: { signal?: AbortSignal }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return apply(r);
    } catch (e) {
      const h = (e as VerificationError).height;
      if (!(e instanceof VerificationError) || h === undefined || attempt >= 2 || !r.sources) throw e;
      const bad = r.sources.filter((s) => (h >= s.from && h < s.from + s.count) || (h - 1 >= s.from && h - 1 < s.from + s.count));
      if (!bad.length) throw e;
      const headers = Uint8Array.from(r.headers), hashes = Uint8Array.from(r.hashes), sources = r.sources.filter((s) => !bad.includes(s));
      for (const s of bad) {
        d.pool.fail(s.node, e);
        const again = await fetchHeaders(d, s.from, s.from + s.count - 1, hash, o);
        headers.set(again.headers, (s.from - r.from) * 80);
        hashes.set(again.hashes, (s.from - r.from) * 32);
        sources.push(...again.sources!);
      }
      r = { from: r.from, headers, hashes, sources };
    }
  }
}

// ---- masternode list ------------------------------------------------------------------------------------------------------

interface RawSml { node: string; decoded: { [k: string]: Cbor } }

/** One node's full SML (first stream message), hedged to a second node after 6 s. */
async function fetchSml(d: Dapi, o: { signal?: AbortSignal }, avoid: string[] = []): Promise<RawSml> {
  await d.ready();
  const tried = new Set(avoid);
  const errors: unknown[] = [];
  for (let round = 0; round < 3; round++) {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort(abortReason(o.signal!));
    o.signal?.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<RawSml>((resolve, reject) => {
        let pending = 0, done = false;
        const ask = () => {
          const node = d.pool.pick(1, tried)[0];
          if (!node) { if (!pending) reject(new Error('no node left for the masternode list')); return; }
          tried.add(node);
          pending++;
          try { d.pool.charge(node); } catch (e) { pending--; errors.push(e); ask(); return; }
          const h = d.core(node).subscribeToMasternodeList((b) => {
            h.cancel();
            const decoded = decodeCbor(b);
            if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded instanceof Uint8Array) throw new Error('sml: not a map');
            if (!done) { done = true; resolve({ node, decoded: decoded as RawSml['decoded'] }); }
          }, { signal: ctrl.signal, idleTimeoutMs: 45_000, connectTimeoutMs: d.options.timeoutMs ?? 15000 });
          void h.closed.then((r) => {
            if (done) return;
            if (r.reason === 'error' && !isAbort(r.error)) { errors.push(r.error); d.pool.fail(node, r.error); }
            if (--pending === 0) ask();
          });
        };
        ask();
        setTimeout(() => { if (!done) ask(); }, 6000);
      });
    } catch (e) {
      if (o.signal?.aborted) throw abortReason(o.signal);
      errors.push(e);
    } finally {
      ctrl.abort();
      o.signal?.removeEventListener('abort', stop);
    }
  }
  throw new Error(`masternode list: ${(errors[errors.length - 1] as Error)?.message ?? 'no node answered'}`);
}

/** proveSml + the block it names is in the chain and its header's merkle root is the one the coinbase proof hashes to. */
async function proveAgainstChain(d: Dapi, chain: HeaderChain, raw: RawSml, hash: (h: Uint8Array) => Uint8Array, extendTo: (h: number) => Promise<void>, o: { signal?: AbortSignal }): Promise<ProvenSml> {
  const proof: SmlProof = proveSml(raw.decoded);
  await extendTo(proof.height);
  const want = chain.hashAt(proof.height);
  if (!want || hashHex(want) !== proof.blockHash) throw new VerificationError('sml', `the list's block ${proof.height} is not in the verified chain`);
  let header = chain.rawAt(proof.height);
  if (!header) {
    // a block below what this session downloaded (resumed from the cache): fetch its header, which must hash to the verified hash
    header = (await fetchHeaders(d, proof.height, proof.height, hash, o)).headers;
    if (!bytesEqual(hash(header), want)) throw new VerificationError('sml', `block ${proof.height} from the node is not the verified one`);
  }
  if (parseHeader(header).merkleRoot !== proof.blockMerkleRoot) throw new VerificationError('sml', "the list's coinbase is not in its block");
  const sml: Sml = parseSmlDecoded(raw.decoded);
  if (sml.height !== proof.height) throw new VerificationError('sml', 'list height and coinbase height differ');
  return { ...sml, proof, node: raw.node };
}

/** Base heights of the signing-type quorums, from the verified chain (they are multiples of the DKG interval), else the block's coinbase. */
async function quorumsWithHeights(d: Dapi, chain: HeaderChain, quorums: readonly SmlQuorum[], llmqType: number, dkg: number, o: { signal?: AbortSignal }): Promise<SmlQuorum[]> {
  return Promise.all(quorums.filter((q) => q.llmqType === llmqType).map(async (q) => {
    for (let h = chain.hi - (chain.hi % dkg); h >= chain.lo; h -= dkg) if (chain.hashHexAt(h) === q.quorumHash) return { ...q, baseHeight: h };
    return { ...q, baseHeight: await d.resolveBlockHeight(q.quorumHash, o) };
  }));
}

// ---- ChainLock ------------------------------------------------------------------------------------------------------------

/** The newest ChainLock a node has: a header stream opened at the tip sends it first. */
async function newestChainLock(d: Dapi, tip: number, o: { signal?: AbortSignal }): Promise<ChainLock> {
  const { value } = await d.call((core, signal) => new Promise<ChainLock>((resolve, reject) => {
    const h = core.subscribeToBlockHeadersWithChainLocks({ fromHeight: tip, count: 0 }, (ev) => {
      if (ev.type !== 'chainlock') return;
      h.cancel();
      resolve(parseChainLock(ev.chainLock));
    }, { signal, idleTimeoutMs: 20_000, connectTimeoutMs: d.options.timeoutMs ?? 15000 });
    void h.closed.then((r) => reject(r.reason === 'error' ? r.error : new GrpcError(14, 'no ChainLock received', { network: true })));
  }), { ...o, attempts: 3 });
  return value;
}
