// The issuer's view of Core, from its own dashd over JSON-RPC (PLAN §8.4 rules 2-3): the tip height and a masternode's state at a
// height (`protx info <proTxHash> <blockHash>`). Read-only RPCs only: getblockcount, getblockhash, protx info.
import { decodeAddress, type Network } from '@govhub/verify';
import { log } from './log.ts';

export interface MnState {
  /** collateral outpoint "txid:index" (display order txid) */
  collateral: string;
  /** hash160 of the voting key (keyIDVoting) */
  votingKeyId: Uint8Array;
  /** in the list and not PoSe-banned */
  valid: boolean;
}

export interface CoreView {
  tipHeight(): Promise<number>;
  /** The MN's state at `height` ('tip' = now), or null when it is not in the list at that height. */
  mnAt(proTxHashHex: string, height: number | 'tip'): Promise<MnState | null>;
}

export class CoreRpcError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.code = code;
    this.name = 'CoreRpcError';
  }
}

export interface RpcOptions {
  url: string;
  user: string;
  password: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function createRpc(o: RpcOptions) {
  const auth = 'Basic ' + Buffer.from(`${o.user}:${o.password}`).toString('base64');
  const f = o.fetch ?? fetch;
  let id = 1;
  return async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await f(o.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ jsonrpc: '1.0', id: id++, method, params }),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`${method}: Core RPC authentication failed`);
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } | null } | null;
    if (!body) throw new Error(`${method}: HTTP ${res.status} without a JSON-RPC body`);
    if (body.error) throw new CoreRpcError(method, body.error.code, body.error.message);
    return body.result as T;
  };
}

interface ProTxInfo {
  collateralHash: string;
  collateralIndex: number;
  state: { PoSeBanHeight: number; votingAddress: string };
}

/** RPC_INVALID_PARAMETER (-8) / RPC_INVALID_ADDRESS_OR_KEY (-5): "not found" for protx info. */
const NOT_FOUND = new Set([-8, -5]);

export function createCoreView(call: ReturnType<typeof createRpc>, network: Network): CoreView {
  return {
    tipHeight: () => call<number>('getblockcount'),
    async mnAt(proTxHashHex, height) {
      if (!/^[0-9a-f]{64}$/.test(proTxHashHex)) return null;
      const params: unknown[] = [proTxHashHex];
      if (height !== 'tip') params.push(await call<string>('getblockhash', [height]));
      let info: ProTxInfo;
      try {
        info = await call<ProTxInfo>('protx', ['info', ...params]);
      } catch (e) {
        if (e instanceof CoreRpcError && NOT_FOUND.has(e.code)) return null;
        throw e;
      }
      const dest = decodeAddress(info.state.votingAddress, network);
      if (!dest || dest.type !== 'p2pkh') {
        log.warn('protx info returned an unexpected voting address');
        return null;
      }
      return { collateral: `${info.collateralHash}:${info.collateralIndex}`, votingKeyId: dest.hash160, valid: info.state.PoSeBanHeight === -1 };
    },
  };
}
