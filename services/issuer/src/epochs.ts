// Epoch housekeeping, run on a timer: which key may sign, destroying keys and token rows of closed windows, and the per-epoch
// issuerReport. Every step works from the dashd tip; the issuerKey check reads Platform with proofs.
import { deriveKeyId, epochStart, equalBytes, issuingEpochsAt, keyDeadline, reportWindow, toHex, type EpochParams } from '@govhub/badge';
import type { IdentityKeyFile } from './config.ts';
import type { CoreView, MnLists } from './core.ts';
import type { TokenStore } from './db.ts';
import { destroyKey, keyEpochs, loadKey } from './keys.ts';
import { errText, log } from './log.ts';
import type { IssuerPlatform } from './platform.ts';
import type { ActiveKey } from './service.ts';
import { BlindSigner } from './signer.ts';

export interface EpochManagerDeps {
  params: EpochParams;
  issuerId: string;
  keyDir: string;
  maxStagedKeys: number;
  core: Pick<CoreView, 'tipHeight' | 'synced'>;
  /** refreshed every tick: the current MN list and the S(E-1) snapshot of the issuing epoch */
  lists: MnLists;
  store: TokenStore;
  /** null until Platform is reachable */
  platform: () => IssuerPlatform | null;
  reportKey: IdentityKeyFile | null;
}

export interface EpochStatus {
  height: number | null;
  /** the current epoch (Standard mode) and the next one (private modes) */
  issuingEpochs: number[];
  /** hex keyId per issuing epoch that has a ready key */
  keyIds: Record<number, string>;
  /** at least one issuing epoch has a ready key */
  ready: boolean;
  problem: string | null;
}

export class EpochManager {
  readonly #d: EpochManagerDeps;
  /** ready keys by epoch: at most the current and the next one */
  #active = new Map<number, ActiveKey>();
  #status: EpochStatus = { height: null, issuingEpochs: [], keyIds: {}, ready: false, problem: 'starting' };
  #blocked = false;

  constructor(deps: EpochManagerDeps) {
    this.#d = deps;
  }

  get status(): EpochStatus {
    return this.#status;
  }

  activeKey(epoch: number): ActiveKey | null {
    return this.#blocked ? null : (this.#active.get(epoch) ?? null);
  }

  async tick(): Promise<void> {
    const d = this.#d;
    let height: number;
    try {
      height = await d.core.tipHeight();
    } catch (e) {
      this.#status = { ...this.#status, ready: false, problem: `Core: ${errText(e)}` };
      return;
    }
    const [current, next] = issuingEpochsAt(d.params, height);
    const margin = d.params.boundaryMarginBlocks;
    // A syncing node's tip is not the network's: no start height, no lists, no issuing until it has caught up (N8).
    const synced = await d.core.synced().catch((e: unknown) => `getblockchaininfo failed: ${errText(e)}`);
    if (synced !== true) {
      this.#blocked = true;
      this.#status = { height, issuingEpochs: [current, next], keyIds: {}, ready: false, problem: typeof synced === 'string' ? synced : 'dashd is not synced' };
      return;
    }
    d.store.markStarted(height);
    try {
      // a token for E needs the MN valid at S(E-1): S(current-1) and S(current)
      await d.lists.refresh([epochStart(d.params, current - 1), epochStart(d.params, current)], margin);
    } catch (e) {
      log.warn('masternode list refresh failed', { error: errText(e) });
    }

    // Keys of epochs whose issuance window closed (at S(E+1), plus the reorg margin) are destroyed.
    for (const e of keyEpochs(d.keyDir)) {
      if (e < current && height >= epochStart(d.params, e + 1) + margin) {
        // a file the service cannot remove (wrong owner, read-only directory) must not stop the rest of the housekeeping
        try {
          destroyKey(d.keyDir, e);
          log.info('destroyed the key of a closed epoch', { epoch: e });
        } catch (err) {
          log.error('could not destroy the key of a closed epoch: remove it by hand', { epoch: e, error: errText(err) });
        }
      }
    }
    // Token rows of closed windows are deleted; only the per-epoch count stays.
    const closable = height >= epochStart(d.params, current) + margin ? current - 1 : current - 2;
    if (closable >= 1) {
      const n = d.store.closeThrough(closable);
      if (n) log.info('deleted token records of closed epochs', { throughEpoch: closable, rows: n });
    }

    // the server signs with the keys of the current and the next epoch; staged keys are those after them
    for (const e of [...this.#active.keys()]) if (e !== current && e !== next) this.#active.delete(e);
    const staged = keyEpochs(d.keyDir).filter((e) => e > next);
    const problems: string[] = [];
    this.#blocked = staged.length > d.maxStagedKeys;
    if (this.#blocked) problems.push(`${staged.length} keys for later epochs are on the server (max ${d.maxStagedKeys}): remove them`);
    else
      for (const e of [current, next]) {
        if (this.#active.has(e)) continue;
        const p = await this.#load(e);
        if (p) problems.push(p);
      }
    const problem = problems.length ? problems.join('; ') : null;
    // once per change, not every tick
    if (problem && problem !== this.#status.problem) log.error('issuance (partly) unavailable', { epochs: [current, next], problem });
    const keyIds = Object.fromEntries([...this.#active].map(([e, k]) => [e, toHex(k.keyId)]));
    this.#status = { height, issuingEpochs: [current, next], keyIds, ready: !this.#blocked && this.#active.size > 0, problem };

    await this.#report().catch((e) => log.warn('issuerReport failed', { error: errText(e) }));
  }

  /** Loads the private key for `epoch` and checks it against the proved issuerKey document. Returns a problem or null. */
  async #load(epoch: number): Promise<string | null> {
    const d = this.#d;
    let priv;
    try {
      priv = loadKey(d.keyDir, epoch);
    } catch (e) {
      return errText(e);
    }
    if (!priv) return `no key file for epoch ${epoch}`;
    const platform = d.platform();
    if (!platform) return 'Platform is not reachable';
    let doc;
    try {
      doc = await platform.issuerKey(d.issuerId, epoch);
    } catch (e) {
      return `Platform: ${errText(e)}`;
    }
    if (!doc) return `no issuerKey document for epoch ${epoch} on Platform`;
    if (doc.createdAtCoreBlockHeight >= keyDeadline(d.params, epoch)) return `the issuerKey of epoch ${epoch} was published too late; readers would reject every badge`;
    if (!equalBytes(doc.keyId, await deriveKeyId(doc.spki))) return `the issuerKey of epoch ${epoch} has keyId != SHA256(spki)`;
    let signer: BlindSigner;
    try {
      signer = new BlindSigner(priv, { expectedSpki: doc.spki });
    } catch (e) {
      return `key file of epoch ${epoch}: ${errText(e)}`;
    }
    this.#active.set(epoch, { epoch, keyId: doc.keyId, signer });
    d.store.openEpoch(epoch);
    log.info('signing key ready', { epoch, keyId: toHex(doc.keyId), modulusBits: signer.modulusBytes * 8 });
    return null;
  }

  /** issuerReport for each closed epoch (PLAN §8.4 rule 8): tokens issued, published after the window closed. */
  async #report(): Promise<void> {
    const d = this.#d;
    const platform = d.platform();
    if (!platform || !d.reportKey) return;
    for (const epoch of d.store.unreported()) {
      const existing = await platform.issuerReport(d.issuerId, epoch);
      if (existing) {
        // A report this server did not write (another instance, or a compromised key) is final on Platform: raise the alarm.
        if (existing.tokensIssued !== d.store.issued(epoch)) log.error('the published issuerReport differs from this server’s count', { epoch, published: existing.tokensIssued, counted: d.store.issued(epoch) });
        d.store.markReported(epoch, 'existing');
        continue;
      }
      // Tokens for E can be issued until S(E+1), so readers accept a report created in [S(E+1), S(E+1)+W] of PLATFORM's core
      // height, which can lag the dashd tip (N7).
      const ph = await platform.coreHeight();
      const w = reportWindow(d.params, epoch);
      if (ph < w.from) continue;
      if (ph > w.to) log.error('issuerReport is late: readers will flag this epoch', { epoch, platformCoreHeight: ph });
      const tokensIssued = d.store.issued(epoch);
      const id = await platform.publishIssuerReport(d.reportKey, { epoch, tokensIssued });
      d.store.markReported(epoch, id);
      log.info('issuerReport published', { epoch, tokensIssued });
    }
  }
}
