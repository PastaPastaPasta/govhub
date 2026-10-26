// Held proposal submission (POST /v1/proposals): runs `gobject submit` once the proposal's collateral is in a ChainLocked block
// (MIN_COLLATERAL_CONFS confirmations by Core's own count, default 1), then makes sure Core has it as a full object once the
// collateral is 6 deep, so the client can go away after paying. All time comes from the injected clock and all work happens in
// tick() / submit(), so tests drive it without timers; start() only wires tick() to setInterval.
//
// Row states: waiting -> submitting -> (6+ confirmations) submitted | (1-5, ChainLocked) waiting with `sent` -> at 6: `gobject get`
// finds it -> submitted, or it is unknown (a dashd restart lost it) -> submitting again -> submitted. Any state -> failed.
//
// Dash Core rules this follows (dash develop f35a24cfca12):
//  - `gobject submit` (src/rpc/governance.cpp:312-418) refuses with RPC_CLIENT_IN_INITIAL_DOWNLOAD (-10, "Must wait for client to
//    sync with masternode network") until mnsync reports the blockchain synced (`IsBlockchainSynced`, rpc/governance.cpp:330-332)
//    -> retry later, not a failure;
//  - it runs governance::ValidateProposal with expiry (end_epoch in the future, rpc/governance.cpp:379-384) -> an expired held
//    proposal fails here first (`expired`) instead of being sent. Promoting a postponed object checks no expiry
//    (object.cpp IsValidLocally), so a row already sent is not failed for it;
//  - CGovernanceObject::IsCollateralValid (governance/object.cpp:790-878): the tx must be mined, every output P2PKH or unspendable,
//    an `OP_RETURN PUSH32(hash)` output worth >= 1 DASH (GOVERNANCE_PROPOSAL_FEE_TX, object.h:87), and >= 6 confirmations
//    (GOVERNANCE_FEE_CONFIRMATIONS, object.h:88) for full acceptance; there is no ChainLock shortcut. With 1..5 confirmations
//    `gobject submit` keeps the object in an in-memory postponed map AND relays it at once (rpc/governance.cpp:396-418); peers
//    postpone it too, and CheckPostponedObjects (governance/governance.cpp:856-887) makes it a full object at 6. So a proposal
//    goes live at 6 either way: submitting earlier only gets it onto the network sooner. Below 6 the relay also needs
//    `chainlock: true` from `getrawtransaction`, so the block cannot be reorganised away; from 6 on Core takes the object in full
//    and no ChainLock is needed (a regtest without quorums behaves as before).
//  - the postponed map is lost when dashd restarts, and `gobject get` sees full objects only (governance.cpp:507-521). So a row sent
//    below 6 stays `waiting` (`sent` = 1) and is looked at again: at 6 `gobject get <hash>` must find it, else it is submitted again.
//  - IsValidLocally replaces every collateral error text with "Invalid proposal collateral" (object.cpp:740-742), so after a refusal
//    of that kind the collateral is looked up again: no longer submittable (a reorg) means wait, otherwise Core refused it.
//  - a known object is accepted silently (AddGovernanceObject returns early, governance/governance.cpp:338) and submit returns
//    its hash, so a resubmit after a lost answer, a crash or a restart is harmless.
// There is no future-time limit on a proposal's `time` in Core (MAX_TIME_FUTURE_DEVIATION applies to triggers only).
//
// Logs never contain a gov hash, a txid, the proposal data or Core's raw message: only the row id and a short code.
// No stored time points back to the second a request arrived (README "Threat model and privacy"): checks are scheduled on a
// PROPOSAL_CHECK_S grid shared by every row, and submitted_at / finished_at are kept to the hour, like received_hour.
import { checkCollateralTx, GOVERNANCE_FEE_CONFIRMATIONS, governanceObjectHash, hexToBytes, validateProposalData } from '@govhub/verify';
import type { RelayConfig } from './config.ts';
import { CoreRpcError, rpcMessage, type CoreClient, type GobjectGetResult, type RawTxVerbose } from './core/rpc.ts';
import type { ProposalRow, Store } from './db.ts';
import { log, type Clock } from './log.ts';

/** Rows (any state) per gov hash: a user may pay a second collateral after the first was dropped. */
export const MAX_PROPOSALS_PER_HASH = 3;
const BATCH = 20;
const TICK_EVERY_S = 5;
const RETRY_BASE_S = 30;
const RETRY_CAP_S = 600;
const CORE_MESSAGE_MAX = 200;
/** RPC_CLIENT_IN_INITIAL_DOWNLOAD (src/rpc/protocol.h:59): `gobject submit` before mnsync is done. */
const RPC_CLIENT_IN_INITIAL_DOWNLOAD = -10;

/** `lastError` codes of a held proposal. Always a short code; Core's own text only travels in `coreMessage` (core-rejected). */
export const PROPOSAL_ERROR = {
  /** waiting: Core did not answer (transport error, timeout, a crash mid-submit); retried 30 s doubling to 10 min */
  coreError: 'core-error',
  /** waiting: Core is not synced with the masternode network yet (-10); retried like core-error */
  coreSyncing: 'core-syncing',
  /** waiting: Core does not know the collateral right now (dropped, double-spent); failed after PROPOSAL_MISSING_S */
  collateralMissing: 'collateral-missing',
  /** waiting: Core refused the collateral and it is no longer deep enough (a reorg) */
  collateralReorg: 'collateral-reorg',
  /** failed: end_epoch passed before the proposal was sent */
  expired: 'expired',
  /** failed: the proposal was not sent (collateral ChainLocked, or 6 deep) within PROPOSAL_MAX_WAIT_S */
  unconfirmed: 'unconfirmed',
  /** failed: Core's bytes for the txid no longer pass checkCollateralTx */
  badCollateral: 'bad-collateral',
  /** failed: Core refused `gobject submit`; `coreMessage` has its text */
  coreRejected: 'core-rejected',
  /** failed: `gobject submit` returned a hash other than the one the relay computed */
  coreHashMismatch: 'core-hash-mismatch',
} as const;

export type CollateralLookup =
  | { kind: 'ok'; confirmations: number; chainlock: boolean }
  /** Core answered with an error: it does not know the transaction (not propagated yet, dropped, double-spent) */
  | { kind: 'missing' }
  /** no answer from Core */
  | { kind: 'down' }
  /** Core answered without usable raw bytes */
  | { kind: 'garbled' }
  | { kind: 'bad'; failure: string | undefined; message: string };

/**
 * `getrawtransaction <txid> true` (needs txindex for mined transactions) and checkCollateralTx on the returned bytes against the
 * gov hash and the txid (so Core's answer must really be that transaction). A mempool tx has no `confirmations`: 0. `chainlock` is
 * Core's flag that a ChainLock covers the block (missing = false).
 */
export async function lookupCollateral(core: CoreClient, txid: string, govHashRaw: Uint8Array): Promise<CollateralLookup> {
  let tx: RawTxVerbose;
  try {
    tx = await core.call<RawTxVerbose>('getrawtransaction', [txid, true]);
  } catch (e) {
    return rpcMessage(e) !== null ? { kind: 'missing' } : { kind: 'down' };
  }
  const raw = typeof tx?.hex === 'string' && /^([0-9a-f]{2})+$/.test(tx.hex) ? hexToBytes(tx.hex) : null;
  if (!raw) return { kind: 'garbled' };
  const col = checkCollateralTx(raw, govHashRaw, { expectedTxid: txid });
  if (!col.valid) return { kind: 'bad', failure: col.failure, message: col.message ?? col.failure ?? 'invalid collateral transaction' };
  return { kind: 'ok', confirmations: typeof tx.confirmations === 'number' ? tx.confirmations : 0, chainlock: tx.chainlock === true };
}

const backoff = (n: number): number => Math.min(RETRY_CAP_S, RETRY_BASE_S * 2 ** Math.min(n, 30));

/** A unix time rounded DOWN to the hour: the only precision stored for when a request arrived or a row finished. */
export const hourOf = (t: number): number => t - (t % 3600);

/** Confirmations as stored: capped at Core's 6, because the real depth would date when the relay looked (receive times are kept to the hour only). */
export const storedConfirmations = (confirmations: number): number => Math.min(Math.max(0, confirmations), GOVERNANCE_FEE_CONFIRMATIONS);

/**
 * May `gobject submit` run now: at least `min` confirmations and, below Core's 6, a ChainLock on the block (Core keeps a 1-5
 * confirmation object postponed; the ChainLock makes sure its collateral cannot be reorganised away).
 */
export const submittable = (c: { confirmations: number; chainlock: boolean }, min: number): boolean =>
  c.confirmations >= min && (c.chainlock || c.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS);
/** the state a row read by check() or claimed by submit() is in, for the conditional update that moves it on */
const fromOf = (r: ProposalRow): 'waiting' | 'submitting' => (r.status === 'submitting' ? 'submitting' : 'waiting');

const govHashRawOf = (r: ProposalRow): Uint8Array => governanceObjectHash({ parentHash: '0', revision: 1, time: r.time, dataHex: r.data_hex }).raw;

export interface ProposerDeps {
  cfg: RelayConfig;
  store: Store;
  core: CoreClient;
  clock: Clock;
}

export class Proposer {
  private readonly cfg: RelayConfig;
  private readonly store: Store;
  private readonly core: CoreClient;
  private readonly clock: Clock;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(d: ProposerDeps) {
    this.cfg = d.cfg;
    this.store = d.store;
    this.core = d.core;
    this.clock = d.clock;
    // a crash between `submitting` and Core's answer: try again now (Core accepts a known object silently)
    const recovered = this.store.recoverSubmitting(d.clock());
    if (recovered) log.warn('proposals left in submitting by a crash went back to waiting', { count: recovered });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => log.error('proposal tick failed', { error: String((e as Error)?.message ?? e) }));
    }, TICK_EVERY_S * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the due waiting rows (oldest next_attempt_at first, BATCH at a time). Nothing runs with PROPOSAL_SUBMIT=0. */
  async tick(): Promise<void> {
    if (this.busy || !this.cfg.proposalSubmit) return;
    this.busy = true;
    try {
      for (const row of this.store.dueProposals(this.clock(), BATCH)) {
        try {
          await this.check(row.id);
        } catch (e) {
          // never let one row stop the batch
          log.error('proposal check crashed', { id: row.id, error: String((e as Error)?.message ?? e) });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(id: string): Promise<void> {
    const row = this.store.getProposal(id);
    if (!row || row.status !== 'waiting') return;
    let now = this.clock();
    // Core's ValidateProposal with fCheckExpiration=true: nothing else in the data can change after it was accepted. Only
    // `gobject submit` checks it, so a row already sent (postponed in Core) is not failed for it.
    if (!row.sent && !validateProposalData(row.data_hex, this.cfg.network, { now }).valid) return this.fail(row, now, PROPOSAL_ERROR.expired);

    const col = await lookupCollateral(this.core, row.collateral_txid, govHashRawOf(row));
    now = this.clock();
    switch (col.kind) {
      case 'down':
      case 'garbled':
        return this.retry(row, now, PROPOSAL_ERROR.coreError);
      case 'bad':
        return this.fail(row, now, PROPOSAL_ERROR.badCollateral);
      case 'missing': {
        const since = row.missing_since ?? now - (now % this.cfg.proposalCheckS);
        if (now - since > this.cfg.proposalMissingS) return this.fail(row, now, PROPOSAL_ERROR.collateralMissing);
        if (this.waitedTooLong(row, now)) return this.fail(row, now, PROPOSAL_ERROR.unconfirmed);
        return this.wait(row, now, { confirmations: 0, code: PROPOSAL_ERROR.collateralMissing, missingSince: since });
      }
      case 'ok':
        if (row.sent) {
          if (col.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS) return this.confirmFull(row, col.confirmations);
          // no `unconfirmed` timeout: Core and its peers hold it postponed and make it live at 6 whatever this row says
          return this.wait(row, now, { confirmations: col.confirmations, code: null });
        }
        if (submittable(col, this.cfg.minCollateralConfs)) return this.submit(row, col.confirmations);
        if (this.waitedTooLong(row, now)) return this.fail(row, now, PROPOSAL_ERROR.unconfirmed);
        return this.wait(row, now, { confirmations: col.confirmations, code: null });
    }
  }

  /**
   * A row sent below 6 confirmations, whose collateral is 6 deep now: Core should have promoted it to a full object. `gobject get`
   * finds it -> submitted; unknown (dashd restarted and lost its postponed copy, or has not promoted it yet) -> submit again, which
   * Core now takes in full.
   */
  private async confirmFull(row: ProposalRow, confirmations: number): Promise<void> {
    let obj: GobjectGetResult;
    try {
      obj = await this.core.call<GobjectGetResult>('gobject', ['get', row.gov_hash]);
    } catch (e) {
      const msg = rpcMessage(e);
      if (msg !== null && /Unknown governance object/i.test(msg)) {
        log.info('sent proposal not in Core at full depth, submitting again', { id: row.id });
        return this.submit(row, confirmations);
      }
      return this.retry(row, this.clock(), PROPOSAL_ERROR.coreError);
    }
    const now = this.clock();
    if (typeof obj !== 'object' || obj === null) return this.retry(row, now, PROPOSAL_ERROR.coreError);
    this.store.markProposalLive(row.id, hourOf(now), storedConfirmations(confirmations));
    log.debug('proposal live', { id: row.id });
  }

  /**
   * waiting -> submitting -> submitted (6+ confirmations) / waiting with `sent` (fewer: Core postponed it) / failed / waiting again.
   * Used by the worker and by POST /v1/proposals when the collateral is already submittable; `confirmations` is the count just
   * read from Core.
   */
  async submit(row: ProposalRow, confirmations: number): Promise<void> {
    // claim the row in one conditional UPDATE, nothing awaited in between: a concurrent pass sees `submitting` and leaves it
    const capped = storedConfirmations(confirmations);
    if (!this.store.markProposalSubmitting(row.id, capped)) return;
    const claimed: ProposalRow = { ...row, status: 'submitting', confirmations: capped };
    try {
      let result: unknown;
      try {
        result = await this.core.call('gobject', ['submit', '0', 1, row.time, row.data_hex, row.collateral_txid]);
      } catch (e) {
        await this.onSubmitError(claimed, e);
        return;
      }
      const now = this.clock();
      if (typeof result === 'string' && result.toLowerCase() === row.gov_hash) {
        if (confirmations >= GOVERNANCE_FEE_CONFIRMATIONS) {
          this.store.markProposalSubmitted(row.id, hourOf(now));
          log.debug('proposal submitted', { id: row.id });
        } else {
          this.store.markProposalSent(row.id, this.at(now, this.cfg.proposalCheckS));
          log.debug('proposal sent, live at 6 confirmations', { id: row.id });
        }
        return;
      }
      this.fail(claimed, now, PROPOSAL_ERROR.coreHashMismatch);
    } finally {
      // whatever went wrong above, a row must not stay `submitting` until the next restart
      if (this.store.getProposal(row.id)?.status === 'submitting') this.retry(claimed, this.clock(), PROPOSAL_ERROR.coreError);
    }
  }

  private async onSubmitError(row: ProposalRow, e: unknown): Promise<void> {
    const msg = rpcMessage(e);
    let now = this.clock();
    // no answer (transport error, timeout): Core may or may not have it; a resubmit is harmless
    if (msg === null) return this.retry(row, now, PROPOSAL_ERROR.coreError);
    if ((e instanceof CoreRpcError && e.code === RPC_CLIENT_IN_INITIAL_DOWNLOAD) || /Must wait for client to sync/i.test(msg)) {
      return this.retry(row, now, PROPOSAL_ERROR.coreSyncing);
    }
    // IsValidLocally reports every collateral problem as "Invalid proposal collateral" (object.cpp:740-742); the bytes passed
    // checkCollateralTx, so ask Core again how deep the transaction is: a reorg means wait, still submittable means a refusal.
    if (/Invalid proposal collateral|confirmations|not mined|Can't find collateral/i.test(msg)) {
      const col = await lookupCollateral(this.core, row.collateral_txid, govHashRawOf(row));
      now = this.clock();
      if (col.kind === 'down' || col.kind === 'garbled') return this.retry(row, now, PROPOSAL_ERROR.coreError);
      if (col.kind === 'bad') return this.fail(row, now, PROPOSAL_ERROR.badCollateral);
      if (col.kind === 'missing' || !submittable(col, this.cfg.minCollateralConfs)) {
        const confirmations = col.kind === 'ok' ? col.confirmations : 0;
        this.wait(row, now, { confirmations, code: PROPOSAL_ERROR.collateralReorg });
        log.warn('proposal collateral lost confirmations', { id: row.id, code: PROPOSAL_ERROR.collateralReorg });
        return;
      }
    }
    this.fail(row, now, PROPOSAL_ERROR.coreRejected, msg.slice(0, CORE_MESSAGE_MAX));
  }

  /** Measured from the hour the row was received (the only receive time kept), so it may end up to an hour early. */
  private waitedTooLong(row: ProposalRow, now: number): boolean {
    return now >= row.received_hour + this.cfg.proposalMaxWaitS;
  }

  /**
   * The next check: `delay` from now, rounded down onto the PROPOSAL_CHECK_S grid (never now or earlier). A row checked in every
   * slot is checked exactly every PROPOSAL_CHECK_S, and the stored time says nothing about when it was received.
   */
  private at(now: number, delay: number): number {
    const g = this.cfg.proposalCheckS;
    const t = Math.floor((now + delay) / g) * g;
    return t > now ? t : t + g;
  }

  /** Still waiting (or waiting again after a submit), next look PROPOSAL_CHECK_S on; resets the error backoff. */
  private wait(row: ProposalRow, now: number, w: { confirmations: number; code: string | null; missingSince?: number | null }): void {
    this.store.proposalWait(row.id, fromOf(row), { confirmations: Math.max(0, w.confirmations), at: this.at(now, this.cfg.proposalCheckS), code: w.code, failN: 0, missingSince: w.missingSince ?? null });
  }

  /** Not a failure: (submitting ->) waiting, try again after a backoff of 30 s doubling to 10 min (on the check grid). */
  private retry(row: ProposalRow, now: number, code: string): void {
    this.store.proposalWait(row.id, fromOf(row), { confirmations: row.confirmations, at: this.at(now, backoff(row.fail_n)), code, failN: row.fail_n + 1, missingSince: row.missing_since });
    log.warn('proposal retry', { id: row.id, code, failN: row.fail_n + 1 });
  }

  private fail(row: ProposalRow, now: number, code: string, coreMessage: string | null = null): void {
    this.store.failProposal(row.id, hourOf(now), code, coreMessage);
    log.warn('proposal failed', { id: row.id, code });
  }
}
