// DAPI Core service over grpc-web: only what govhub needs. Request/response layouts from
// @dashevo/dapi-grpc protos/core/v0/core.proto (field numbers in comments).
import { encode, decode, first, all, str } from './pb.js';
import { unary, stream } from './grpcweb.js';
import { hex, hashHex } from './dash.js';

const SERVICE = 'org.dash.platform.dapi.v0.Core';
// `fromHash` must be a Uint8Array in the byte order the node expects (the proto field is `bytes`); prefer fromHeight.
const fromTo = (p, hashField, heightField) => (p.fromHash ? [hashField, p.fromHash, true] : [heightField, p.fromHeight, true]);

export class DapiCore {
  /** @param {string} node "host:port" of an evonode's platform_https endpoint */
  constructor(node, { timeoutMs = 15000 } = {}) {
    this.node = node;
    this.base = `https://${node}/${SERVICE}/`;
    this.timeoutMs = timeoutMs;
  }
  #call(method, fields, opts) { return unary(this.base, method, encode(fields), { timeoutMs: this.timeoutMs, ...opts }); }

  async getBlockchainStatus(opts) {
    const m = decode(await this.#call('getBlockchainStatus', [], opts));
    const chain = decode(first(m, 5, new Uint8Array(0)));
    const ver = decode(first(m, 1, new Uint8Array(0)));
    const time = decode(first(m, 2, new Uint8Array(0)));
    return {
      version: { protocol: first(ver, 1, 0), software: first(ver, 2, 0), agent: str(first(ver, 3)) },
      time: { now: first(time, 1, 0), median: first(time, 3, 0) },
      status: ['NOT_STARTED', 'SYNCING', 'READY', 'ERROR'][first(m, 3, 0)],
      syncProgress: first(m, 4, 0),
      chain: {
        name: str(first(chain, 1)), headersCount: first(chain, 2, 0), blocksCount: first(chain, 3, 0),
        bestBlockHash: hashHex(first(chain, 4, new Uint8Array(0))), isSynced: !!first(chain, 7, 0),
      },
    };
  }

  async getBestBlockHeight(opts) { return first(decode(await this.#call('getBestBlockHeight', [], opts)), 1, 0); }

  /** @param {{height:number}|{hash:string}} q  @returns {Promise<Uint8Array>} raw block */
  async getBlock(q, opts) {
    const m = decode(await this.#call('getBlock', [q.hash ? [2, q.hash, true] : [1, q.height, true]], opts));
    return first(m, 1);
  }

  /** @param {string} txid display-order hex */
  async getTransaction(txid, opts) {
    const m = decode(await this.#call('getTransaction', [[1, txid]], opts));
    return {
      raw: first(m, 1), blockHash: hex(first(m, 2, new Uint8Array(0))), height: first(m, 3, 0),
      confirmations: first(m, 4, 0), isInstantLocked: !!first(m, 5, 0), isChainLocked: !!first(m, 6, 0),
    };
  }

  /** Header + ChainLock stream. ev: {type:'headers', headers:Uint8Array[]} | {type:'chainlock', chainLock:Uint8Array} */
  subscribeToBlockHeadersWithChainLocks({ fromHeight, fromHash, count = 0 }, onEvent, opts) {
    const req = encode([fromTo({ fromHeight, fromHash }, 1, 2), [3, count]]);
    return stream(this.base, 'subscribeToBlockHeadersWithChainLocks', req, {
      connectTimeoutMs: this.timeoutMs, ...opts,
      onMessage: (b) => {
        const m = decode(b);
        if (m.has(1)) onEvent({ type: 'headers', headers: all(decode(first(m, 1)), 1) });
        else if (m.has(2)) onEvent({ type: 'chainlock', chainLock: first(m, 2) });
      },
    });
  }

  /** filter: {vData, nHashFuncs, nTweak, nFlags} (see bloom.js; vData must be >= 200 bytes).
   *  ev: {type:'rawtxs', txs}|{type:'islocks', messages}|{type:'merkleblock', merkleBlock} */
  subscribeToTransactionsWithProofs(filter, { fromHeight, fromHash, count = 0, sendTransactionHashes = false }, onEvent, opts) {
    const bf = encode([[1, filter.vData], [2, filter.nHashFuncs], [3, filter.nTweak], [4, filter.nFlags]]);
    const req = encode([[1, bf], fromTo({ fromHeight, fromHash }, 2, 3), [4, count], [5, sendTransactionHashes]]);
    return stream(this.base, 'subscribeToTransactionsWithProofs', req, {
      connectTimeoutMs: this.timeoutMs, ...opts,
      onMessage: (b) => {
        const m = decode(b);
        if (m.has(1)) onEvent({ type: 'rawtxs', txs: all(decode(first(m, 1)), 1) });
        else if (m.has(2)) onEvent({ type: 'islocks', messages: all(decode(first(m, 2)), 1) });
        else if (m.has(3)) onEvent({ type: 'merkleblock', merkleBlock: first(m, 3) });
      },
    });
  }

  /** First message is the full SML (CBOR-encoded diff from genesis); later ones are incremental diffs. */
  subscribeToMasternodeList(onDiff, opts) {
    return stream(this.base, 'subscribeToMasternodeList', encode([]), { connectTimeoutMs: this.timeoutMs, ...opts, onMessage: (b) => onDiff(first(decode(b), 1)) });
  }
}
