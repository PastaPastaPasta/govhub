// The issuer's view of Core, from its own dashd over JSON-RPC (PLAN §8.4 rules 2-3): the tip height, the masternode list at a
// height (`protx list registered true [height]`) and, for starter tokens, the valid proposals (`gobject list valid proposals`).
// Read-only RPCs only: getblockcount, getblockchaininfo, protx list, mnsync status, gobject list.
import { decodeAddress, parseProposalData, type Network } from '@govhub/verify';
import { log } from './log.ts';

export interface MnState {
  /** collateral outpoint "txid:index" (display order txid) */
  collateral: string;
  /** hash160 of the voting key (keyIDVoting) */
  votingKeyId: Uint8Array;
  /** in the list and not PoSe-banned */
  valid: boolean;
}

export interface ProposalState {
  /** hash160 of the payment address if it is P2PKH (only such an address can sign a message), else null */
  paymentKeyId: Uint8Array | null;
  /** end_epoch (unix seconds) */
  endEpoch: number;
}

export interface CoreView {
  tipHeight(): Promise<number>;
  /** Out of initial block download (a syncing node's tip and lists are not the network's). */
  synced(): Promise<boolean>;
  /** Every registered MN at `height` ('tip' = now), keyed by display-order proTxHash. */
  mnList(height: number | 'tip'): Promise<Map<string, MnState>>;
  /** The proposals Core holds as valid now, keyed by display-order (lowercase hex) govHash. */
  proposals(): Promise<Map<string, ProposalState>>;
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

interface GobjectEntry {
  DataHex: string;
  ObjectType: number;
  fCachedValid: boolean;
}
/** GOVERNANCE_OBJECT_PROPOSAL */
const GOV_PROPOSAL = 1;

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
    async proposals() {
      // Until governance sync has finished the list is partial: refuse it (the cache keeps its last list or stays empty, and a
      // proposal owner gets "unavailable", not "unauthorized").
      const sync = await call<{ IsSynced: boolean }>('mnsync', ['status']);
      if (!sync.IsSynced) throw new Error('governance is not synced yet (mnsync)');
      const entries = await call<Record<string, GobjectEntry>>('gobject', ['list', 'valid', 'proposals']);
      const out = new Map<string, ProposalState>();
      for (const [hash, e] of Object.entries(entries)) {
        if (e.ObjectType !== GOV_PROPOSAL || !e.fCachedValid || !/^[0-9a-fA-F]{64}$/.test(hash)) continue;
        const fields = parseProposalData(e.DataHex).fields;
        if (!fields) continue; // Core keeps it, but nobody could prove its payment address from it
        const dest = decodeAddress(fields.paymentAddress, network);
        out.set(hash.toLowerCase(), { paymentKeyId: dest?.type === 'p2pkh' ? dest.hash160 : null, endEpoch: fields.endEpoch });
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

/**
 * The valid proposals, refreshed on the housekeeping timer like MnLists, so a starter request for a proposal needs no RPC before it
 * is authenticated (a stranger cannot make the issuer hit dashd with junk govHashes).
 */
export class ProposalCache {
  readonly #core: Pick<CoreView, 'tipHeight' | 'proposals'>;
  #now: { height: number; list: Map<string, ProposalState> } | null = null;

  constructor(core: Pick<CoreView, 'tipHeight' | 'proposals'>) {
    this.#core = core;
  }

  async refresh(): Promise<void> {
    const height = await this.#core.tipHeight();
    this.#now = { height, list: await this.#core.proposals() };
  }

  get now(): { height: number; list: Map<string, ProposalState> } | null {
    return this.#now;
  }
}
