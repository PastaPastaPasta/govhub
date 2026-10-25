// Starter housekeeping, on the same timer as the badge EpochManager: the starter identity's per-epoch keys (EpochKeys: loaded only
// against the proved issuerKey, staged-key limit, destroyed once their window closed), the valid-proposal cache, clearing the retry
// columns of closed windows, and the public key list the faucet redeems against (GET /v1/starter/info).
//
// The key list holds the epochs starterRedeemEpochs(tip) = [current-1, current, next] that have a proved issuerKey of the STARTER
// identity passing the reader rules (acceptIssuerKey, as the browser checks it) and no issuerRevocation. current-1 is listed after
// its private key was destroyed: its tokens stay redeemable for a whole epoch ("redeem later"). The browser never blinds against
// this list (it reads the proved document itself); the faucet trusts it because we run both. No issuerReport for starters: the
// count would only tell how many masternodes and proposal owners took part, and readers have nothing to audit it against.
import { acceptIssuerKey, idToBytes, starterRedeemEpochs, type BadgeNetwork, type EpochParams, type IssuerKeyDoc } from '@govhub/badge';
import type { CoreView, ProposalCache } from './core.ts';
import { defaultMaxTipLead } from './config.ts';
import { closableThrough, EpochKeys, keyConflict, readCore, TipGuard, type EpochStatus, type OtherIssuer } from './epochs.ts';
import { errText, log } from './log.ts';
import type { IssuerPlatform } from './platform.ts';
import type { ActiveKey } from './service.ts';
import type { StarterStore } from './starter-db.ts';

export interface StarterManagerDeps {
  network: BadgeNetwork;
  params: EpochParams;
  /** the badge contract (starter keys are issuerKey documents in it) */
  contractId: string;
  /** the starter identity */
  issuerId: string;
  keyDir: string;
  maxStagedKeys: number;
  core: Pick<CoreView, 'tipHeight' | 'synced'>;
  proposals: Pick<ProposalCache, 'refresh'>;
  store: Pick<StarterStore, 'closeThrough'>;
  /** null until Platform is reachable */
  platform: () => IssuerPlatform | null;
  /** the badge identity of this server: a starter key equal to one of its keys is neither loaded nor listed (keyConflict) */
  other?: () => OtherIssuer | null;
  /** blocks the dashd tip may lead Platform's core height before the irreversible steps wait (checkTip); default defaultMaxTipLead */
  maxTipLead?: number;
}

export interface StarterPublicKey {
  epoch: number;
  keyId: Uint8Array;
  spki: Uint8Array;
}

export class StarterManager {
  readonly #d: StarterManagerDeps;
  readonly #keys: EpochKeys;
  readonly #issuerBytes: Uint8Array;
  readonly #contractBytes: Uint8Array;
  /** proved documents of the keys EpochKeys loaded (saves a second read for the list) */
  readonly #loaded = new Map<number, IssuerKeyDoc>();
  /** the redeemable keys, by epoch; only epochs in the redeem window */
  readonly #published = new Map<number, StarterPublicKey>();
  /**
   * epochs with an issuerRevocation of the starter identity: never signed for or listed again (a revocation is immutable). Never
   * pruned (a few epochs at most): pruning by a garbage-high tip would forget one, and the next tick would load its key again
   */
  readonly #revoked = new Set<number>();
  /** epochs whose issuerKey failed the reader rules, with the reason last logged (warn once per change, not every tick) */
  readonly #refused = new Map<number, string>();
  readonly #guard: TipGuard;
  #status: EpochStatus = { height: null, issuingEpochs: [], keyIds: {}, ready: false, problem: 'starting' };
  /** the issuance problems last logged (the tip guard logs its own) */
  #logged: string | null = null;

  constructor(deps: StarterManagerDeps) {
    this.#d = deps;
    this.#guard = new TipGuard('starter housekeeping', deps.maxTipLead ?? defaultMaxTipLead(deps.params));
    this.#issuerBytes = idToBytes(deps.issuerId);
    this.#contractBytes = idToBytes(deps.contractId);
    // No canSign check: unlike the badge token store (one row per MN per epoch, refused when the store is newer than the epoch's
    // window), the starter store dedups for life and has no start-height notion. A lost starter store re-opens every starter
    // (README "Back up the starter store"); the faucet's daily budget bounds that.
    this.#keys = new EpochKeys({ params: deps.params, issuerId: deps.issuerId, keyDir: deps.keyDir, maxStagedKeys: deps.maxStagedKeys, platform: deps.platform, label: 'starter key', onLoad: (e, doc) => this.#loaded.set(e, doc), other: deps.other });
  }

  /** keyIds of the loaded starter keys (the badge side refuses them) */
  activeKeyIds(): Uint8Array[] {
    return this.#keys.activeKeyIds();
  }

  get status(): EpochStatus {
    return this.#status;
  }

  activeKey(epoch: number): ActiveKey | null {
    return this.#revoked.has(epoch) ? null : this.#keys.activeKey(epoch);
  }

  /** The keys the faucet accepts, oldest first. */
  keys(): StarterPublicKey[] {
    return [...this.#published.values()].sort((a, b) => a.epoch - b.epoch);
  }

  async tick(): Promise<void> {
    const d = this.#d;
    const core = await readCore(d.core, d.params, this.#keys, this.#status);
    if ('stop' in core) {
      this.#status = core.stop;
      return;
    }
    const { height, current, next } = core;
    // the masternode list is refreshed by the badge EpochManager on the same timer; proposals here
    try {
      await d.proposals.refresh();
    } catch (e) {
      log.warn('proposal list refresh failed', { error: errText(e) });
    }

    for (const e of this.#loaded.keys()) if (e < current) this.#loaded.delete(e);
    const tip = await this.#guard.check(d.platform(), height);
    if ('platformHeight' in tip) {
      this.#keys.destroyClosed(height, current);
      // The retry columns of closed windows are cleared; the dedup keys stay for life.
      const closable = closableThrough(d.params, height);
      if (closable >= 1) {
        const n = d.store.closeThrough(closable);
        if (n) log.info('cleared starter retry data of closed epochs', { throughEpoch: closable, rows: n });
      }
    }

    const problems = await this.#keys.refresh(current, next);
    await this.#refreshPublished(height, problems).catch((e) => problems.push(`starter key list: ${errText(e)}`));
    for (const e of [current, next]) if (this.#revoked.has(e)) problems.push(`the starter key of epoch ${e} is revoked`);
    const keyProblem = problems.join('; ') || null;
    if (keyProblem && keyProblem !== this.#logged) log.error('starter issuance (partly) unavailable', { epochs: [current, next], problem: keyProblem });
    this.#logged = keyProblem;
    // issuance goes on while the irreversible steps wait (README "Tip check")
    if ('problem' in tip) problems.unshift(tip.problem);
    const problem = problems.join('; ') || null;
    const keyIds = Object.fromEntries(Object.entries(this.#keys.keyIds()).filter(([e]) => !this.#revoked.has(Number(e))));
    this.#status = { height, issuingEpochs: [current, next], keyIds, ready: this.#keys.ready && Object.keys(keyIds).length > 0, problem };
  }

  #refuse(epoch: number, reason: string, problems: string[]): void {
    if (this.#refused.get(epoch) !== reason) log.warn('a starter issuerKey is refused: not listed', { epoch, reason });
    this.#refused.set(epoch, reason);
    problems.push(`epoch ${epoch}: ${reason}`);
  }

  /** The redeem window's keys: proved issuerKey (from a loaded key, else read), reader rules, revocation (re-read every tick). */
  async #refreshPublished(height: number, problems: string[]): Promise<void> {
    const d = this.#d;
    const want = starterRedeemEpochs(d.params, height);
    for (const e of [...this.#published.keys()]) if (!want.includes(e)) this.#published.delete(e);
    for (const e of [...this.#refused.keys()]) if (!want.includes(e)) this.#refused.delete(e);
    const platform = d.platform();
    if (!platform) {
      if (this.#published.size === 0) throw new Error('Platform is not reachable');
      return; // keep what was proved before
    }
    const cfg = { net: d.network, contractId: this.#contractBytes, params: d.params };
    for (const e of want) {
      if (this.#revoked.has(e)) continue;
      if (!this.#published.has(e)) {
        const doc = this.#loaded.get(e) ?? (await platform.issuerKey(d.issuerId, e));
        if (!doc) continue; // not published (yet): nothing for this epoch can be redeemed
        const v = await acceptIssuerKey(cfg, { issuerId: this.#issuerBytes, epoch: e }, [doc]);
        if (!v.ok) {
          this.#refuse(e, v.reason, problems);
          continue;
        }
        // a key the badge side also uses is never offered for redemption either (loaded keys were checked when they loaded)
        const other = this.#loaded.has(e) ? null : d.other?.();
        const conflict = other ? await keyConflict(platform, other, e, v.value.key.keyId) : null;
        if (conflict) {
          this.#refuse(e, conflict, problems);
          continue;
        }
        this.#refused.delete(e);
        this.#published.set(e, { epoch: e, keyId: v.value.key.keyId, spki: v.value.key.spki });
      }
      // Any revocation of the epoch is final (fail closed, like the browser): neither signed for nor redeemed any more.
      if (await platform.issuerRevocation(d.issuerId, e)) {
        this.#revoked.add(e);
        this.#published.delete(e);
        log.error('a starter key is revoked: no longer signed with or listed', { epoch: e });
      }
    }
  }
}
