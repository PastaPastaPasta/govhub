// The issuer's view of Core, from its own dashd over JSON-RPC (PLAN §8.4 rules 2-3): the tip height and the masternode list at a
// height (`protx list registered true [height]`). Read-only RPCs only: getblockcount, getblockchaininfo, protx list.
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
  /** Out of initial block download (a syncing node's tip and lists are not the network's). */
  synced(): Promise<boolean>;
  /** Every registered MN at `height` ('tip' = now), keyed by display-order proTxHash. */
  mnList(height: number | 'tip'): Promise<Map<string, MnState>>;
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

interface ProTxEntry {
  proTxHash: string;
  collateralHash: string;
  collateralIndex: number;
  state: { PoSeBanHeight: number; votingAddress: string };
}

export function createCoreView(call: ReturnType<typeof createRpc>, network: Network): CoreView {
  return {
    tipHeight: () => call<number>('getblockcount'),
    async synced() {
      const i = await call<{ initialblockdownload: boolean; blocks: number; headers: number }>('getblockchaininfo');
      return !i.initialblockdownload && i.headers - i.blocks <= 2;
    },
    async mnList(height) {
      const entries = await call<ProTxEntry[]>('protx', height === 'tip' ? ['list', 'registered', true] : ['list', 'registered', true, height]);
      const out = new Map<string, MnState>();
      for (const e of entries) {
        const dest = decodeAddress(e.state.votingAddress, network);
        if (!dest || dest.type !== 'p2pkh') {
          log.warn('protx list returned an unexpected voting address');
          continue;
        }
        out.set(e.proTxHash, { collateral: `${e.collateralHash}:${e.collateralIndex}`, votingKeyId: dest.hash160, valid: e.state.PoSeBanHeight === -1 });
      }
      return out;
    },
  };
}

/**
 * The current list and the S(E-1) snapshot, refreshed on the housekeeping timer, so checking a request needs no RPC call (a stranger
 * cannot make the issuer hit dashd). The snapshot of an epoch is fetched once the snapshot height is `settle` blocks deep.
 */
export class MnLists {
  readonly #core: CoreView;
  #now: { height: number; list: Map<string, MnState> } | null = null;
  readonly #snaps = new Map<number, Map<string, MnState>>();

  constructor(core: CoreView) {
    this.#core = core;
  }

  async refresh(snapshotHeights: readonly number[], settle: number): Promise<void> {
    const height = await this.#core.tipHeight();
    const list = await this.#core.mnList('tip');
    this.#now = { height, list };
    for (const h of snapshotHeights) if (!this.#snaps.has(h) && height >= h + settle) this.#snaps.set(h, await this.#core.mnList(h));
    const oldest = Math.min(...snapshotHeights);
    for (const k of this.#snaps.keys()) if (k < oldest) this.#snaps.delete(k);
  }

  get now(): { height: number; list: Map<string, MnState> } | null {
    return this.#now;
  }

  snapshot(height: number): Map<string, MnState> | null {
    return this.#snaps.get(height) ?? null;
  }
}
