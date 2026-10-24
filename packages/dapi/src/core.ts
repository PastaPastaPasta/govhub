// DAPI Core service over grpc-web: only what govhub needs. Request/response layouts follow
// @dashevo/dapi-grpc protos/core/v0/core.proto (field numbers in comments).
import { hex, hashHex } from './bytes.ts';
import { type PbField, allBytes, bytes, decode, encode, num, text } from './pb.ts';
import { type StreamHandle, type StreamOptions, type UnaryOptions, stream, unary } from './grpcweb.ts';
import type { BloomFilterData } from './bloom.ts';

const SERVICE = 'org.dash.platform.dapi.v0.Core';

export interface BlockchainStatus {
  version: { protocol: number; software: number; agent: string };
  time: { now: number; median: number };
  status: 'NOT_STARTED' | 'SYNCING' | 'READY' | 'ERROR' | undefined;
  syncProgress: number;
  chain: {
    name: string; headersCount: number; blocksCount: number;
    /** Display-order hex (the node sends internal order; converted here). */
    bestBlockHash: string; isSynced: boolean;
  };
}

/** What a node claims about a transaction. None of it is verified here; see Dapi.getVerifiedTransaction. */
export interface TransactionClaims {
  raw: Uint8Array;
  /** Display-order hex (empty for mempool transactions). */
  blockHash: string;
  height: number;
  confirmations: number;
  isInstantLocked: boolean;
  isChainLocked: boolean;
}

export type HeadersEvent = { type: 'headers'; headers: Uint8Array[] } | { type: 'chainlock'; chainLock: Uint8Array };
export type TxStreamEvent =
  | { type: 'rawtxs'; txs: Uint8Array[] }
  | { type: 'islocks'; messages: Uint8Array[] }
  | { type: 'merkleblock'; merkleBlock: Uint8Array };

export interface StreamStart {
  /** Start height (inclusive). Prefer this over `fromHash`. */
  fromHeight?: number;
  /** Start block hash in the byte order the node expects (untested against live nodes: use fromHeight). */
  fromHash?: Uint8Array;
  /** 0 = historical replay then live updates forever; N > 0 = stop after N historical blocks. */
  count?: number;
}

type StreamOpts = Omit<StreamOptions, 'onMessage'>;

export class DapiCore {
  readonly node: string;
  readonly base: string;
  readonly timeoutMs: number;

  /** @param node "host:port" of an evonode's platform_https endpoint */
  constructor(node: string, { timeoutMs = 15000 }: { timeoutMs?: number } = {}) {
    this.node = node;
    this.base = `https://${node}/${SERVICE}/`;
    this.timeoutMs = timeoutMs;
  }

  #call(method: string, fields: readonly PbField[], opts?: UnaryOptions): Promise<Uint8Array> {
    return unary(this.base, method, encode(fields), { timeoutMs: this.timeoutMs, ...opts });
  }

  async getBlockchainStatus(opts?: UnaryOptions): Promise<BlockchainStatus> {
    const m = decode(await this.#call('getBlockchainStatus', [], opts));
    const chain = decode(bytes(m, 5)), ver = decode(bytes(m, 1)), time = decode(bytes(m, 2));
    return {
      version: { protocol: num(ver, 1), software: num(ver, 2), agent: text(bytes(ver, 3)) },
      time: { now: num(time, 1), median: num(time, 3) },
      status: (['NOT_STARTED', 'SYNCING', 'READY', 'ERROR'] as const)[num(m, 3)],
      syncProgress: num(m, 4),
      chain: {
        name: text(bytes(chain, 1)), headersCount: num(chain, 2), blocksCount: num(chain, 3),
        bestBlockHash: hashHex(bytes(chain, 4)), isSynced: !!num(chain, 7),
      },
    };
  }

  async getBestBlockHeight(opts?: UnaryOptions): Promise<number> { return num(decode(await this.#call('getBestBlockHeight', [], opts)), 1); }

  /** Raw block by height or display-order hash. */
  async getBlock(q: { height: number } | { hash: string }, opts?: UnaryOptions): Promise<Uint8Array> {
    const field: PbField = 'hash' in q ? [2, q.hash, true] : [1, q.height, true]; // oneof: hash is a string, height a uint32
    return bytes(decode(await this.#call('getBlock', [field], opts)), 1);
  }

  /** @param txid display-order hex */
  async getTransaction(txid: string, opts?: UnaryOptions): Promise<TransactionClaims> {
    const m = decode(await this.#call('getTransaction', [[1, txid]], opts));
    return {
      raw: bytes(m, 1), blockHash: hex(bytes(m, 2)), height: num(m, 3), confirmations: num(m, 4),
      isInstantLocked: !!num(m, 5), isChainLocked: !!num(m, 6),
    };
  }

  /** Submit a raw transaction. Resolves with the txid the node reports (display order). */
  async broadcastTransaction(raw: Uint8Array, { allowHighFees = false, bypassLimits = false }: { allowHighFees?: boolean; bypassLimits?: boolean } = {}, opts?: UnaryOptions): Promise<string> {
    const m = decode(await this.#call('broadcastTransaction', [[1, raw], [2, allowHighFees], [3, bypassLimits]], opts));
    return text(bytes(m, 1));
  }

  /** Header + ChainLock stream (BlockHeadersWithChainLocksRequest: 1 hash | 2 height, 3 count). */
  subscribeToBlockHeadersWithChainLocks({ fromHeight, fromHash, count = 0 }: StreamStart, onEvent: (e: HeadersEvent) => void, opts?: StreamOpts): StreamHandle {
    const req = encode([fromHash ? [1, fromHash, true] : [2, fromHeight, true], [3, count]]);
    return stream(this.base, 'subscribeToBlockHeadersWithChainLocks', req, {
      connectTimeoutMs: this.timeoutMs, ...opts,
      onMessage: (b) => {
        const m = decode(b);
        if (m.has(1)) onEvent({ type: 'headers', headers: allBytes(decode(bytes(m, 1)), 1) });
        else if (m.has(2)) onEvent({ type: 'chainlock', chainLock: bytes(m, 2) });
      },
    });
  }

  /**
   * TransactionsWithProofsRequest: 1 bloom_filter{1 v_data, 2 n_hash_funcs, 3 n_tweak, 4 n_flags} | 2 hash | 3 height | 4 count | 5 send_transaction_hashes.
   * `filter.vData` must be >= 200 bytes. IS-lock messages are only sent live: they are never replayed.
   */
  subscribeToTransactionsWithProofs(filter: BloomFilterData, { fromHeight, fromHash, count = 0 }: StreamStart, onEvent: (e: TxStreamEvent) => void, opts?: StreamOpts): StreamHandle {
    const bf = encode([[1, filter.vData], [2, filter.nHashFuncs], [3, filter.nTweak], [4, filter.nFlags]]);
    const req = encode([[1, bf], fromHash ? [2, fromHash, true] : [3, fromHeight, true], [4, count]]);
    return stream(this.base, 'subscribeToTransactionsWithProofs', req, {
      connectTimeoutMs: this.timeoutMs, ...opts,
      onMessage: (b) => {
        const m = decode(b);
        if (m.has(1)) onEvent({ type: 'rawtxs', txs: allBytes(decode(bytes(m, 1)), 1) });
        else if (m.has(2)) onEvent({ type: 'islocks', messages: allBytes(decode(bytes(m, 2)), 1) });
        else if (m.has(3)) onEvent({ type: 'merkleblock', merkleBlock: bytes(m, 3) });
      },
    });
  }

  /** The first message is the full SML (CBOR diff from the zero base block); later ones are incremental diffs. */
  subscribeToMasternodeList(onDiff: (cbor: Uint8Array) => void, opts?: StreamOpts): StreamHandle {
    return stream(this.base, 'subscribeToMasternodeList', encode([]), { connectTimeoutMs: this.timeoutMs, ...opts, onMessage: (b) => onDiff(bytes(decode(b), 1)) });
  }
}
