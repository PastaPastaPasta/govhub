// Client for govhub relays (services/relay/openapi.json). A relay sees the IP and timing of each request (threat model: public
// unlinkability only, PLAN §5.2), never a key: it gets fully signed votes and signed cancels.
import { relayCancelMessage, signMessage, type Network } from '@govhub/verify';
import { OUTCOME_NAME, type SignedVoteRecord } from './plan.ts';

/** `maybe-broadcast`: waiting to be re-sent, but an earlier attempt may already be in Core; it cannot be cancelled. */
export type RelayVoteStatus = 'held' | 'maybe-broadcast' | 'sending' | 'broadcast' | 'confirmed' | 'failed' | 'cancelled' | 'superseded';
/** Why a relay still holds a vote (relays from before this field leave it null). */
export type HoldReason = 'release-time' | 'one-change-per-hour' | 'core-time-limit' | 'retrying';

export interface RelayVoteState {
  id: string;
  voteHash: string;
  status: RelayVoteStatus;
  releaseAt: number;
  broadcastAt: number | null;
  confirmedAt: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  holdReason: HoldReason | null;
  sameAsCurrent: boolean | null;
  /** the relay may have handed it to Core at some point (even if it is failed or superseded now); null: a relay without the field */
  maybeSent: boolean | null;
}

/** GET /v1/status: is the relay up, and can it reach Core. */
export interface RelayHealth {
  ok: boolean;
  network?: string;
  coreReachable?: boolean;
  held?: number;
  error?: string;
  /** unix ms */
  checkedAt: number;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    /** For 409 answers: the vote's state at that relay (`not-held`: sending, broadcast, confirmed, failed, cancelled, superseded; `maybe-broadcast`). */
    readonly voteStatus?: string,
    /** Retry-After of a 429, in seconds */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

const STATUSES = new Set<RelayVoteStatus>(['held', 'maybe-broadcast', 'sending', 'broadcast', 'confirmed', 'failed', 'cancelled', 'superseded']);
const HOLD_REASONS = new Set<HoldReason>(['release-time', 'one-change-per-hour', 'core-time-limit', 'retrying']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

export function parseRelayState(raw: unknown): RelayVoteState {
  if (!isObj(raw)) throw new RelayError('bad relay answer');
  const { id, voteHash, status } = raw;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new RelayError('bad relay vote id');
  if (typeof voteHash !== 'string' || !/^[0-9a-f]{64}$/.test(voteHash)) throw new RelayError('bad relay vote hash');
  if (typeof status !== 'string' || !STATUSES.has(status as RelayVoteStatus)) throw new RelayError('bad relay vote status');
  return {
    id,
    voteHash,
    status: status as RelayVoteStatus,
    releaseAt: numOrNull(raw.releaseAt) ?? 0,
    broadcastAt: numOrNull(raw.broadcastAt),
    confirmedAt: numOrNull(raw.confirmedAt),
    lastError: typeof raw.lastError === 'string' ? raw.lastError.slice(0, 80) : null,
    nextAttemptAt: numOrNull(raw.nextAttemptAt),
    holdReason: typeof raw.holdReason === 'string' && HOLD_REASONS.has(raw.holdReason as HoldReason) ? (raw.holdReason as HoldReason) : null,
    sameAsCurrent: typeof raw.sameAsCurrent === 'boolean' ? raw.sameAsCurrent : null,
    maybeSent: typeof raw.maybeSent === 'boolean' ? raw.maybeSent : null,
  };
}

/** The relay's host, for display ("gov-relay-testnet.dashhq.org"). */
export const relayHost = (url: string): string => url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');

export const normalizeRelayUrl = (u: string): string => u.trim().replace(/\/+$/, '');

export class RelayClient {
  readonly base: string;
  constructor(
    base: string,
    readonly timeoutMs = 20_000,
  ) {
    this.base = normalizeRelayUrl(base);
  }

  private async req(path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new RelayError(`relay ${this.base} unreachable: ${(e as Error).message}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) {
      const o = isObj(json) ? json : {};
      throw new RelayError(typeof o.error === 'string' ? o.error.slice(0, 200) : `relay answered HTTP ${res.status}`, res.status, typeof o.code === 'string' ? o.code : undefined, typeof o.status === 'string' ? o.status : undefined, Number(res.headers.get('retry-after')) || undefined);
    }
    return { status: res.status, json };
  }

  /** GET /v1/status, with a short timeout: a health check must not keep a retry waiting. */
  async health(network: Network, timeoutMs = 8000): Promise<RelayHealth> {
    const checkedAt = Date.now();
    try {
      const { json } = await this.req('/v1/status', undefined, timeoutMs);
      const o = isObj(json) ? json : {};
      const core = isObj(o.core) ? o.core : {};
      const net = typeof o.network === 'string' ? o.network : undefined;
      if (net && net !== network) return { ok: false, network: net, error: `this relay serves ${net}, not ${network}`, checkedAt };
      return { ok: core.reachable !== false, ...(net ? { network: net } : {}), coreReachable: core.reachable !== false, ...(typeof o.held === 'number' ? { held: o.held } : {}), ...(core.reachable === false ? { error: 'the relay cannot reach Dash Core right now' } : {}), checkedAt };
    } catch (e) {
      return { ok: false, error: (e as Error).message, checkedAt };
    }
  }

  /** POST /v1/votes. The relay checks the signature against the masternode's voting key before it accepts. */
  async submit(v: SignedVoteRecord, network: Network): Promise<RelayVoteState> {
    const { json } = await this.req('/v1/votes', {
      network,
      collateralTxid: v.collateralTxid,
      collateralIndex: v.collateralIndex,
      govHash: v.govHash,
      signal: 'funding',
      outcome: OUTCOME_NAME[v.outcome],
      time: v.time,
      sig: v.sig,
      releaseAt: v.releaseAt,
    });
    const o = isObj(json) ? json : {};
    // 202 {id, voteHash, status, releaseAt} or 200 (already known) with the full record
    const st = parseRelayState(o);
    if (st.voteHash !== v.voteHash) throw new RelayError('the relay answered for a different vote');
    return st;
  }

  async status(id: string): Promise<RelayVoteState | null> {
    try {
      return parseRelayState((await this.req(`/v1/votes/${encodeURIComponent(id)}`)).json);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  /** POST /v1/votes/cancel with a `signmessage` signature by the voting key over relayCancelMessage (both networks). */
  async cancel(id: string, signatureBase64: string): Promise<RelayVoteStatus> {
    const { json } = await this.req('/v1/votes/cancel', { id, sig: signatureBase64 });
    const s = isObj(json) ? json.status : undefined;
    return typeof s === 'string' && STATUSES.has(s as RelayVoteStatus) ? (s as RelayVoteStatus) : 'cancelled';
  }
}

/** The cancel signature for one held vote: Dash `signmessage` with the voting key (the same scheme on mainnet and testnet). */
export const cancelSignature = (privKey: Uint8Array, compressed: boolean, network: Network, voteHash: string): string => signMessage(privKey, relayCancelMessage(network, voteHash), { compressed });
