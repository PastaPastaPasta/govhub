// Minimal Dash Core JSON-RPC client (HTTP POST, basic auth, per-call timeout, bounded retries).
// Copied from services/bridge/src/core/rpc.ts (services stay independent); the relay only needs `call`.
import { log } from '../log.ts';

/** What the relay needs from Core. Tests inject an in-memory fake. */
export interface CoreClient {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

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
  /** Core's message without our `method:` prefix. */
  rpcMessage: string;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'CoreRpcError';
    this.code = code;
    this.method = method;
    this.rpcMessage = message;
  }
}

/** RPC_IN_WARMUP: Core is still loading. */
const RPC_IN_WARMUP = -28;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CoreRpc implements CoreClient {
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
}

/** Core's own message when `e` is a JSON-RPC error answered by Core, else null (transport failure, auth, HTTP 5xx). */
export function rpcMessage(e: unknown): string | null {
  return e instanceof CoreRpcError ? e.rpcMessage : null;
}

// ---- shapes of the Core results the relay reads ----

export interface ProTxEntry {
  proTxHash: string;
  collateralHash: string;
  collateralIndex: number;
  state: { PoSeBanHeight: number; votingAddress: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** `gobject get <hash>`: only full objects (Core's mapObjects); a postponed one is "Unknown governance object" (-8). */
export interface GobjectGetResult {
  ObjectType: number;
  [k: string]: unknown;
}

export interface RawTxVerbose {
  txid: string;
  hex: string;
  confirmations?: number;
  /** a ChainLock covers the transaction's block (src/rpc/rawtransaction.cpp TxToJSON; false in the mempool) */
  chainlock?: boolean;
  [k: string]: unknown;
}
