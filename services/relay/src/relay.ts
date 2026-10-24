// The relay's request logic (everything the HTTP layer calls). Spec: services/relay/openapi.json, README.md.
import { randomBytes } from 'node:crypto';
import {
  bytesEqual,
  checkCollateralTx,
  governanceObjectHash,
  governanceVoteHash,
  hexToBytes,
  recoverVoteSigner,
  relayVoteError,
  validateProposalData,
  verifyRelayCancel,
  VOTE_MAX_FUTURE_S,
  VOTE_OUTCOME_NAMES,
  VOTE_SIGNAL_NAMES,
  type VoteFields,
} from '@govhub/verify';
import type { RelayConfig } from './config.ts';
import { rpcMessage, type CoreClient, type GobjectGetResult, type RawTxVerbose } from './core/rpc.ts';
import { Store, type VoteRow } from './db.ts';
import { log, type Clock } from './log.ts';
import { MnDirectory, type MnEntry } from './mnlist.ts';
import { RollingHourLimiter } from './ratelimit.ts';

export const SERVICE_VERSION = '0.1.0';

/** An error with an HTTP status and a stable machine-readable code (`{error, code}` in the response). */
export class RelayError extends Error {
  status: number;
  code: string;
  /** extra top-level JSON fields (e.g. `status`, `confirmations`) */
  extra: Record<string, unknown>;
  /** seconds, for the Retry-After header */
  retryAfter: number | undefined;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}, retryAfter?: number) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.retryAfter = retryAfter;
  }
}

const badRequest = (msg: string) => new RelayError(400, 'bad-request', msg);
const coreDown = () => new RelayError(503, 'core-unavailable', 'Dash Core is not reachable, try again later');

export interface VoteReceipt {
  id: string;
  voteHash: string;
  status: string;
  releaseAt: number;
}

export interface VoteStatusView {
  id: string;
  voteHash: string;
  status: string;
  releaseAt: number;
  broadcastAt: number | null;
  confirmedAt: number | null;
  attempts: number;
  lastError: string | null;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;
const ID_RE = /^[0-9a-f]{32}$/;
/** 65 bytes in canonical base64: 87 characters and one padding character. */
const SIG_B64 = /^[A-Za-z0-9+/]{87}=$/;
const VERDICT_TTL_S = 60;
const VERDICT_MAX = 2000;
const STATUS_TTL_S = 5;
const STATUS_TIMEOUT_MS = 3000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw badRequest(`unknown field ${JSON.stringify(k.slice(0, 40))}`);
}

function hex64(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !HEX64.test(v)) throw badRequest(`${k} must be 64 hex characters`);
  return v.toLowerCase();
}

function int(o: Record<string, unknown>, k: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw badRequest(`${k} must be an integer in [${min}, ${max}]`);
  return v;
}

function sigB64(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !SIG_B64.test(v) || Buffer.from(v, 'base64').toString('base64') !== v) throw badRequest(`${k} must be the base64 of a 65-byte compact signature`);
  return v;
}

interface ParsedVote {
  fields: VoteFields;
  sig: string;
  releaseAt: number | undefined;
}

function parseVoteBody(o: Record<string, unknown>): ParsedVote {
  onlyKeys(o, ['network', 'collateralTxid', 'collateralIndex', 'govHash', 'signal', 'outcome', 'time', 'sig', 'releaseAt']);
  const signalName = o.signal;
  const outcomeName = o.outcome;
  const signal = typeof signalName === 'string' ? (VOTE_SIGNAL_NAMES as readonly string[]).indexOf(signalName) : -1;
  const outcome = typeof outcomeName === 'string' ? (VOTE_OUTCOME_NAMES as readonly string[]).indexOf(outcomeName) : -1;
  const fields: VoteFields = {
    collateralTxid: hex64(o, 'collateralTxid'),
    collateralIndex: int(o, 'collateralIndex', 0, 0xffffffff),
    govHashDisplay: hex64(o, 'govHash'),
    signal: signal,
    outcome: outcome,
    time: int(o, 'time', Number.MIN_SAFE_INTEGER),
  };
  if (signal < 0) throw badRequest('signal must be a vote signal name');
  if (outcome < 0) throw badRequest('outcome must be a vote outcome name');
  const sig = sigB64(o, 'sig');
  const releaseAt = o.releaseAt === undefined ? undefined : int(o, 'releaseAt', Number.MIN_SAFE_INTEGER);
  return { fields, sig, releaseAt };
}

type Verdict = 'ok' | 'unknown' | 'not-proposal';

export class Relay {
  readonly cfg: RelayConfig;
  readonly store: Store;
  readonly core: CoreClient;
  readonly mns: MnDirectory;
  readonly clock: Clock;
  private readonly mnLimiter: RollingHourLimiter;
  private readonly verdicts = new Map<string, { verdict: Verdict; until: number }>();
  private statusCache: { at: number; core: { reachable: boolean; height: number | null } } | null = null;
  private statusInflight: Promise<{ reachable: boolean; height: number | null }> | null = null;

  constructor(cfg: RelayConfig, store: Store, core: CoreClient, clock: Clock) {
    this.cfg = cfg;
    this.store = store;
    this.core = core;
    this.clock = clock;
    this.mns = new MnDirectory(core, cfg.network, clock, cfg.mnListTtlS);
    this.mnLimiter = new RollingHourLimiter(cfg.rateMnPerHour, clock);
  }

  // ---- POST /v1/votes ----

  async submitVote(body: unknown): Promise<{ httpStatus: 200 | 202; receipt: VoteReceipt }> {
    const now = this.clock();
    if (!isRecord(body)) throw badRequest('body must be a JSON object');
    if (body.network !== this.cfg.network) throw new RelayError(400, 'wrong-network', `this relay serves ${this.cfg.network}`);
    const { fields: v, sig, releaseAt: requestedRelease } = parseVoteBody(body);

    const voteErr = relayVoteError(v, now, this.cfg.maxHoldS);
    if (voteErr) throw new RelayError(400, 'bad-vote', voteErr);
    const time = Number(v.time);

    // release time: default is just before the signed time; an explicit one must keep Core's 1 h future limit and our hold bound
    let releaseAt = Math.max(now, time - this.cfg.releaseMarginS);
    if (requestedRelease !== undefined) {
      if (requestedRelease < time - VOTE_MAX_FUTURE_S + 60 || requestedRelease > time + 86400 || requestedRelease > now + this.cfg.maxHoldS) {
        throw new RelayError(400, 'bad-release', 'releaseAt must be within [time - 3540, time + 86400] and not further than the hold limit');
      }
      releaseAt = Math.max(now, requestedRelease);
    }

    const mn = await this.findMn(v.collateralTxid, v.collateralIndex);
    if (!mn) throw new RelayError(404, 'unknown-mn', 'no registered masternode has this collateral');
    if (mn.banned) throw new RelayError(409, 'mn-banned', 'this masternode is PoSe-banned and cannot vote');
    if (!mn.votingKeyId) throw new RelayError(409, 'mn-no-voting-key', 'the masternode voting address is not a P2PKH address');

    const signer = recoverVoteSigner(sig, v, this.cfg.network);
    if (!signer || !bytesEqual(signer.keyId, mn.votingKeyId)) throw new RelayError(400, 'bad-signature', 'the signature does not recover to the masternode voting key');

    await this.checkProposal(v.govHashDisplay);

    // --- everything below is synchronous: no await between the checks and the insert ---
    const voteHash = governanceVoteHash(v);
    const existing = this.store.getByVoteHash(voteHash);
    if (existing) return { httpStatus: 200, receipt: receipt(existing) };

    const key = { txid: v.collateralTxid, n: v.collateralIndex, govHash: v.govHashDisplay, signal: v.signal };
    const held = this.store.heldForKey(key);
    if (held && time <= held.time) throw new RelayError(409, 'later-vote-held', 'a vote with a later or equal time for this proposal is already held');

    const mnKey = `${v.collateralTxid}-${v.collateralIndex}`;
    if (this.mnLimiter.exceeded(mnKey)) throw new RelayError(429, 'rate-limited', 'too many votes from this masternode in the last hour', {}, this.mnLimiter.retryAfter(mnKey));
    if (!held && this.store.countHeldForMn(v.collateralTxid, v.collateralIndex) >= this.cfg.maxHeldPerMn) {
      throw new RelayError(429, 'too-many-held', `this masternode already has ${this.cfg.maxHeldPerMn} held votes`, {}, 60);
    }

    const id = randomBytes(16).toString('hex');
    this.store.db.transaction(() => {
      if (held) this.store.supersedeHeld(held.id, now);
      this.store.insert({
        id,
        vote_hash: voteHash,
        collateral_txid: v.collateralTxid,
        collateral_n: v.collateralIndex,
        gov_hash: v.govHashDisplay,
        signal: v.signal,
        outcome: v.outcome,
        time,
        sig_b64: sig,
        release_at: releaseAt,
        received_hour: now - (now % 3600),
      });
    })();
    this.mnLimiter.record(mnKey);
    return { httpStatus: 202, receipt: { id, voteHash, status: 'held', releaseAt } };
  }

  // ---- POST /v1/votes/cancel ----

  async cancelVote(body: unknown): Promise<{ id: string; status: string }> {
    if (!isRecord(body)) throw badRequest('body must be a JSON object');
    onlyKeys(body, ['id', 'sig']);
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) throw badRequest('id must be 32 lowercase hex characters');
    const sig = sigB64(body, 'sig');
    const row = this.store.get(body.id);
    if (!row) throw new RelayError(404, 'unknown-id', 'unknown vote id');

    const mn = await this.findMn(row.collateral_txid, row.collateral_n);
    if (!mn) throw new RelayError(404, 'unknown-mn', 'the masternode is no longer registered');
    if (!mn.votingKeyId || !verifyRelayCancel(sig, this.cfg.network, row.vote_hash, mn.votingKeyId)) {
      throw new RelayError(403, 'bad-signature', 'the signature is not the masternode voting key cancelling this vote');
    }

    // re-read: the lookup above awaited and the broadcaster may have moved the vote on
    if (this.store.cancelHeld(row.id, this.clock())) return { id: row.id, status: 'cancelled' };
    const now = this.store.get(row.id)!;
    if (now.status === 'cancelled') return { id: row.id, status: 'cancelled' };
    throw new RelayError(409, 'not-held', `the vote is ${now.status}, only held votes can be cancelled`, { status: now.status });
  }

  // ---- GET /v1/votes/:id ----

  getVote(id: string): VoteStatusView {
    if (!ID_RE.test(id)) throw badRequest('id must be 32 lowercase hex characters');
    const row = this.store.get(id);
    if (!row) throw new RelayError(404, 'unknown-id', 'unknown vote id');
    return {
      id: row.id,
      voteHash: row.vote_hash,
      status: row.status,
      releaseAt: row.release_at,
      broadcastAt: row.broadcast_at,
      confirmedAt: row.confirmed_at,
      attempts: row.attempts,
      lastError: row.last_error,
    };
  }

  // ---- GET /v1/status ----

  async status() {
    return {
      service: 'govhub-relay',
      version: SERVICE_VERSION,
      network: this.cfg.network,
      core: await this.coreStatus(),
      held: this.store.countHeld(),
      proposalSubmit: this.cfg.proposalSubmit,
    };
  }

  /** Never blocks longer than STATUS_TIMEOUT_MS and asks Core at most every STATUS_TTL_S (the endpoint is public and is the health check). */
  private async coreStatus(): Promise<{ reachable: boolean; height: number | null }> {
    const now = this.clock();
    if (this.statusCache && now - this.statusCache.at < STATUS_TTL_S) return this.statusCache.core;
    if (!this.statusInflight) {
      this.statusInflight = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const height = await Promise.race([
            this.core.call<number>('getblockcount'),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => rej(new Error('timeout')), STATUS_TIMEOUT_MS);
            }),
          ]);
          return { reachable: true, height: typeof height === 'number' ? height : null };
        } catch {
          return { reachable: false, height: null };
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    const inflight = this.statusInflight;
    try {
      const core = await inflight;
      this.statusCache = { at: this.clock(), core };
      return core;
    } finally {
      if (this.statusInflight === inflight) this.statusInflight = null;
    }
  }

  // ---- POST /v1/proposals/submit ----

  async submitProposal(body: unknown): Promise<{ govHash: string; result: unknown }> {
    if (!this.cfg.proposalSubmit) throw new RelayError(501, 'disabled', 'proposal submission is disabled on this relay');
    const now = this.clock();
    if (!isRecord(body)) throw badRequest('body must be a JSON object');
    if (body.network !== this.cfg.network) throw new RelayError(400, 'wrong-network', `this relay serves ${this.cfg.network}`);
    onlyKeys(body, ['network', 'parentHash', 'revision', 'time', 'dataHex', 'collateralTxid']);
    if (typeof body.parentHash !== 'string' || !(body.parentHash === '0' || /^0{64}$/.test(body.parentHash))) throw badRequest('parentHash must be "0": only proposals are submitted');
    if (body.revision !== 1) throw badRequest('revision must be 1');
    const time = int(body, 'time', 1);
    if (typeof body.dataHex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(body.dataHex)) throw badRequest('dataHex must be non-empty even-length hex');
    const dataHex = body.dataHex.toLowerCase();
    const txid = hex64(body, 'collateralTxid');

    const valid = validateProposalData(dataHex, this.cfg.network, { now });
    if (!valid.valid) throw new RelayError(400, 'bad-proposal', valid.errors.join('; '), { errors: valid.errors });

    const govHash = governanceObjectHash({ parentHash: '0', revision: 1, time, dataHex });

    let tx: RawTxVerbose;
    try {
      tx = await this.core.call<RawTxVerbose>('getrawtransaction', [txid, true]);
    } catch (e) {
      if (rpcMessage(e) !== null) throw new RelayError(404, 'unknown-collateral', 'the collateral transaction is unknown to Core');
      throw coreDown();
    }
    const raw = typeof tx?.hex === 'string' && /^([0-9a-f]{2})+$/.test(tx.hex) ? hexToBytes(tx.hex) : null;
    if (!raw) throw new RelayError(409, 'core-rejected', 'Core returned no raw collateral transaction');
    const col = checkCollateralTx(raw, govHash.raw, { expectedTxid: txid });
    if (!col.valid) throw new RelayError(400, 'bad-collateral', col.message ?? col.failure ?? 'invalid collateral transaction', { failure: col.failure });
    const confirmations = typeof tx.confirmations === 'number' ? tx.confirmations : 0;
    if (confirmations < this.cfg.minCollateralConfs) {
      throw new RelayError(425, 'collateral-unconfirmed', `the collateral needs ${this.cfg.minCollateralConfs} confirmations`, { confirmations });
    }

    try {
      const result = await this.core.call('gobject', ['submit', '0', 1, time, dataHex, txid]);
      return { govHash: govHash.display, result };
    } catch (e) {
      const m = rpcMessage(e);
      if (m !== null) throw new RelayError(409, 'core-rejected', m);
      throw coreDown();
    }
  }

  // ---- helpers ----

  private async findMn(txid: string, n: number): Promise<MnEntry | null> {
    try {
      return await this.mns.lookup(txid, n);
    } catch (e) {
      log.warn('masternode list unavailable', { rpc: rpcMessage(e) !== null });
      throw coreDown();
    }
  }

  /** `gobject get` must succeed with ObjectType 1 (proposal). Definite answers are cached for VERDICT_TTL_S. */
  private async checkProposal(govHash: string): Promise<void> {
    const now = this.clock();
    let verdict = this.verdicts.get(govHash);
    if (!verdict || verdict.until <= now) {
      let v: Verdict;
      try {
        const obj = await this.core.call<GobjectGetResult>('gobject', ['get', govHash]);
        v = obj?.ObjectType === 1 ? 'ok' : 'not-proposal';
      } catch (e) {
        const m = rpcMessage(e);
        if (m !== null && /unknown governance object|not found/i.test(m)) v = 'unknown';
        else throw coreDown();
      }
      if (this.verdicts.size >= VERDICT_MAX) {
        for (const [k, x] of this.verdicts) if (x.until <= now) this.verdicts.delete(k);
        if (this.verdicts.size >= VERDICT_MAX) this.verdicts.clear();
      }
      verdict = { verdict: v, until: now + VERDICT_TTL_S };
      this.verdicts.set(govHash, verdict);
    }
    if (verdict.verdict === 'unknown') throw new RelayError(404, 'unknown-proposal', 'Core does not know this governance object');
    if (verdict.verdict === 'not-proposal') throw new RelayError(400, 'not-a-proposal', 'the governance object is not a proposal');
  }
}

function receipt(r: VoteRow): VoteReceipt {
  return { id: r.id, voteHash: r.vote_hash, status: r.status, releaseAt: r.release_at };
}
