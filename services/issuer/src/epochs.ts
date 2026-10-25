// Epoch housekeeping, run on a timer: which key may sign, destroying keys and token rows of closed windows, and the per-epoch
// issuerReport. Every step works from the dashd tip; the issuerKey check reads Platform with proofs. EpochKeys (the key part) is
// shared with the starter issuer (starter-epochs.ts).
import { deriveKeyId, epochOf, epochStart, equalBytes, issuingEpochsAt, keyDeadline, reportWindow, toHex, VARIANT, type EpochParams, type IssuerKeyDoc } from '@govhub/badge';
import type { IdentityKeyFile } from './config.ts';
import type { CoreView, MnLists } from './core.ts';
import { storeWindowFrom, type TokenStore } from './db.ts';
import { destroyKey, keyEpochs, loadKey } from './keys.ts';
import { errText, log } from './log.ts';
import type { IssuerPlatform } from './platform.ts';
import type { ActiveKey } from './service.ts';
import { BlindSigner } from './signer.ts';

/**
 * The other issuer identity on this server (badge vs starter). Blind signatures are separated by KEY only: the issuer never sees what
 * it signs, so the message tags (govhub-badge vs govhub-starter) protect nothing on the signer's side. A key that signs for both would
 * let any masternode turn a badge request into starter tokens, and a proposal owner a starter request into an MN badge.
 */
export interface OtherIssuer {
  /** 'badge' or 'starter', in problem texts */
  label: string;
  issuerId: string;
  /** keyIds the other side has loaded right now (any epoch) */
  activeKeyIds(): Uint8Array[];
}

/**
 * Why `keyId` (this side's key for `epoch`) must not be used, or null: it equals a key the other side has loaded, or ANY proved
 * issuerKey the other identity published for epoch-1 or later (one proved range query; a key reused for a distant epoch would
 * still let one side's requests mint the other's tokens there). Epochs before epoch-1 are not checked: their keys were destroyed
 * when their windows closed, so they can sign nothing. Fails closed when Platform cannot answer.
 */
export async function keyConflict(platform: IssuerPlatform, other: OtherIssuer, epoch: number, keyId: Uint8Array): Promise<string | null> {
  const clash = `the key of epoch ${epoch} is also a ${other.label} key: refused (badge and starter keys must differ)`;
  if (other.activeKeyIds().some((k) => equalBytes(k, keyId))) return clash;
  let docs;
  try {
    docs = await platform.issuerKeysFrom(other.issuerId, Math.max(1, epoch - 1));
  } catch (err) {
    return `could not check the key of epoch ${epoch} against the ${other.label} keys: ${errText(err)}`;
  }
  return docs.some((d) => equalBytes(d.keyId, keyId)) ? clash : null;
}

export interface EpochKeysDeps {
  params: EpochParams;
  issuerId: string;
  keyDir: string;
  maxStagedKeys: number;
  /** null until Platform is reachable */
  platform: () => IssuerPlatform | null;
  /** in log lines: 'signing key' (badge) or 'starter key' */
  label: string;
  /**
   * Called for every epoch whose issuerKey readers accept, whether or not this server holds its key file (the badge side opens the
   * epoch then, so its report is still published).
   */
  onPublished?: (epoch: number, doc: IssuerKeyDoc) => void;
  /** A last check before a key may sign (the badge token store's start height); a problem, or null. */
  canSign?: (epoch: number, doc: IssuerKeyDoc) => string | null;
  /** called once per key that is ready to sign, with its proved document */
  onLoad?: (epoch: number, doc: IssuerKeyDoc) => void;
  /** the other issuer identity on this server, whose keys this one must never share (keyConflict) */
  other?: () => OtherIssuer | null;
}

/**
 * The per-epoch private keys of one issuer identity (badge or starter): ISSUER_KEY_DIR / STARTER_KEY_DIR. Loads the key of an
 * issuing epoch only if it matches the proved issuerKey document (present, created before keyDeadline = S(E+1) - margin, so it may
 * be published late, variant, keyId = SHA256(spki), private key matches the SPKI), refuses to sign while more later keys are staged
 * than allowed, and destroys keys whose window closed. A missing key is retried every tick until it is ready.
 */
export class EpochKeys {
  readonly #d: EpochKeysDeps;
  /** ready keys by epoch: at most the current and the next one */
  readonly #active = new Map<number, ActiveKey>();
  #blocked = false;

  constructor(deps: EpochKeysDeps) {
    this.#d = deps;
  }

  activeKey(epoch: number): ActiveKey | null {
    return this.#blocked ? null : (this.#active.get(epoch) ?? null);
  }

  /** keyIds of the loaded keys (for the other side's keyConflict) */
  activeKeyIds(): Uint8Array[] {
    return [...this.#active.values()].map((k) => k.keyId);
  }

  /** hex keyId per epoch with a ready key */
  keyIds(): Record<number, string> {
    return Object.fromEntries([...this.#active].map(([e, k]) => [e, toHex(k.keyId)]));
  }

  get ready(): boolean {
    return !this.#blocked && this.#active.size > 0;
  }

  /** Signs nothing until the next refresh (a syncing dashd). */
  block(): void {
    this.#blocked = true;
  }

  /** Keys of epochs whose issuance window closed (at S(E+1), plus the reorg margin) are destroyed. */
  destroyClosed(height: number, current: number): void {
    const d = this.#d;
    for (const e of keyEpochs(d.keyDir)) {
      if (e < current && height >= epochStart(d.params, e + 1) + d.params.boundaryMarginBlocks) {
        // a file the service cannot remove (wrong owner, read-only directory) must not stop the rest of the housekeeping
        try {
          destroyKey(d.keyDir, e);
          log.info(`destroyed the ${d.label} of a closed epoch`, { epoch: e });
        } catch (err) {
          log.error(`could not destroy the ${d.label} of a closed epoch: remove it by hand`, { epoch: e, error: errText(err) });
        }
      }
    }
  }

  /**
   * Drops keys outside [current, next], applies the staged-key limit, and loads the missing keys of the issuing epochs.
   * Returns the problems (empty when every issuing epoch has a ready key).
   */
  async refresh(current: number, next: number, skip?: (epoch: number) => string | null): Promise<string[]> {
    const d = this.#d;
    // the server signs with the keys of the current and the next epoch; staged keys are those after them
    for (const e of [...this.#active.keys()]) if (e !== current && e !== next) this.#active.delete(e);
    const staged = keyEpochs(d.keyDir).filter((e) => e > next);
    const problems: string[] = [];
    this.#blocked = staged.length > d.maxStagedKeys;
    if (this.#blocked) problems.push(`${staged.length} keys for later epochs are on the server (max ${d.maxStagedKeys}): remove them`);
    else
      for (const e of [current, next]) {
        // e.g. the badge store refuses a closed epoch, so no key is ready for it (and /v1/info does not list it)
        const skipped = skip?.(e);
        if (skipped) {
          this.#active.delete(e);
          problems.push(skipped);
          continue;
        }
        if (this.#active.has(e)) continue;
        const p = await this.#load(e);
        if (p) problems.push(p);
      }
    return problems;
  }

  /**
   * Loads the private key for `epoch` and checks it against the proved issuerKey document. Returns a problem or null. Runs every
   * tick until the key is ready: a key may be published at any time before keyDeadline, and signing starts at the next tick.
   */
  async #load(epoch: number): Promise<string | null> {
    const d = this.#d;
    let priv;
    try {
      priv = loadKey(d.keyDir, epoch);
    } catch (e) {
      return errText(e);
    }
    const platform = d.platform();
    if (!platform) return priv ? 'Platform is not reachable' : `no key file for epoch ${epoch}`;
    let doc;
    try {
      doc = await platform.issuerKey(d.issuerId, epoch);
    } catch (e) {
      return `Platform: ${errText(e)}`;
    }
    const deadline = keyDeadline(d.params, epoch);
    if (!doc) return priv ? `no issuerKey document for epoch ${epoch} on Platform yet: publish it with \`issuer publish-keys\` (offline, CRITICAL key) before height ${deadline}` : `no key file for epoch ${epoch}`;
    if (doc.createdAtCoreBlockHeight >= deadline) return `the issuerKey of epoch ${epoch} was published too late (at or after ${deadline}); readers would reject its signatures`;
    if (doc.variant !== VARIANT || !equalBytes(doc.keyId, await deriveKeyId(doc.spki))) return `the issuerKey of epoch ${epoch} has another variant or keyId != SHA256(spki)`;
    let signer: BlindSigner | null = null;
    if (priv) {
      try {
        signer = new BlindSigner(priv);
      } catch (e) {
        return `key file of epoch ${epoch}: ${errText(e)}`;
      }
      // The slot is unique and immutable, so a different key there is final (README "Revoking a key").
      if (!equalBytes(signer.spki, doc.spki)) return `CONFLICT: the key file of epoch ${epoch} does not match the published SPKI; if you did not publish that issuerKey, the CRITICAL key is compromised`;
    }
    // Readers accept this key whether or not this server can sign with it.
    d.onPublished?.(epoch, doc);
    if (!signer) return `no key file for epoch ${epoch}, although an issuerKey is published for it (keyId ${toHex(doc.keyId)}): if it is in manifest.json, copy epoch-${epoch}.pem here; if not, the CRITICAL key is compromised`;
    // the cheap local refusal first: it needs no Platform read and gives the clearer reason
    const refused = d.canSign?.(epoch, doc);
    if (refused) return refused;
    const other = d.other?.();
    if (other) {
      const clash = await keyConflict(platform, other, epoch, doc.keyId);
      if (clash) return clash;
    }
    this.#active.set(epoch, { epoch, keyId: doc.keyId, signer, keyCreatedAt: doc.createdAtCoreBlockHeight });
    d.onLoad?.(epoch, doc);
    log.info(`${d.label} ready`, { epoch, keyId: toHex(doc.keyId), modulusBits: signer.modulusBytes * 8 });
    return null;
  }
}

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
  /** the starter identity, when this server also issues starters: its keys are never loaded as badge keys */
  other?: () => OtherIssuer | null;
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

/**
 * The first step of both housekeeping ticks (badge and starter): the dashd tip and whether dashd has caught up. Returns the status to
 * publish when the tick must stop here, else the tip and the epochs being issued. A syncing node's tip is not the network's: no
 * start height, no lists, no issuing until it has caught up (N8), so its keys are blocked. An unreachable Core keeps the last status.
 */
export async function readCore(
  core: Pick<CoreView, 'tipHeight' | 'synced'>,
  params: EpochParams,
  keys: EpochKeys,
  last: EpochStatus,
): Promise<{ stop: EpochStatus } | { height: number; current: number; next: number }> {
  let height: number;
  try {
    height = await core.tipHeight();
  } catch (e) {
    return { stop: { ...last, ready: false, problem: `Core: ${errText(e)}` } };
  }
  const [current, next] = issuingEpochsAt(params, height);
  const synced = await core.synced().catch((e: unknown) => `getblockchaininfo failed: ${errText(e)}`);
  if (synced !== true) {
    keys.block();
    return { stop: { height, issuingEpochs: [current, next], keyIds: {}, ready: false, problem: typeof synced === 'string' ? synced : 'dashd is not synced' } };
  }
  return { height, current, next };
}

/**
 * The newest epoch whose issuance window [S(E-1), S(E+1)) ended at least `margin` blocks before `height`: closing it and
 * everything before it can never cut off a window that is still open at the tip (0: nothing to close).
 */
export const closableThrough = (p: EpochParams, height: number): number => Math.max(0, epochOf(p, Math.max(0, height - p.boundaryMarginBlocks)) - 1);

export class EpochManager {
  readonly #d: EpochManagerDeps;
  readonly #keys: EpochKeys;
  #status: EpochStatus = { height: null, issuingEpochs: [], keyIds: {}, ready: false, problem: 'starting' };

  constructor(deps: EpochManagerDeps) {
    this.#d = deps;
    this.#keys = new EpochKeys({ params: deps.params, issuerId: deps.issuerId, keyDir: deps.keyDir, maxStagedKeys: deps.maxStagedKeys, platform: deps.platform, label: 'signing key',
      // Readers accept a published key, so readers expect E's report: the epoch is opened (a report with 0 tokens if this server
      // never signs), since a missing one would flag the issuer for E and hide its badges for E+1.
      onPublished: (e) => deps.store.openEpoch(e),
      // A store that started after E's window opened and its key was published cannot know the tokens issued before (lost or reset).
      canSign: (e, doc) => {
        const started = deps.store.startedHeight();
        return started !== null && started > storeWindowFrom(deps.params, e, doc.createdAtCoreBlockHeight)
          ? `the token store started at height ${started}, after epoch ${e}'s window opened and its key was published (at ${doc.createdAtCoreBlockHeight}): it cannot know tokens issued before, so it issues again from epoch ${e + 1}`
          : null;
      },
      other: deps.other,
    });
  }

  /** keyIds of the loaded badge keys (the starter side refuses them) */
  activeKeyIds(): Uint8Array[] {
    return this.#keys.activeKeyIds();
  }

  get status(): EpochStatus {
    return this.#status;
  }

  activeKey(epoch: number): ActiveKey | null {
    return this.#keys.activeKey(epoch);
  }

  async tick(): Promise<void> {
    const d = this.#d;
    const core = await readCore(d.core, d.params, this.#keys, this.#status);
    if ('stop' in core) {
      this.#status = core.stop;
      return;
    }
    const { height, current, next } = core;
    if (d.store.startedHeight() === null) {
      // Platform's core height can lead this dashd's tip: start from the higher one, so a key published before the store started
      // never looks newer than it (storeWindowFrom). Without a Platform height, wait: nothing is issued without Platform anyway.
      const ph = await d.platform()?.coreHeight().catch(() => null);
      if (Number.isSafeInteger(ph) && ph! > 0) d.store.markStarted(Math.max(height, ph!));
    }
    try {
      // a token for E needs the MN valid at S(E-1): S(current-1) and S(current)
      await d.lists.refresh([epochStart(d.params, current - 1), epochStart(d.params, current)], d.params.boundaryMarginBlocks);
    } catch (e) {
      log.warn('masternode list refresh failed', { error: errText(e) });
    }

    this.#keys.destroyClosed(height, current);
    // Token rows of closed windows are deleted; only the per-epoch count stays.
    const closable = closableThrough(d.params, height);
    if (closable >= 1) {
      const n = d.store.closeThrough(closable);
      if (n) log.info('deleted token records of closed epochs', { throughEpoch: closable, rows: n });
    }
    // An epoch closed while its window is still open (a store carried over from code that closed E at S(E), before tokens for E
    // could be issued during E) is reopened if no token was ever issued for it, so a key published later can still sign.
    const reopened = d.store.reopenAboveCloseMark();
    if (reopened.length) log.warn('reopened epochs that an older closing rule closed although their issuance window is open (no tokens had been issued)', { epochs: reopened });
    const closedThrough = d.store.closedThrough();

    // the store refuses a closed epoch, so no key is ready for it (and /v1/info does not list it)
    const problems = await this.#keys.refresh(current, next, (e) =>
      closedThrough !== null && e <= closedThrough
        ? `the token store is closed through epoch ${closedThrough}, although epoch ${e}'s issuance window is open; it is not reopened because epoch ${closedThrough} had tokens (their rows are deleted) or a recorded issuerReport, or was closed at a higher tip`
        : null,
    );
    const problem = problems.length ? problems.join('; ') : null;
    // once per change, not every tick
    if (problem && problem !== this.#status.problem) log.error('issuance (partly) unavailable', { epochs: [current, next], problem });
    this.#status = { height, issuingEpochs: [current, next], keyIds: this.#keys.keyIds(), ready: this.#keys.ready, problem };

    await this.#report().catch((e) => log.warn('issuerReport failed', { error: errText(e) }));
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
