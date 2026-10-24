// Badge reading (PLAN §8.6): proved queries only, trusted issuers only. For each trusted issuer and each epoch displayed at the
// current core height: the issuerKey (and any revocation) is accepted by @govhub/badge's reader rules, then the authors' badges are
// fetched and verified one by one. An identity shows at most one badge per issuer, never a count, never summed across issuers.
//
// Audit: an issuer whose verified badge count for an epoch exceeds its own issuerReport (tokensIssued) is flagged and its badges
// for that epoch are not shown. Tokens for E can be issued until S(E+1) (Standard mode asks during E), so a report counts only if
// it was created in [S(E+1), S(E+1)+W] (a stolen report key cannot fix future counts in advance) and is plausible (not more
// tokens than masternodes). Once S(E+1)+W has passed without a valid report the issuer is flagged as unaudited. Because E's
// report arrives only as E ends, a flag on E-1 also hides the issuer's badges for E.
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import type { AcceptedIssuerKey, BadgeNetwork, ReaderConfig } from '@govhub/badge';
import { BADGE_NETWORKS, type TrustedIssuer } from './config.ts';
import { allBadges, badgeQuery, badgesOfAuthors, issuerKeyQuery, reportQuery, revocationQuery, type BadgeQueryResult } from './queries.ts';
import type { Registry } from '../config/registry.ts';
import { platformDapiConfig } from '../auth/runtime.ts';
import { badgeWorker } from './workerClient.ts';

type Badge = typeof import('@govhub/badge');
export type Query = (q: DocQuery) => Promise<BadgeQueryResult>;
/** The accepted key of an (issuer, epoch), or why there is none. */
export type KeyLookup = { key: AcceptedIssuerKey | null; problem: string | null };

export interface IssuerEpochAudit {
  issuer: TrustedIssuer;
  epoch: number;
  /** verified badges counted (capped at `maxAuditPages` x 100) */
  badges: number;
  complete: boolean;
  /** the issuer's own count from a valid report, null while there is none */
  tokensIssued: number | null;
  flagged: boolean;
  /** why it is flagged */
  flagReason: string | null;
  /** why the issuer has nothing valid for this epoch, when that is the case */
  keyProblem: string | null;
}

export interface BadgeView {
  /** ownerId -> names of the trusted issuers that vouch for it (each issuer at most once) */
  byOwner: Map<string, string[]>;
  coreHeight: number;
}

export interface ReaderOptions {
  maxAuditPages?: number;
  /** reports above this are implausible when the proven list is not available (default 5,000) */
  maxPlausibleTokens?: number;
  /**
   * The masternode count of the PROVEN list (anchored chain, SML checked against the CbTx), or null when it cannot be proven now.
   * It bounds a plausible issuerReport; the pinned maxPlausibleTokens is the fallback.
   */
  provenMasternodes?: () => Promise<number | null>;
  /** cache lifetime of accepted keys and unfinished audits (default 10 min) */
  ttlMs?: number;
}

const TTL_MS = 10 * 60_000;

/** Caches accepted keys and audits per (issuer, epoch) for the life of the reader (one per network/contract/trust list). */
export class BadgeReader {
  readonly #net: BadgeNetwork;
  readonly #contractId: string;
  readonly #query: Query;
  readonly #issuers: TrustedIssuer[];
  readonly #maxAuditPages: number;
  readonly #maxPlausible: number;
  readonly #proven: (() => Promise<number | null>) | undefined;
  #provenCount: Promise<number | null> | null = null;
  readonly #ttl: number;
  #badge: Promise<Badge> | null = null;
  readonly #keys = new Map<string, { at: number; p: Promise<KeyLookup> }>();
  readonly #audits = new Map<string, { at: number; final: boolean; p: Promise<IssuerEpochAudit> }>();

  constructor(o: { net: BadgeNetwork; contractId: string; query: Query; issuers: TrustedIssuer[] } & ReaderOptions) {
    this.#net = o.net;
    this.#contractId = o.contractId;
    this.#query = o.query;
    this.#issuers = o.issuers.filter((i) => i.enabled);
    this.#maxPlausible = o.maxPlausibleTokens ?? 5_000;
    this.#proven = o.provenMasternodes;
    // the audit must be able to count past the plausible bound (N4); the bound is never above the pinned one
    this.#maxAuditPages = o.maxAuditPages ?? Math.ceil((this.#maxPlausible + 1) / 100);
    this.#ttl = o.ttlMs ?? TTL_MS;
  }

  #lib(): Promise<Badge> {
    return (this.#badge ??= import('@govhub/badge'));
  }

  async #cfg(): Promise<ReaderConfig> {
    const b = await this.#lib();
    return { net: this.#net, contractId: b.idToBytes(this.#contractId) };
  }

  /** The proved, accepted key of (issuer, epoch), or why there is none. */
  key(issuer: TrustedIssuer, epoch: number): Promise<KeyLookup> {
    const k = `${issuer.identityId}:${epoch}`;
    const hit = this.#keys.get(k);
    let p = hit && Date.now() - hit.at < this.#ttl ? hit.p : undefined;
    if (!p) {
      p = (async () => {
        const b = await this.#lib();
        const [kd, rv] = await Promise.all([this.#query(issuerKeyQuery(issuer.identityId, epoch)), this.#query(revocationQuery(issuer.identityId, epoch))]);
        let doc = null;
        let rev = null;
        try {
          doc = kd.docs[0] ? b.parseIssuerKeyDoc(kd.docs[0]) : null;
          rev = rv.docs[0] ? b.parseIssuerRevocationDoc(rv.docs[0]) : null;
        } catch (e) {
          return { key: null, problem: `malformed issuer document: ${(e as Error).message}` };
        }
        const v = await b.acceptIssuerKey(await this.#cfg(), { issuerId: b.idToBytes(issuer.identityId), epoch }, doc, rev);
        return v.ok ? { key: v.value, problem: null } : { key: null, problem: v.reason };
      })();
      // only an accepted key is kept, and only for the TTL (a revocation can come later); anything else is read again next time
      const entry = { at: Date.now(), p };
      p.then((r) => r.key || this.#keys.get(k) !== entry || this.#keys.delete(k), () => this.#keys.get(k) === entry && this.#keys.delete(k));
      this.#keys.set(k, entry);
    }
    return p;
  }

  /** The current core height, from a cheap proved read. */
  async coreHeight(): Promise<number> {
    // any proved query carries the height; this one matches nothing (the contract id as an owner id, epoch 0)
    return (await this.#query(reportQuery(this.#contractId, 0))).coreHeight;
  }

  /** Verified badges of `authors` (any number; queried 100 at a time). */
  async badgesFor(authors: string[], coreHeight?: number): Promise<BadgeView> {
    const b = await this.#lib();
    const now = coreHeight ?? (await this.coreHeight());
    const byOwner = new Map<string, string[]>();
    const uniq = [...new Set(authors)].sort();
    const cfg = await this.#cfg();
    for (const issuer of this.#issuers) {
      const vouched = new Set<string>();
      for (const epoch of b.displayEpochsAt(b.EPOCH_PARAMS[this.#net], now)) {
        const { key } = await this.key(issuer, epoch);
        if (!key) continue;
        // E's report exists only once E's issuance window has closed (S(E+1)), so an issuer caught on the previous epoch stays
        // distrusted for this one too
        const audit = await this.audit(issuer, epoch, now);
        if (audit.flagged) continue;
        if (epoch > 1 && (await this.audit(issuer, epoch - 1, now)).flagged) continue;
        for (let i = 0; i < uniq.length; i += 100) {
          const res = await this.#query(badgesOfAuthors(issuer.identityId, epoch, uniq.slice(i, i + 100)));
          for (const d of res.docs) {
            let doc;
            try {
              doc = b.parseMnBadgeDoc(d);
            } catch {
              continue;
            }
            const v = await b.verifyMnBadge(cfg, key, doc, now);
            if (v.ok) vouched.add(b.bytesToId(doc.ownerId));
          }
        }
      }
      for (const owner of vouched) byOwner.set(owner, [...(byOwner.get(owner) ?? []), issuer.name]);
    }
    return { byOwner, coreHeight: now };
  }

  /** tokensIssued of the issuer's report for the epoch if the report is valid (created in [S(E+1), S(E+1)+W]), else null. */
  async reportedTokens(issuer: Pick<TrustedIssuer, 'identityId'>, epoch: number): Promise<number | null> {
    const b = await this.#lib();
    const p = b.EPOCH_PARAMS[this.#net];
    const rep = await this.#query(reportQuery(issuer.identityId, epoch));
    if (!rep.docs[0]) return null;
    try {
      const r = b.parseIssuerReportDoc(rep.docs[0]);
      const w = b.reportWindow(p, epoch);
      if (r.epoch !== epoch || r.createdAtCoreBlockHeight < w.from || r.createdAtCoreBlockHeight > w.to) return null;
      return r.tokensIssued;
    } catch {
      return null;
    }
  }

  /** Counts the issuer's verified badges for the epoch against its issuerReport. */
  audit(issuer: TrustedIssuer, epoch: number, coreHeight: number): Promise<IssuerEpochAudit> {
    const k = `${issuer.identityId}:${epoch}`;
    const hit = this.#audits.get(k);
    if (hit && (hit.final || Date.now() - hit.at < this.#ttl)) return hit.p;
    const entry = { at: Date.now(), final: false, p: null as unknown as Promise<IssuerEpochAudit> };
    entry.p = (async (): Promise<IssuerEpochAudit> => {
      const b = await this.#lib();
      const base = { issuer, epoch };
      const { key, problem } = await this.key(issuer, epoch);
      if (!key) return { ...base, badges: 0, complete: true, tokensIssued: null, flagged: false, flagReason: null, keyProblem: problem };
      const cfg = await this.#cfg();
      // count the badges that were valid in E's display window, also when auditing a past epoch (the sticky flag below)
      const at = Math.min(coreHeight, b.displayWindow(b.EPOCH_PARAMS[this.#net], epoch).to);
      // A revocation cannot shrink the count after the fact (that would clear a flag), but badges made after the revocation was
      // published (a key thief) do not count: the cut-off is the later of its effective height and its own creation height.
      const auditKey = { ...key, revokedFrom: key.revokedFrom === null ? null : Math.max(key.revokedFrom, key.revocationCreatedAt ?? 0) };
      let count = 0;
      let after: string | undefined;
      let pages = 0;
      let complete = false;
      while (pages < this.#maxAuditPages) {
        const res = await this.#query(allBadges(issuer.identityId, epoch, after));
        pages++;
        for (const d of res.docs) {
          try {
            if ((await b.verifyMnBadge(cfg, auditKey, b.parseMnBadgeDoc(d), at)).ok) count++;
          } catch {
            /* malformed: not counted */
          }
        }
        if (res.docs.length < 100) {
          complete = true;
          break;
        }
        after = String(res.docs[res.docs.length - 1]!.$id);
      }
      const tokensIssued = await this.reportedTokens(issuer, epoch);
      const bound = await this.#bound();
      const reportDue = coreHeight > b.reportWindow(b.EPOCH_PARAMS[this.#net], epoch).to;
      let flagReason: string | null = null;
      if (tokensIssued !== null && tokensIssued > bound.value) flagReason = `reported ${tokensIssued} tokens, more than there are masternodes (${bound.source})`;
      else if (tokensIssued !== null && count > tokensIssued) flagReason = `${count} valid badges but only ${tokensIssued} tokens reported`;
      else if (tokensIssued === null && reportDue) flagReason = 'no valid issuerReport for this epoch';
      else if (tokensIssued !== null && !complete) flagReason = 'too many badges to audit';
      // before E's report can exist (it comes at S(E+1)), at least the badge count must stay plausible
      else if (tokensIssued === null && count > bound.value) flagReason = `more valid badges than there are masternodes (${bound.source})`;
      // accepted risk: anyone with very many identities could post junk badges to push an epoch past the count limit
      else if (tokensIssued === null && !complete) flagReason = 'too many badges to audit';
      // only a flag is final: badge counts only grow and a report is immutable; anything else is re-read after the TTL (N3)
      entry.final = flagReason !== null;
      return { ...base, badges: count, complete, tokensIssued, flagged: flagReason !== null, flagReason, keyProblem: null };
    })();
    entry.p.catch(() => this.#audits.get(k) === entry && this.#audits.delete(k));
    this.#audits.set(k, entry);
    return entry.p;
  }

  /**
   * The largest plausible token count: the proven masternode count plus 5% for registrations during the epoch, capped by the pinned
   * bound; the pinned bound alone when the list cannot be proven.
   */
  async #bound(): Promise<{ value: number; source: string }> {
    if (this.#proven && !this.#provenCount) {
      this.#provenCount = this.#proven().catch(() => null);
      void this.#provenCount.then((c) => c === null && (this.#provenCount = null)); // try again next time
    }
    const n = this.#provenCount ? await this.#provenCount : null;
    return n === null ? { value: this.#maxPlausible, source: 'pinned bound' } : { value: Math.min(this.#maxPlausible, Math.ceil(n * 1.05) + 5), source: `proven list of ${n}` };
  }

  /** Whether any trusted issuer has at least one valid, unflagged badge displayed now (the "MN owners" filter is meaningful). */
  async live(coreHeight?: number): Promise<boolean> {
    const b = await this.#lib();
    const now = coreHeight ?? (await this.coreHeight());
    for (const issuer of this.#issuers) {
      for (const epoch of b.displayEpochsAt(b.EPOCH_PARAMS[this.#net], now)) {
        const a = await this.audit(issuer, epoch, now);
        const prevFlagged = epoch > 1 && (await this.audit(issuer, epoch - 1, now)).flagged;
        if (!a.flagged && !prevFlagged && a.badges > 0) return true;
      }
    }
    return false;
  }
}

export function createBadgeReader(r: Registry, contractId: string, issuers: TrustedIssuer[]): BadgeReader {
  return new BadgeReader({
    net: r.platformNetwork,
    contractId,
    issuers,
    query: (q) => badgeQuery(r, contractId, q),
    maxPlausibleTokens: BADGE_NETWORKS[r.platformNetwork].maxPlausibleTokens,
    // the proven list of the Platform network's Core chain, from the badge worker (same anchored chain and cache as verification)
    // a weak chain (testnet: proof of work is not secure) is not proof: the pinned bound applies; 30 s at most
    provenMasternodes: async () => {
      const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), 30_000));
      const r2 = await Promise.race([badgeWorker({ kind: 'provenMasternodes', dapi: platformDapiConfig(r) }), timeout]);
      return r2 && !r2.weak ? r2.count : null;
    },
  });
}
