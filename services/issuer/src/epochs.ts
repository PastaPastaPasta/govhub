// Epoch housekeeping, run on a timer: which key may sign, destroying keys and token rows of closed windows, and the per-epoch
// issuerReport. Every step works from the dashd tip; the issuerKey check reads Platform with proofs.
import { epochStart, equalBytes, issuingEpochAt, keyDeadline, sha256, toHex, type EpochParams } from '@govhub/badge';
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
  core: Pick<CoreView, 'tipHeight'>;
  /** refreshed every tick: the current MN list and the S(E-1) snapshot of the issuing epoch */
  lists: MnLists;
  store: TokenStore;
  /** null until Platform is reachable */
  platform: () => IssuerPlatform | null;
  reportKey: IdentityKeyFile | null;
}

export interface EpochStatus {
  height: number | null;
  issuingEpoch: number | null;
  keyId: string | null;
  ready: boolean;
  problem: string | null;
}

export class EpochManager {
  readonly #d: EpochManagerDeps;
  #active: ActiveKey | null = null;
  #status: EpochStatus = { height: null, issuingEpoch: null, keyId: null, ready: false, problem: 'starting' };

  constructor(deps: EpochManagerDeps) {
    this.#d = deps;
  }

  get status(): EpochStatus {
    return this.#status;
  }

  activeKey(epoch: number): ActiveKey | null {
    return this.#active && this.#active.epoch === epoch && this.#status.ready ? this.#active : null;
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
    const epoch = issuingEpochAt(d.params, height);
    const margin = d.params.boundaryMarginBlocks;
    d.store.markStarted(height);
    try {
      await d.lists.refresh(epochStart(d.params, epoch - 1), margin);
    } catch (e) {
      log.warn('masternode list refresh failed', { error: errText(e) });
    }

    // Keys of epochs whose issuance window closed (plus the reorg margin) are destroyed.
    for (const e of keyEpochs(d.keyDir)) {
      if (e < epoch && height >= epochStart(d.params, e) + margin) {
        destroyKey(d.keyDir, e);
        log.info('destroyed the key of a closed epoch', { epoch: e });
      }
    }
    // Token rows of closed windows are deleted; only the per-epoch count stays.
    const closable = height >= epochStart(d.params, epoch - 1) + margin ? epoch - 1 : epoch - 2;
    if (closable >= 1) {
      const n = d.store.closeThrough(closable);
      if (n) log.info('deleted token records of closed epochs', { throughEpoch: closable, rows: n });
    }

    const staged = keyEpochs(d.keyDir).filter((e) => e > epoch);
    let problem: string | null = null;
    if (staged.length > d.maxStagedKeys) problem = `${staged.length} keys for later epochs are on the server (max ${d.maxStagedKeys}): remove them`;
    else if (this.#active?.epoch !== epoch) problem = await this.#load(epoch);
    if (problem) {
      if (this.#active?.epoch !== epoch) this.#active = null;
      // once per change, not every tick
      if (problem !== this.#status.problem) log.error('issuance unavailable', { epoch, problem });
    }
    this.#status = { height, issuingEpoch: epoch, keyId: this.#active ? toHex(this.#active.keyId) : null, ready: !problem && !!this.#active, problem };

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
    if (!equalBytes(doc.keyId, await sha256(doc.spki))) return `the issuerKey of epoch ${epoch} has keyId != SHA256(spki)`;
    let signer: BlindSigner;
    try {
      signer = new BlindSigner(priv, { expectedSpki: doc.spki });
    } catch (e) {
      return `key file of epoch ${epoch}: ${errText(e)}`;
    }
    this.#active = { epoch, keyId: doc.keyId, signer };
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
      const tokensIssued = d.store.issued(epoch);
      const id = await platform.publishIssuerReport(d.reportKey, { epoch, tokensIssued });
      d.store.markReported(epoch, id);
      log.info('issuerReport published', { epoch, tokensIssued });
    }
  }
}
