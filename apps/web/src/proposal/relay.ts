// Proposal submission through govhub relays (services/relay/openapi.json). A relay that holds proposals takes the proposal as soon as
// the fee is paid and runs `gobject submit` itself once the fee is in a ChainLocked block (POST /v1/proposals). Dash Core relays it
// then and makes it live at 6 confirmations; the relay reports `sent` until it has seen Core take it in full, then `submitted`. A
// relay without holding only submits on request (POST /v1/proposals/submit, 425 until it may): this page asks it once the fee is
// ChainLocked (an older relay says 425 until 6 confirmations). Either way the relay sees only public data (the proposal becomes
// public when submitted) and the request's IP and timing; it never sees a key.
import type { CoreNetwork } from '../data/types.ts';
import { isObj, normalizeRelayUrl, numOrNull, RelayError, relayHost } from '../voting/relay.ts';

export { RelayError };

export type HeldStatus = 'waiting' | 'submitting' | 'submitted' | 'failed';

export interface HeldProposalState {
  id: string;
  govHash: string;
  status: HeldStatus;
  /** Core's count when the relay last looked. */
  confirmations: number | null;
  /** Dash Core took it before 6 confirmations and relayed it; it goes live at 6 (`submitted` once the relay saw that). */
  sent: boolean;
  lastError: string | null;
  /** Core's refusal text (`core-rejected` only). */
  coreMessage: string | null;
  nextAttemptAt: number | null;
  submittedAt: number | null;
}

export interface SubmitBody {
  network: CoreNetwork;
  parentHash: '0';
  revision: 1;
  time: number;
  dataHex: string;
  collateralTxid: string;
}

/** What a relay can do with a proposal: hold it (new relays) or submit it on request (all relays). */
export interface ProposalRelayPort {
  readonly name: string;
  readonly base: string;
  /** POST /v1/proposals. `legacy`: this relay has no holding; use `submitNow` once the fee is ChainLocked. */
  hold(body: SubmitBody, govHash: string): Promise<{ kind: 'held'; state: HeldProposalState } | { kind: 'legacy' }>;
  status(id: string, govHash: string): Promise<HeldProposalState | null>;
  /**
   * POST /v1/proposals/submit: `unconfirmed` (425) until the relay's Core counts a ChainLocked confirmation (an older relay: 6).
   * `postponed`: taken below 6 confirmations, live at 6.
   */
  submitNow(body: SubmitBody): Promise<{ kind: 'submitted'; govHash: string; postponed: boolean } | { kind: 'unconfirmed'; confirmations: number | null }>;
}

/** A refusal keeps the relay's JSON body (a 425 carries the confirmation count). */
type RefusalWithBody = RelayError & { body?: Record<string, unknown> };

const STATUSES = new Set<HeldStatus>(['waiting', 'submitting', 'submitted', 'failed']);
const shortText = (v: unknown, n: number): string | null => (typeof v === 'string' ? v.slice(0, n) : null);

export function parseHeldState(raw: unknown, govHash: string): HeldProposalState {
  if (!isObj(raw)) throw new RelayError('bad relay answer');
  const { id, status } = raw;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new RelayError('bad relay proposal id');
  if (typeof status !== 'string' || !STATUSES.has(status as HeldStatus)) throw new RelayError('bad relay proposal status');
  if (typeof raw.govHash !== 'string' || raw.govHash.toLowerCase() !== govHash) throw new RelayError('the relay answered for a different proposal');
  return {
    id,
    govHash,
    status: status as HeldStatus,
    confirmations: numOrNull(raw.confirmations),
    sent: raw.sent === true,
    lastError: shortText(raw.lastError, 80),
    coreMessage: shortText(raw.coreMessage, 200),
    nextAttemptAt: numOrNull(raw.nextAttemptAt),
    submittedAt: numOrNull(raw.submittedAt),
  };
}

export class HttpProposalRelay implements ProposalRelayPort {
  readonly base: string;
  readonly name: string;
  constructor(
    base: string,
    name?: string,
    readonly timeoutMs = 25_000,
  ) {
    this.base = normalizeRelayUrl(base);
    this.name = name ?? relayHost(this.base);
  }

  private async req(path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new RelayError(`relay ${this.name} unreachable: ${(e as Error).message}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) {
      const o = isObj(json) ? json : {};
      const err: RefusalWithBody = new RelayError(typeof o.error === 'string' ? o.error.slice(0, 200) : `relay answered HTTP ${res.status}`, res.status, typeof o.code === 'string' ? o.code : undefined, undefined, Number(res.headers.get('retry-after')) || undefined);
      err.body = o;
      throw err;
    }
    return json;
  }

  async hold(body: SubmitBody, govHash: string) {
    try {
      return { kind: 'held' as const, state: parseHeldState(await this.req('/v1/proposals', body), govHash) };
    } catch (e) {
      // a relay from before holding: the route does not exist
      if (e instanceof RelayError && e.status === 404 && e.code === 'not-found') return { kind: 'legacy' as const };
      throw e;
    }
  }

  async status(id: string, govHash: string) {
    try {
      return parseHeldState(await this.req(`/v1/proposals/${encodeURIComponent(id)}`), govHash);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) return null;
      throw e;
    }
  }

  async submitNow(body: SubmitBody) {
    try {
      const json = await this.req('/v1/proposals/submit', body);
      const o = isObj(json) ? json : {};
      if (typeof o.govHash !== 'string') throw new RelayError('bad relay answer');
      return { kind: 'submitted' as const, govHash: o.govHash.toLowerCase(), postponed: o.postponed === true };
    } catch (e) {
      if (e instanceof RelayError && e.status === 425) {
        return { kind: 'unconfirmed' as const, confirmations: numOrNull((e as RefusalWithBody).body?.confirmations) };
      }
      throw e;
    }
  }
}

/** Relay failures that say nothing about the proposal: try again later or on another relay. */
export const isTransient = (e: unknown): boolean =>
  !(e instanceof RelayError) || e.status === undefined || e.status >= 500 || e.status === 429 || e.status === 408 || e.code === 'unknown-collateral';

/** What a relay's refusal means for the user, in plain words. */
export function relayErrorText(e: unknown): string {
  if (!(e instanceof RelayError)) return (e as Error)?.message ?? String(e);
  switch (e.code) {
    case 'unknown-collateral':
      return 'the relay\'s Dash Core has not seen the fee transaction yet; trying again shortly';
    case 'bad-collateral':
      return `the fee transaction does not pay for this proposal (${e.message})`;
    case 'bad-proposal':
      return `Dash Core's rules refuse the proposal: ${e.message}`;
    case 'core-rejected':
      return `Dash Core refused it: ${e.message}`;
    case 'relay-full':
      return 'the relay is full right now';
    case 'rate-limited':
      return 'the relay asks to slow down';
    case 'disabled':
      return 'this relay does not submit proposals';
    case 'wrong-network':
      return 'this relay serves another network';
    default:
      return e.message;
  }
}
