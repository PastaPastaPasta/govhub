// Minimal Dash Core JSON-RPC client (HTTP POST, basic auth, per-call timeout, bounded retries).
import { log } from '../log.ts';

export interface CoreRpcOptions {
  url: string;
  user: string;
  password: string;
  /** Per attempt. Default 30 s. */
  timeoutMs?: number;
  /** Extra attempts after the first for transport errors, HTTP 5xx without a JSON-RPC body, and RPC_IN_WARMUP (-28). Default 3. */
  retries?: number;
  /** Base backoff, doubled per attempt. Default 500 ms. */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** A JSON-RPC error returned by Core (the request reached Core and was answered). */
export class CoreRpcError extends Error {
  code: number;
  method: string;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'CoreRpcError';
    this.code = code;
    this.method = method;
  }
}

/** RPC_IN_WARMUP: Core is still loading. */
const RPC_IN_WARMUP = -28;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CoreRpc {
  readonly url: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(opts: CoreRpcOptions) {
    this.url = opts.url;
    this.auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: this.auth },
          body: JSON.stringify({ jsonrpc: '1.0', id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastErr = e;
        log.warn('core rpc transport error', { method, attempt, error: String((e as Error)?.message ?? e) });
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`${method}: Core RPC authentication failed (HTTP ${res.status})`);
      const text = await res.text();
      let body: { result?: T; error?: { code: number; message: string } | null } | undefined;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (body && body.error) {
        if (body.error.code === RPC_IN_WARMUP && attempt < this.retries) {
          lastErr = new CoreRpcError(method, body.error.code, body.error.message);
          continue;
        }
        throw new CoreRpcError(method, body.error.code, body.error.message);
      }
      if (body && res.ok) return body.result as T;
      lastErr = new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
      if (res.status < 500) throw lastErr;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // ---- typed helpers for the calls the bridge uses ----
  getBlockCount = () => this.call<number>('getblockcount');
  getBlockHash = (height: number) => this.call<string>('getblockhash', [height]);
  getBlockHeader = (hash: string) => this.call<BlockHeader>('getblockheader', [hash, true]);
  getBlock = (hash: string, verbosity = 2) => this.call<any>('getblock', [hash, verbosity]);
  getIndexInfo = () => this.call<Record<string, { synced: boolean; best_block_height: number }>>('getindexinfo');
  getGovernanceInfo = () => this.call<GovernanceInfo>('getgovernanceinfo');
  getSuperblockBudget = (height: number) => this.call<number>('getsuperblockbudget', [height]);
  gobjectList = (signal = 'all', type = 'all') => this.call<Record<string, GobjectListEntry>>('gobject', ['list', signal, type]);
  gobjectGet = (hash: string) => this.call<GobjectGetResult>('gobject', ['get', hash]);
  gobjectCurrentVotes = (hash: string) => this.call<Record<string, string>>('gobject', ['getcurrentvotes', hash]);
  getRawTransactionVerbose = (txid: string) => this.call<RawTxVerbose>('getrawtransaction', [txid, true]);
  /** `protx list registered true <height>`: every registered MN (incl. PoSe-banned) at `height` with its state. */
  protxListRegistered = (height: number) => this.call<ProTxEntry[]>('protx', ['list', 'registered', true, height]);
  getNetworkInfo = () => this.call<{ version: number; subversion: string }>('getnetworkinfo');
  mnsyncStatus = () => this.call<{ IsSynced: boolean; IsBlockchainSynced: boolean; AssetName: string }>('mnsync', ['status']);
}

export interface BlockHeader {
  hash: string;
  height: number;
  time: number;
  mediantime: number;
  confirmations: number;
  chainlock?: boolean;
  previousblockhash?: string;
}

export interface GovernanceInfo {
  governanceminquorum: number;
  proposalfee: number;
  superblockcycle: number;
  superblockmaturitywindow: number;
  lastsuperblock: number;
  nextsuperblock: number;
  fundingthreshold: number;
  governancebudget: number;
}

export interface GobjectListEntry {
  DataHex: string;
  DataString: string;
  Hash: string;
  CollateralHash: string;
  ObjectType: number;
  CreationTime: number;
  SigningMasternode?: string;
  AbsoluteYesCount: number;
  YesCount: number;
  NoCount: number;
  AbstainCount: number;
  fBlockchainValidity: boolean;
  IsValidReason: string;
  fCachedValid: boolean;
  fCachedFunding: boolean;
  fCachedDelete: boolean;
  fCachedEndorsed: boolean;
}

export interface FundingResult {
  AbsoluteYesCount: number;
  YesCount: number;
  NoCount: number;
  AbstainCount: number;
}

export interface GobjectGetResult {
  DataHex: string;
  DataString: string;
  Hash: string;
  CollateralHash: string;
  ObjectType: number;
  CreationTime: number;
  SigningMasternode?: string;
  FundingResult: FundingResult;
  ValidResult?: FundingResult;
  DeleteResult?: FundingResult;
  EndorsedResult?: FundingResult;
  fLocalValidity?: boolean;
  IsValidReason?: string;
  fCachedValid?: boolean;
  fCachedFunding?: boolean;
  fCachedDelete?: boolean;
  fCachedEndorsed?: boolean;
}

export interface RawTxVerbose {
  txid: string;
  hex: string;
  blockhash?: string;
  height?: number;
  confirmations?: number;
  time?: number;
  blocktime?: number;
  instantlock?: boolean;
  chainlock?: boolean;
}

export interface ProTxEntry {
  type: 'Regular' | 'Evo' | string;
  proTxHash: string;
  collateralHash: string;
  collateralIndex: number;
  state: {
    registeredHeight: number;
    PoSeBanHeight: number;
    PoSeRevivedHeight: number;
    revocationReason?: number;
    ownerAddress: string;
    votingAddress: string;
    payoutAddress: string;
    pubKeyOperator: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
