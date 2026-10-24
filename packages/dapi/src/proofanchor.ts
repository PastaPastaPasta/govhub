// Chain anchoring on ChainLocks (loaded with anchor.ts): no proof of work anywhere, so it is as sound on testnet as on mainnet.
//
//   pinned quorum checkpoint (height H, its coinbase's quorum root)
//     -> DIP 175 proof chain from an untrusted source: ChainLocks, each BLS-signed by a ChainLock quorum already trusted, on blocks
//        that mined the next ones, up to a ChainLock on a recent block T (verified in WebAssembly by Core-parity Rust)
//     -> headers from T down (X11 hash linkage only) to the masternode list's block S <= T and to any older block of interest
//     -> the masternode list proven against the coinbase of S (merkleRootMNList, merkleRootQuorums)
//     -> T's ChainLock signature checked for consistency with Core's quorum selection over that proven list.
//
// The last verified state is kept (proofStore) so the next proof starts there and is a few hundred bytes; when no source has a newer
// ChainLock yet, that saved ChainLock itself serves while it is fresh. When no source can give a valid, fresh proof (none configured,
// dashd older than v24, HTTP 403...), the caller falls back to the proof-of-work path.
import { bytesEqual, hashBytes } from './bytes.ts';
import { CHAINLOCK_PARAMS, type Network, SIGN_HEIGHT_OFFSET } from './chainlock.ts';
import type { Dapi } from './client.ts';
import { type ChainLock, parseHeader } from './dash.ts';
import { VerificationError } from './errors.ts';
import { LinkedChain, type StoredLinkedChain } from './linkedchain.ts';
import { type PlatformQuorum, type ProofSource, ProofSourceError, type ProofState, QUORUM_CHECKPOINTS, type VerifiedQuorumProof } from './quorumproof.ts';
import { parseSmlDecoded } from './sml.ts';
import { proveSml } from './smlproof.ts';
import type { AnchorOptions, AnchoredChain, Verifiers } from './types.ts';
import { FRESH_S, MAX_STORED, type RawSml, applyRun, fetchHeaders, fetchSml, now, proveAgainstChain, quorumsWithHeights } from './anchor.ts';

/**
 * A proven ChainLock on another block than one this browser verified earlier at that height: a ChainLock quorum signed two blocks.
 * Not a reason to fall back to proof of work: anchoring fails closed.
 */
export class ChainLockConflictError extends VerificationError {
  constructor(message: string) {
    super('chainlock-conflict', message);
    this.name = 'ChainLockConflictError';
  }
}

/** The proof path could not be completed; the caller falls back to proof of work and reports `message`. */
export class ProofUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofUnavailableError';
  }
}

/** Platform quorum types the quorum list server opens (it serves bootstrap envelopes only): LLMQ_100_67, LLMQ_25_67. */
const PLATFORM_LLMQ: Record<Network, number> = { mainnet: 4, testnet: 6 };
/** A source that cannot serve proofs at all (old dashd, forbidden, no such route, too slow) is skipped for this long. */
const SOURCE_DOWN_MS = 10 * 60_000;
/** The list may be a few blocks newer than the newest ChainLock a source has: ask again for one at its height, this often. */
const CATCH_UP_TRIES = 4;
const CATCH_UP_MS = 2500;
/** What `trust.source` says when the ChainLock is the one this browser proved earlier (no source had a newer one). */
export const SAVED_SOURCE = 'this browser (proved earlier)';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** A verified ChainLock to anchor on, and where it came from (no source: the one this browser saved). */
interface Got { proof: VerifiedQuorumProof; source: ProofSource | null; bytes: number; time: number }

interface ProofContext {
  verify: NonNullable<Verifiers['verifyQuorumProof']>;
  hash: (h: Uint8Array) => Uint8Array;
  platformQuorum: () => Promise<PlatformQuorum | null>;
  down: Map<string, number>;
  clock: () => number;
  signal: AbortSignal | undefined;
}

/** A source answered in a way that says it serves no proofs at all (not just none for this request). */
const cannotServe = (e: unknown): boolean =>
  e instanceof TypeError || // network or CORS failure
  (e instanceof ProofSourceError && (e.code === 'timeout' || e.code === 'unsupported' || e.status === 403 || e.status === 405 || e.status === 501 || (e.status === 404 && e.code !== 'checkpoint-unknown')));

/**
 * The first valid, fresh proof from `sources` (in order) starting at `from`. A proof that fails verification, or ends at a ChainLock
 * older than FRESH_S, is a failure of that source, which is then passed over; one that cannot serve proofs at all is skipped for a while.
 */
async function fetchProof(sources: readonly ProofSource[], from: ProofState, minHeight: number, ctx: ProofContext): Promise<Got> {
  const reasons: string[] = [];
  for (const source of sources) {
    if ((ctx.down.get(source.name) ?? 0) > Date.now()) {
      reasons.push(`${source.name}: skipped (failed recently)`);
      continue;
    }
    try {
      const bytes = await source.fetch({ checkpoint: from.blockHash, height: minHeight, platformQuorum: ctx.platformQuorum, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const proof = ctx.verify(bytes, from, minHeight);
      // the verifier checked this header's hash (it is what the ChainLock signs); hashing it again here costs one X11
      if (proof.chainLock.height !== proof.state.height || !bytesEqual(ctx.hash(proof.chainLock.header), hashBytes(proof.state.blockHash))) {
        throw new VerificationError('quorum-proof', 'the verified target and its ChainLock differ');
      }
      const time = parseHeader(proof.chainLock.header).time;
      if (time < ctx.clock() - FRESH_S) {
        reasons.push(`${source.name}: its newest ChainLock (block ${proof.state.height}) is ${Math.round((ctx.clock() - time) / 60)} minutes old`);
        continue;
      }
      return { proof, source, bytes: bytes.length, time };
    } catch (e) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      reasons.push(`${source.name}: ${(e as Error).message}`);
      if (cannotServe(e)) ctx.down.set(source.name, Date.now() + SOURCE_DOWN_MS);
    }
  }
  throw new ProofUnavailableError(reasons.join('; ') || 'no quorum proof source');
}

/** The ChainLock this browser proved and saved, while it is fresh: what to anchor on when no source has a newer one yet. */
function savedChainLock(stored: StoredLinkedChain, ctx: ProofContext): Got | null {
  const { header, signature } = stored.chainLock;
  if (!(header instanceof Uint8Array) || !(signature instanceof Uint8Array) || header.length !== 80 || signature.length !== 96) return null;
  if (!bytesEqual(ctx.hash(header), hashBytes(stored.state.blockHash))) return null;
  const time = parseHeader(header).time;
  if (time < ctx.clock() - FRESH_S) return null;
  return { proof: { state: stored.state, chainLock: { height: stored.state.height, header, signature }, links: 0, from: stored.state }, source: null, bytes: 0, time };
}

/** The median Platform quorum of the (unproven) list: only a hint for the quorum list server, which must open some quorum. */
function platformQuorumOf(network: Network, smlP: Promise<RawSml>): () => Promise<PlatformQuorum | null> {
  let memo: Promise<PlatformQuorum | null> | undefined;
  return () => (memo ??= smlP.then((raw) => {
    const type = PLATFORM_LLMQ[network];
    const qs = parseSmlDecoded(raw.decoded).quorums.filter((q) => q.llmqType === type).map((q) => q.quorumHash).sort();
    return qs.length ? { quorumHash: qs[qs.length >> 1]!, llmqType: type } : null;
  }));
}

export interface ProofAnchorState {
  /** Sources that cannot serve proofs, until when (ms epoch). */
  down: Map<string, number>;
}

/**
 * The verified chain anchored on a proof-verified ChainLock. Throws ProofUnavailableError when no fresh valid proof could be had, and
 * VerificationError when nodes contradict a proof; the caller falls back to proof of work in either case.
 */
export async function anchorByProof(
  d: Dapi, st: ProofAnchorState, o: AnchorOptions, v: Verifiers, hash: (h: Uint8Array) => Uint8Array, smlP: Promise<RawSml>, smlSignal: AbortSignal,
): Promise<AnchoredChain> {
  const t0 = Date.now(), ms: Record<string, number> = {};
  const lap = (k: string, t: number) => { ms[k] = (ms[k] ?? 0) + Date.now() - t; };
  const sources = o.proofSources ?? [];
  if (!sources.length) throw new ProofUnavailableError('no quorum proof source is configured');
  if (!v.verifyQuorumProof) throw new ProofUnavailableError('the quorum proof verifier is not loaded');
  if (!v.verifyChainLock) throw new Error('anchoring needs verifiers.verifyChainLock from @govhub/dapi/bls');
  const root = o.quorumCheckpoint ?? QUORUM_CHECKPOINTS[d.network];
  if (root.network !== d.network) throw new Error(`the quorum checkpoint is for ${root.network}, not ${d.network}`);
  const rootRef = { height: root.height, blockHash: root.blockHash };
  const clock = o.now ?? now;
  const progress = o.onProgress ?? (() => {});
  const p = CHAINLOCK_PARAMS[d.network];
  const ctx: ProofContext = { verify: v.verifyQuorumProof, hash, platformQuorum: platformQuorumOf(d.network, smlP), down: st.down, clock, signal: o.signal };

  // 1. what this browser already verified: hashes down from an earlier proven ChainLock, and that block's state
  let t = Date.now();
  const loaded = (await o.proofStore?.load(d.network).catch(() => null)) ?? null;
  let chain: LinkedChain | null = null;
  try {
    chain = loaded ? LinkedChain.fromStored(loaded, rootRef, d.network) : null;
  } catch { /* a damaged entry: start over from the pin (and overwrite it) */ }
  const stored = chain && loaded!.state.height > root.height ? loaded! : null;
  if (!stored) chain = null;
  const cached = chain ? chain.hi - chain.lo + 1 : 0;
  lap('cache', t);

  // 2. a proof (the masternode list downloads beside it): from the saved state when a source can bridge from it; failing that the
  //    saved ChainLock itself while it is fresh (no newer one exists yet); else from the pin
  t = Date.now();
  progress('Fetching a ChainLock proof from the quorum checkpoint');
  const reasons: string[] = [];
  // a failed fetch is no proof (null, with its reason noted when asked), unless the caller gave up
  const orNull = (p: Promise<Got>, failures?: string[]) => p.catch((e: unknown) => {
    if (o.signal?.aborted) throw e;
    failures?.push((e as Error).message);
    return null;
  });
  const attempt = (from: ProofState) => orNull(fetchProof(sources, from, 0, ctx), reasons);
  const first = (stored ? ((await attempt(stored.state)) ?? savedChainLock(stored, ctx)) : null) ?? (await attempt(root));
  if (!first) throw new ProofUnavailableError(reasons.join('; '));
  let got: Got = first;
  lap('proof', t);

  // 3. the list must be from a block S at or below the proven ChainLock T (reached by linkage) and at most 8 below it: when it is
  //    newer, ask for a ChainLock at its height; when older (a lagging node), take another node's list once
  t = Date.now();
  let raw = await smlP;
  let smlProof = proveSml(raw.decoded);
  ms.smlProof = Date.now() - t;
  for (let tries = 0, refetched = false; ;) {
    if (got.proof.state.height < smlProof.height) {
      const asked = got.source ? [got.source] : sources;
      if (tries >= CATCH_UP_TRIES || asked.every((s) => (st.down.get(s.name) ?? 0) > Date.now())) {
        throw new ProofUnavailableError(`no source has a ChainLock at the masternode list's block ${smlProof.height} yet`);
      }
      progress(`Waiting for a ChainLock on block ${smlProof.height.toLocaleString('en-US')}`);
      await sleep(CATCH_UP_MS * ++tries, o.signal);
      // from where the ChainLock came; the saved one (no source) may be a block a source's node cannot bridge from: then the pin
      const next = (await orNull(fetchProof(asked, got.proof.from, smlProof.height, ctx))) ?? (got.source ? null : await orNull(fetchProof(sources, root, smlProof.height, ctx)));
      if (next) got = next;
    } else if (smlProof.height < got.proof.state.height - SIGN_HEIGHT_OFFSET) {
      if (refetched) throw new VerificationError('stale', `the masternode list is from block ${smlProof.height}, more than ${SIGN_HEIGHT_OFFSET} blocks below the ChainLock (${got.proof.state.height})`);
      refetched = true;
      raw = await fetchSml(d, { signal: smlSignal }, [raw.node]);
      smlProof = proveSml(raw.decoded);
    } else break;
  }
  lap('sml', t);
  const target = got.proof.state, top = { height: target.height, hash: hashBytes(target.blockHash) };

  // 4. headers: from the proven block down to the list's block, the quorum base blocks the ChainLock selection reads, and `from`
  t = Date.now();
  const maxStored = o.maxStoredHeights ?? MAX_STORED;
  if (o.from !== undefined && o.from < top.height - maxStored) throw new Error(`block ${o.from} is more than ${maxStored.toLocaleString('en-US')} blocks deep: too old to verify here`);
  const reach = p.activeCount * p.dkgInterval + p.miningWindowEnd + SIGN_HEIGHT_OFFSET;
  const want = Math.max(1, top.height - maxStored + 1, Math.min(o.from ?? Infinity, smlProof.height, top.height - reach));
  let fetched = 0;
  const fetchRun = async (from: number, to: number) => {
    progress(`Downloading ${(to - from + 1).toLocaleString('en-US')} block headers`);
    const r = await fetchHeaders(d, from, to, hash, o);
    fetched += to - from + 1;
    return r;
  };
  // A ChainLock at or below the saved top (a source serving an older, still fresh one) must be the block this browser verified at
  // that height: two verified ChainLocks on different blocks mean a quorum signed dishonestly. Refuse, and keep what is stored.
  if (chain && top.height <= chain.hi && top.height >= chain.lo && chain.hashHexAt(top.height) !== target.blockHash) {
    throw new ChainLockConflictError(`the proven ChainLock on block ${top.height} conflicts with the one this browser verified earlier`);
  }
  const keepStored = !!chain && top.height < chain.lo; // cannot be compared with what is stored: anchor afresh, store nothing over it
  if (keepStored) chain = null;
  if (!chain) {
    chain = await applyRun(d, await fetchRun(want, top.height), hash, (r) => LinkedChain.fromTop(d.network, r, top), o);
  } else {
    const c = chain;
    const [down, up] = await Promise.all([
      want < c.lo ? fetchRun(want, c.lo - 1) : null,
      top.height > c.hi ? fetchRun(c.hi + 1, top.height) : null,
    ]);
    if (up) await applyRun(d, up, hash, (r) => c.extendUpTo(r, top), o);
    if (down) await applyRun(d, down, hash, (r) => c.extendDown(r), o);
  }
  const linked = chain;
  lap('headers', t);

  // 5. the list, proven against the coinbase of its block in that chain
  t = Date.now();
  progress('Proving the masternode list against the ChainLocked chain');
  const above = async (h: number) => { if (h > linked.hi) throw new VerificationError('sml', `block ${h} is above the proven ChainLock (${linked.hi})`); };
  const sml = await proveAgainstChain(d, linked, raw, hash, above, o, ms, smlProof);
  lap('sml', t);

  // 6. T's ChainLock against Core's quorum selection over the proven list. The list is itself proven through T, so this is a
  //    consistency check of the selection, not a second root of trust. Every base block should be in the linked run; one a node had
  //    to name only orders proven quorums, and makes the result inexact.
  t = Date.now();
  const cl: ChainLock = { height: top.height, blockHash: target.blockHash, blockHashInternal: top.hash, signature: got.proof.chainLock.signature };
  let named = false;
  const resolve = (blockHash: string, ro: { signal?: AbortSignal }) => { named = true; return d.resolveBlockHeight(blockHash, ro); };
  const quorums = await quorumsWithHeights(d, linked, sml.quorums, p.llmqType, p.dkgInterval, o, resolve);
  const check = v.verifyChainLock(cl, quorums, { network: d.network, smlHeight: sml.proof.height });
  if (!check.ok) throw new VerificationError('chainlock', `ChainLock on block ${top.height} not accepted by the proven list's quorums (${check.reason})`);
  lap('chainlock', t);

  // 7. persist the run and the state the next proof can start from (never a lower state over a higher one)
  const out: AnchoredChain = {
    network: d.network,
    checkpoint: { height: root.height, hash: root.blockHash },
    trust: {
      kind: 'quorum-proof',
      checkpoint: { height: root.height, hash: root.blockHash },
      from: { height: got.proof.from.height, hash: got.proof.from.blockHash },
      source: got.source?.name ?? SAVED_SOURCE,
      links: got.proof.links,
      proofBytes: got.bytes,
    },
    chain: linked, tip: linked.hi, weak: null,
    chainLock: { height: top.height, blockHash: target.blockHash, quorumHash: check.quorumHash, exact: check.exact && !named, time: got.time },
    sml, at: Date.now(),
    stats: { cachedHeaders: cached, fetchedHeaders: fetched, ms: { ...ms, total: Date.now() - t0 } },
  };
  if (!keepStored && o.proofStore) {
    // the run ends at the proven ChainLock, or (a source served an older one) still at the saved one, whose state and lock go with it
    const atProven = linked.hi === top.height;
    const state = atProven ? target : stored!.state;
    const { header, signature } = atProven ? got.proof.chainLock : stored!.chainLock;
    if (header && signature) await o.proofStore.save(linked.toStored(rootRef, state, { header, signature }, maxStored)).catch(() => {});
  }
  return out;
}
