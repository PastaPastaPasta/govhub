// Releases held votes to Core (`voteraw`), watches that they show up (`gobject getcurrentvotes`), and purges old rows.
// All time comes from the injected clock and all work happens in the tick*() methods, so tests drive it without timers;
// start() only wires those methods to setInterval.
//
// Core rules respected (Dash Core governance/object.cpp ProcessVote, vote.cpp IsValid, rpc/governance.cpp voteraw):
//  - a vote timed more than 1 h ahead of Core's clock is refused  -> wait until time - 1 h + 60 s;
//  - one accepted change per (masternode, object, signal) per hour, measured on Core's receive time -> keep >= 1 h + 30 s apart;
//  - a vote older than the masternode's current one is "Obsolete" -> terminal;
//  - a vote Core already has answers with an empty message ("Error voting : ") -> not an error, the confirmer decides.
// A vote is `sending` while voteraw is in flight, so a cancel cannot race with it. Once an attempt may have reached Core (no answer:
// transport error or timeout, a crash mid-call, or a broadcast vote that never showed up and is sent again), the vote waits as
// `maybe-broadcast` instead of `held`, for good: it is retried like a held vote, but a cancel is refused (it could not be taken back).
// Logs never contain outpoints, vote hashes or Core's raw messages: only the relay id and a short error code.
import { VOTE_MAX_FUTURE_S, VOTE_UPDATE_MIN_S, voteRawParams, type VoteFields } from '@govhub/verify';
import type { RelayConfig } from './config.ts';
import { rpcMessage, type CoreClient } from './core/rpc.ts';
import type { Store, VoteRow } from './db.ts';
import { log, type Clock } from './log.ts';
import type { MnDirectory } from './mnlist.ts';

const BATCH = 50;
const TOO_OFTEN_WAIT_S = VOTE_UPDATE_MIN_S + 30;
const MAX_ERROR_ATTEMPTS = 50;
const MAX_REBROADCASTS = 3;
const UNKNOWN_PROPOSAL_GIVE_UP_S = 6 * 3600;
const BROADCAST_EVERY_S = 5;
const CONFIRM_EVERY_S = 30;
const PURGE_EVERY_S = 3600;

/** Core's answer to a vote it already has (governance.cpp ProcessVote: empty message; object.cpp ProcessVote: "Already known valid vote"). */
export function isKnownVote(msg: string): boolean {
  return msg.replace(/^\s*Error voting\s*:?/i, '').trim() === '' || /already known|already have|known valid vote/i.test(msg);
}

/**
 * `last_error` codes of a vote that is held on purpose (not a failure): Core's "voting too often" answer, our own record of the last
 * broadcast for this masternode and proposal (the same one-change-per-hour rule, checked before asking Core), and Core's
 * one-hour future limit on nTime. GET /v1/votes/:id turns them into `holdReason`.
 */
export const HOLD_CODE = { tooOften: 'too-often', hourRule: 'hour-rule', futureLimit: 'future-limit' } as const;

const backoff = (base: number, cap: number, n: number): number => Math.min(cap, base * 2 ** Math.min(n, 30));

export interface BroadcasterDeps {
  cfg: RelayConfig;
  store: Store;
  core: CoreClient;
  mns: MnDirectory;
  clock: Clock;
}

function fieldsOf(r: VoteRow): VoteFields {
  return { collateralTxid: r.collateral_txid, collateralIndex: r.collateral_n, govHashDisplay: r.gov_hash, signal: r.signal, outcome: r.outcome, time: r.time };
}

export class Broadcaster {
  private readonly cfg: RelayConfig;
  private readonly store: Store;
  private readonly core: CoreClient;
  private readonly mns: MnDirectory;
  private readonly clock: Clock;
  private busy = { broadcast: false, confirm: false };
  private lastConfirm = -Infinity;
  private lastPurge: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(d: BroadcasterDeps) {
    this.cfg = d.cfg;
    this.store = d.store;
    this.core = d.core;
    this.mns = d.mns;
    this.clock = d.clock;
    this.lastPurge = d.clock();
    // a crash between "sending" and the answer leaves rows behind; retry them now (Core answers "known" if the vote did get through)
    const recovered = this.store.recoverSending(d.clock());
    if (recovered) log.warn('votes left in sending by a crash went back to held', { count: recovered });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => log.error('broadcaster tick failed', { error: String((e as Error)?.message ?? e) }));
    }, BROADCAST_EVERY_S * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler pass: broadcast every time, confirm every 30 s, purge every hour. */
  async tick(): Promise<void> {
    await this.tickBroadcast();
    if (this.clock() - this.lastConfirm >= CONFIRM_EVERY_S) await this.tickConfirm();
    if (this.clock() - this.lastPurge >= PURGE_EVERY_S) this.tickPurge();
  }

  // ---- release held votes ----

  async tickBroadcast(): Promise<void> {
    if (this.busy.broadcast) return;
    this.busy.broadcast = true;
    try {
      for (const row of this.store.dueHeld(this.clock(), BATCH)) {
        try {
          await this.attempt(row.id);
        } catch (e) {
          // never let one vote stop the batch
          log.error('broadcast attempt crashed', { id: row.id, error: String((e as Error)?.message ?? e) });
        }
      }
    } finally {
      this.busy.broadcast = false;
    }
  }

  private async attempt(id: string): Promise<void> {
    const row = this.store.get(id);
    if (!row || (row.status !== 'held' && row.status !== 'maybe-broadcast')) return;
    let now = this.clock();

    // a newer vote for the same key was queued while this one was in flight (and this one went back to held): never send the older
    const key = { txid: row.collateral_txid, n: row.collateral_n, govHash: row.gov_hash, signal: row.signal };
    if (this.store.hasNewerLive(key, row.time)) {
      this.store.finish(row.id, 'superseded', this.clock(), null);
      return;
    }

    let mn;
    try {
      mn = await this.mns.lookup(row.collateral_txid, row.collateral_n);
    } catch {
      this.coreError(row, now);
      return;
    }
    if (!mn) return this.fail(row, now, 'mn-gone');
    if (mn.banned) return this.fail(row, now, 'mn-banned');

    // Core refuses a vote timed more than an hour ahead of its clock.
    if (row.time > now + VOTE_MAX_FUTURE_S - 30) {
      this.store.reschedule(row.id, row.time - VOTE_MAX_FUTURE_S + 60, HOLD_CODE.futureLimit);
      return;
    }
    // One change per hour on Core's clock. A re-broadcast of an unseen vote is exempt: if Core did accept it, it answers "too often".
    if (row.rebroadcasts === 0) {
      const last = this.store.lastBroadcastAt({ txid: row.collateral_txid, n: row.collateral_n, govHash: row.gov_hash, signal: row.signal });
      if (last !== null && now - last < TOO_OFTEN_WAIT_S) {
        this.store.reschedule(row.id, last + TOO_OFTEN_WAIT_S, HOLD_CODE.hourRule);
        return;
      }
    }

    // Claim the vote: held -> sending in one conditional UPDATE, nothing awaited in between. A cancel that landed while we were
    // asking for the masternode list wins here (no row changed); a cancel that arrives from now on sees `sending` and is refused.
    if (!this.store.markSending(id)) return;

    try {
      let result: unknown;
      try {
        result = await this.core.call('voteraw', voteRawParams(fieldsOf(row), row.sig_b64));
      } catch (e) {
        now = this.clock();
        this.onVoterawError(row, now, rpcMessage(e));
        return;
      }
      now = this.clock();
      if (typeof result === 'string' && /Voted successfully/i.test(result)) {
        this.store.markSent(row, now);
        return;
      }
      this.coreError(row, now, true); // an answer we do not understand: Core may have taken the vote
    } finally {
      // whatever went wrong above, a row must not stay `sending` until the next restart (and voteraw may have gone out)
      if (this.store.get(id)?.status === 'sending') this.coreError(row, this.clock(), true);
    }
  }

  private onVoterawError(row: VoteRow, now: number, msg: string | null): void {
    if (msg !== null) {
      // Core already has this exact vote (relayed by someone else, or an earlier attempt of ours whose answer we lost): not an error.
      // ProcessVote returns false for a known vote hash with an EMPTY exception message ("Error voting : "), and CGovernanceObject::
      // ProcessVote says "Already known valid vote". Hand it to the confirmer, which decides confirmed / superseded / re-broadcast.
      if (isKnownVote(msg)) {
        this.store.markSent(row, now);
        return;
      }
      if (/voting too often/i.test(msg)) {
        // someone (this relay, another relay, the operator) changed this vote within the hour: wait it out, not a failure
        this.store.reschedule(row.id, now + TOO_OFTEN_WAIT_S, HOLD_CODE.tooOften);
        return;
      }
      if (/Obsolete vote|same timestamp/i.test(msg)) return this.fail(row, now, 'obsolete');
      if (/Failure to find masternode/i.test(msg)) return this.fail(row, now, 'mn-not-valid');
      if (/Failure to verify vote/i.test(msg)) return this.fail(row, now, 'bad-signature');
      if (/Governance object not found/i.test(msg)) {
        if (now >= row.release_at + UNKNOWN_PROPOSAL_GIVE_UP_S) return this.fail(row, now, 'unknown-proposal');
        this.store.retryLater(row.id, now + backoff(60, 3600, row.fail_n), 'unknown-proposal');
        log.warn('voteraw: proposal not known to Core yet', { id: row.id, code: 'unknown-proposal' });
        return;
      }
    }
    // no answer at all (transport error, timeout): the call may have reached Core and the answer got lost
    this.coreError(row, now, msg === null);
  }

  /**
   * Transport error, HTTP 5xx or an unrecognised Core error: back off 30 s, 60 s, ... up to 30 min; give up after 50 attempts.
   * `maybeSent`: voteraw went out and got no answer we can rely on, so the vote waits as maybe-broadcast from now on.
   */
  private coreError(row: VoteRow, now: number, maybeSent = false): void {
    const failN = this.store.retryLater(row.id, now + backoff(30, 1800, row.fail_n), 'core-error', maybeSent);
    log.warn('voteraw failed', { id: row.id, code: 'core-error', failN });
    if (failN >= MAX_ERROR_ATTEMPTS) this.fail(row, now, 'core-error');
  }

  private fail(row: VoteRow, now: number, code: string): void {
    this.store.finish(row.id, 'failed', now, code);
    log.warn('vote failed', { id: row.id, code });
  }

  // ---- watch broadcast votes ----

  async tickConfirm(): Promise<void> {
    if (this.busy.confirm) return;
    this.busy.confirm = true;
    this.lastConfirm = this.clock();
    try {
      for (const row of this.store.listBroadcast()) {
        try {
          await this.check(row);
        } catch (e) {
          log.error('confirm check crashed', { id: row.id, error: String((e as Error)?.message ?? e) });
        }
      }
    } finally {
      this.busy.confirm = false;
    }
  }

  private async check(row: VoteRow): Promise<void> {
    let current: Record<string, unknown>;
    try {
      // vout is a string parameter in Core's RPC
      const r = await this.core.call<Record<string, unknown>>('gobject', ['getcurrentvotes', row.gov_hash, row.collateral_txid, String(row.collateral_n)]);
      current = r && typeof r === 'object' ? r : {};
    } catch (e) {
      const m = rpcMessage(e);
      if (m !== null && /unknown governance/i.test(m)) current = {};
      else {
        log.warn('getcurrentvotes failed', { id: row.id, code: 'core-error' });
        return;
      }
    }
    const now = this.clock();
    if (Object.prototype.hasOwnProperty.call(current, row.vote_hash)) {
      this.store.markConfirmed(row.id, now);
      return;
    }
    // values look like "<txid>-<n>:<time>:<outcome>:<signal>:<weight>"; a later funding vote of the same MN replaced ours
    for (const v of Object.values(current)) {
      if (typeof v !== 'string') continue;
      const [, time, , signal] = v.split(':');
      if (signal === 'funding' && Number(time) > row.time) {
        this.store.finish(row.id, 'superseded', now, null);
        return;
      }
    }
    if (now >= (row.broadcast_at ?? 0) + this.cfg.confirmTimeoutS) {
      if (row.rebroadcasts < MAX_REBROADCASTS) this.store.markRebroadcast(row.id, now);
      else this.fail(row, now, 'unconfirmed');
    }
  }

  // ---- housekeeping ----

  tickPurge(): { votes: number; lastBroadcast: number } {
    const now = this.clock();
    this.lastPurge = now;
    const r = this.store.purge(now, this.cfg.retentionDays);
    if (r.votes || r.lastBroadcast) log.info('purged', r);
    return r;
  }
}
