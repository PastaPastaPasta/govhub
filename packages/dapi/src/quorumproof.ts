// Quorum proof chains (DIP 175) as the ChainLock trust root: types, the pinned checkpoints, and where proofs come from. The verifier
// itself is the WebAssembly module in './coreproof.ts' (entry '@govhub/dapi/coreproof'), loaded only when anchoring runs.
//
// A proof starts from a checkpoint state (a block's height, hash and the masternode and quorum roots its coinbase commits to) and
// follows ChainLocks: each one signed by a ChainLock quorum already trusted, on a block that mined the next ChainLock quorum, up to a
// ChainLock on a recent target block whose coinbase commits to new roots. Proof sources are untrusted: a proof authenticates itself
// from the checkpoint, so a source can withhold or delay, never forge. No proof of work is involved.
import type { Network } from './chainlock.ts';

/** A block's authenticated state (Core's `ProofState`; the JSON `getquorumproofchain` returns as `target`). Hashes in display order. */
export interface ProofState {
  network: Network;
  height: number;
  blockHash: string;
  masternodeRoot: string;
  quorumRoot: string;
}

export interface VerifiedQuorumProof {
  /** The authenticated target state. */
  state: ProofState;
  /** The target's ChainLock as the proof carried and verified it. */
  chainLock: { height: number; header: Uint8Array; signature: Uint8Array };
  /** ChainLock quorum handoffs between the start state and the target. */
  links: number;
  /** The trusted state the proof started from. */
  from: ProofState;
}

export type QuorumProofErrorKind = 'invalid' | 'stale' | 'untrusted-checkpoint';

export class QuorumProofError extends Error {
  readonly kind: QuorumProofErrorKind;
  constructor(kind: QuorumProofErrorKind, reason: string) {
    super(`quorum proof rejected: ${reason}`);
    this.name = 'QuorumProofError';
    this.kind = kind;
  }
}

/**
 * The pinned checkpoints, as in dashpay/platform PR #5523 (rs-sdk-trusted-context-provider/checkpoints/*.json). Each was re-read on
 * 2026-10-24 with `getblockhash` + `getblock <hash> 1` (cbTx.merkleRootMNList, cbTx.merkleRootQuorums) from two independent nodes per
 * network (the govhub CT 185 dashd and the CT 164 relay's Core build) and matched; packages/dapi/README.md "Quorum proof anchoring"
 * has the record. Trusting a checkpoint means trusting every ChainLock quorum committed under its quorum root, and every ChainLock
 * quorum mined later (or under 4,096 blocks before it): move it forward with releases.
 */
export const QUORUM_CHECKPOINTS: Record<Network, ProofState> = {
  mainnet: {
    network: 'mainnet',
    height: 2_550_000,
    blockHash: '000000000000000759db5eed70bf470171e7738b85765b395c1a75029c9683ce',
    masternodeRoot: '1d9ee9f97d3c393c1825c58cec162ffd66efe6a25f24bc4142f68c05b1df1750',
    quorumRoot: '1b790dc5600ccfe0f8167412e6b751de8cbac34bcab37ed5feebbb56c117b540',
  },
  testnet: {
    network: 'testnet',
    height: 1_560_000,
    blockHash: '00000215d91d5f3cdfda9de376171ce7eebfeb5adbabc012e8d59501ba07a35e',
    masternodeRoot: '335e0734bf2efdc117e639e0db433d230042a061b5b17da8462429cf3d11dd80',
    quorumRoot: 'd1a9305a96f477a0f86be90f2ee4af1085027d5305fd769f2c406dd353114a43',
  },
};

/** Largest proof accepted from a source (Core's MAX_PROOF_BYTES). */
export const MAX_PROOF_BYTES = 1024 * 1024;

export interface ProofRequest {
  /** Display-order hash of the trusted state the proof must start from. */
  checkpoint: string;
  /** Minimum target height (0: the newest ChainLock the source has). */
  height: number;
  /** For sources that only serve bootstrap envelopes (the quorum list server): a Platform quorum to open. Untrusted hint. */
  platformQuorum?: () => Promise<{ quorumHash: string; llmqType: number } | null>;
  signal?: AbortSignal;
}

export interface ProofSource {
  readonly name: string;
  /** The raw proof bytes (a `DASHNC02` chain or a bootstrap envelope). */
  fetch(r: ProofRequest): Promise<Uint8Array>;
}

/**
 * A source failed to deliver (it never makes a proof valid or invalid). `code` is the bridge's error code when it sent one:
 * `unsupported` (its dashd has no `getquorumproofchain`), `not-yet` (no ChainLock at the requested minimum yet), ...
 */
export class ProofSourceError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'ProofSourceError';
    this.status = status;
    this.code = code;
  }
}

interface SourceOptions {
  fetch?: typeof fetch;
  /** Per request. Default 60 s (a cold proof from an old checkpoint can take a while on testnet). */
  timeoutMs?: number;
}

async function readProof(name: string, res: Response): Promise<Uint8Array> {
  if (!res.ok) {
    let code: string | undefined, message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof j.error === 'string') code = j.error;
      if (typeof j.message === 'string') message += `: ${j.message.slice(0, 200)}`;
    } catch { /* not JSON (a CDN page, the quorum list server's bare status) */ }
    throw new ProofSourceError(`${name}: ${message}`, res.status, code);
  }
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (len > MAX_PROOF_BYTES) throw new ProofSourceError(`${name}: proof of ${len} bytes is over the limit`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length === 0 || body.length > MAX_PROOF_BYTES) throw new ProofSourceError(`${name}: proof of ${body.length} bytes`);
  return body;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ProofSourceError(`no proof within ${Math.round(ms / 1000)} s`)), ms);
  const onAbort = () => ctrl.abort(signal!.reason);
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

const HASH = /^[0-9a-f]{64}$/;

/** A govhub bridge's `GET /v1/quorum-proof` (services/bridge): the bare `DASHNC02` chain, proxied from its dashd. */
export function bridgeProofSource(base: string, o: SourceOptions = {}): ProofSource {
  const root = base.replace(/\/+$/, '');
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    name: root.replace(/^[a-z]+:\/\//i, ''),
    async fetch(r) {
      if (!HASH.test(r.checkpoint)) throw new Error('checkpoint must be a display-order block hash');
      const t = withTimeout(r.signal, o.timeoutMs ?? 60_000);
      try {
        const q = new URLSearchParams({ checkpoint: r.checkpoint, height: String(r.height) });
        const res = await f(`${root}/v1/quorum-proof?${q}`, { signal: t.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        return await readProof(this.name, res);
      } finally {
        t.done();
      }
    },
  };
}

/**
 * The quorum list server's `POST /proofs` (dashpay/quorum-list-server #15). It only serves bootstrap envelopes that open one Platform
 * quorum, so it needs a quorum hash to ask for (any active Platform quorum: the record is checked but not used here).
 */
export function quorumListProofSource(url: string, o: SourceOptions = {}): ProofSource {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    name: url.replace(/^[a-z]+:\/\//i, ''),
    async fetch(r) {
      const q = await r.platformQuorum?.();
      if (!q) throw new ProofSourceError(`${this.name}: no Platform quorum to request`);
      const t = withTimeout(r.signal, o.timeoutMs ?? 60_000);
      try {
        const res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ checkpoint: r.checkpoint, height: r.height, quorumHash: q.quorumHash, llmqType: q.llmqType, nodeCount: 0 }),
          signal: t.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        return await readProof(this.name, res);
      } finally {
        t.done();
      }
    },
  };
}
