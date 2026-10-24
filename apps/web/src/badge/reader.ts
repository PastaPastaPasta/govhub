// Badge reading (PLAN §8.6): proved queries only, trusted issuers only. For each trusted issuer and each epoch displayed at the
// current core height: the issuerKey (and any revocation) is accepted by @govhub/badge's reader rules, then the authors' badges are
// fetched and verified one by one. An identity shows at most one badge per issuer, never a count, never summed across issuers.
//
// Audit: an issuer whose verified badge count for an epoch exceeds its own issuerReport (tokensIssued) is flagged and its badges
// for that epoch are not shown. Reports appear when the epoch's issuance window has closed, i.e. from S(E) on.
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import type { AcceptedIssuerKey, BadgeNetwork, ReaderConfig } from '@govhub/badge';
import type { TrustedIssuer } from './config.ts';
import { allBadges, badgeQuery, badgesOfAuthors, issuerKeyQuery, reportQuery, revocationQuery, type BadgeQueryResult } from './queries.ts';
import type { Registry } from '../config/registry.ts';

type Badge = typeof import('@govhub/badge');
export type Query = (q: DocQuery) => Promise<BadgeQueryResult>;

export interface IssuerEpochAudit {
  issuer: TrustedIssuer;
  epoch: number;
  /** verified badges counted (capped at `maxAuditPages` x 100) */
  badges: number;
  complete: boolean;
  /** the issuer's own count, null until it publishes the report */
  tokensIssued: number | null;
  flagged: boolean;
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
}

/** Caches accepted keys and audits per (issuer, epoch) for the life of the reader (one per network/contract/trust list). */
export class BadgeReader {
  readonly #net: BadgeNetwork;
  readonly #contractId: string;
  readonly #query: Query;
  readonly #issuers: TrustedIssuer[];
  readonly #maxAuditPages: number;
  #badge: Promise<Badge> | null = null;
  readonly #keys = new Map<string, Promise<{ key: AcceptedIssuerKey | null; problem: string | null }>>();
  readonly #audits = new Map<string, Promise<IssuerEpochAudit>>();

  constructor(o: { net: BadgeNetwork; contractId: string; query: Query; issuers: TrustedIssuer[] } & ReaderOptions) {
    this.#net = o.net;
    this.#contractId = o.contractId;
    this.#query = o.query;
    this.#issuers = o.issuers.filter((i) => i.enabled);
    this.#maxAuditPages = o.maxAuditPages ?? 20;
  }

  #lib(): Promise<Badge> {
    return (this.#badge ??= import('@govhub/badge'));
  }

  async #cfg(): Promise<ReaderConfig> {
    const b = await this.#lib();
    return { net: this.#net, contractId: b.idToBytes(this.#contractId) };
  }

  /** The proved, accepted key of (issuer, epoch), or why there is none. */
  key(issuer: TrustedIssuer, epoch: number): Promise<{ key: AcceptedIssuerKey | null; problem: string | null }> {
    const k = `${issuer.identityId}:${epoch}`;
    let p = this.#keys.get(k);
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
      // only an accepted key is kept: a failed read or a missing/invalid key is looked up again next time
      p.then((r) => r.key || this.#keys.delete(k), () => this.#keys.delete(k));
      this.#keys.set(k, p);
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
        const audit = await this.audit(issuer, epoch, now);
        if (audit.flagged) continue;
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

  /** Counts the issuer's verified badges for the epoch against its issuerReport. */
  audit(issuer: TrustedIssuer, epoch: number, coreHeight: number): Promise<IssuerEpochAudit> {
    const k = `${issuer.identityId}:${epoch}`;
    let p = this.#audits.get(k);
    if (!p) {
      p = (async () => {
        const b = await this.#lib();
        const base = { issuer, epoch };
        const { key, problem } = await this.key(issuer, epoch);
        if (!key) return { ...base, badges: 0, complete: true, tokensIssued: null, flagged: false, keyProblem: problem };
        const cfg = await this.#cfg();
        let count = 0;
        let after: string | undefined;
        let pages = 0;
        let complete = false;
        while (pages < this.#maxAuditPages) {
          const res = await this.#query(allBadges(issuer.identityId, epoch, after));
          pages++;
          for (const d of res.docs) {
            try {
              if ((await b.verifyMnBadge(cfg, key, b.parseMnBadgeDoc(d), coreHeight)).ok) count++;
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
        const rep = await this.#query(reportQuery(issuer.identityId, epoch));
        let tokensIssued: number | null = null;
        try {
          tokensIssued = rep.docs[0] ? b.parseIssuerReportDoc(rep.docs[0]).tokensIssued : null;
        } catch {
          tokensIssued = null;
        }
        return { ...base, badges: count, complete, tokensIssued, flagged: tokensIssued !== null && count > tokensIssued, keyProblem: null };
      })();
      p.catch(() => this.#audits.delete(k));
      this.#audits.set(k, p);
    }
    return p;
  }

  /** Whether any trusted issuer has at least one valid, unflagged badge displayed now (the "MN owners" filter is meaningful). */
  async live(coreHeight?: number): Promise<boolean> {
    const b = await this.#lib();
    const now = coreHeight ?? (await this.coreHeight());
    for (const issuer of this.#issuers) {
      for (const epoch of b.displayEpochsAt(b.EPOCH_PARAMS[this.#net], now)) {
        const a = await this.audit(issuer, epoch, now);
        if (!a.flagged && a.badges > 0) return true;
      }
    }
    return false;
  }
}

export function createBadgeReader(r: Registry, contractId: string, issuers: TrustedIssuer[]): BadgeReader {
  return new BadgeReader({ net: r.platformNetwork, contractId, issuers, query: (q) => badgeQuery(r, contractId, q) });
}
