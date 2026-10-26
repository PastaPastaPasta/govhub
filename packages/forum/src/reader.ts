// Typed reads over any DocReader (evo-sdk with proofs in the app, an in-memory store in fixtures and tests). Every
// query comes from queries.ts, so it has passed the PV13 lint before it is sent.
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import { convertAll, num, toAttestation, toBlock, toBlockSubs, toClaim, toComment, toPost, toProfile, toReaction, type RawDoc } from './convert.ts';
import { attestationsOf, blocksOf, blockSubsOf, claimsOf, commentsNewestOf, commentsSince, myReactionsOn, PAGE, postOf, profilesOf, reactionsOn, type ContractQuery, type DescStep } from './queries.ts';
import type { Block, BlockSubs, Claim, ClaimAttestation, Comment, ContractKey, Profile, ProposalPost, Reaction } from './types.ts';

export interface DocPage {
  docs: RawDoc[];
  /** Platform height the result was proven at, when known. */
  height: number | null;
}

/** The one primitive the data layer needs: run a (linted) query against a contract. */
export interface DocReader {
  query(contract: ContractKey, q: DocQuery): Promise<DocPage>;
}

/** Upper bound on pages per list, so a spammed proposal cannot make a reader loop forever (100 × 100 docs). */
export const MAX_PAGES = 100;

/** Runs a paged shape until a short page, following `startAfter` with the last document id. */
export async function pageAll(reader: DocReader, build: (startAfter?: string) => ContractQuery, maxPages = MAX_PAGES): Promise<DocPage & { truncated: boolean }> {
  const docs: RawDoc[] = [];
  let height: number | null = null;
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { contract, q } = build(cursor);
    const page = await reader.query(contract, q);
    height = page.height ?? height;
    docs.push(...page.docs);
    const last = page.docs.at(-1)?.$id;
    if (page.docs.length < PAGE || typeof last !== 'string') return { docs, height, truncated: false };
    cursor = last;
  }
  return { docs, height, truncated: true };
}

/**
 * Runs a newest-first shape (desc on `key`, see DescStep) to the end. Each next page asks for `key <= ` the last page's lowest key and
 * skips the ids already read, so documents that share that key (one block time) are read again, never lost. When a whole page sits at one
 * key t (PAGE or more documents at one block time), t is finished with an ascending `key == t` sweep paged by `startAfter`, then the read
 * goes on below t: a burst in one block cannot hide anything older. `truncated` only when `maxPages` queries were not enough.
 */
export async function pageDesc(reader: DocReader, build: (step: DescStep) => ContractQuery, key: string, maxPages = MAX_PAGES): Promise<DocPage & { truncated: boolean }> {
  const docs: RawDoc[] = [];
  const seen = new Set<string>();
  let height: number | null = null;
  let step: DescStep = { op: 'first' };
  for (let i = 0; i < maxPages; i++) {
    const { contract, q } = build(step);
    const page = await reader.query(contract, q);
    height = page.height ?? height;
    for (const d of page.docs) {
      const id = d.$id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      docs.push(d);
    }
    const full = page.docs.length >= PAGE;
    const first = page.docs[0];
    const last = page.docs.at(-1);
    if (step.op === '==') {
      // the sweep of one key: on to the next sweep page, or below the key once the sweep is done
      if (full && typeof last?.$id === 'string') step = { op: '==', t: step.t, startAfter: last.$id };
      else step = { op: '<', t: step.t };
      continue;
    }
    if (!full || !first || !last) return { docs, height, truncated: false };
    let lo: number;
    let hi: number;
    try {
      lo = num(last, key);
      hi = num(first, key);
    } catch {
      return { docs, height, truncated: true }; // no usable key to bound the next page by
    }
    step = hi === lo ? { op: '==', t: lo } : { op: '<=', t: lo };
  }
  return { docs, height, truncated: true };
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class ForumReader {
  constructor(private readonly reader: DocReader) {}

  private async one({ contract, q }: ContractQuery): Promise<DocPage> {
    return this.reader.query(contract, q);
  }

  /**
   * A proposal's comments, read newest first (F2c, paged by 100 with pageDesc) so a flood can only push the oldest out of the read,
   * never hide new ones; `truncated` when more than `maxPages` pages exist. Returned oldest first, for threading.
   */
  async comments(govHash: string, maxPages = MAX_PAGES): Promise<{ comments: Comment[]; height: number | null; truncated: boolean }> {
    const r = await pageDesc(this.reader, (s) => commentsNewestOf(govHash, s), '$createdAt', maxPages);
    return { comments: convertAll(r.docs, toComment).filter((x) => x.govHash === govHash).reverse(), height: r.height, truncated: r.truncated };
  }

  /**
   * Comments created at or after `sinceMs` (F2d), for incremental counts. Includes `sinceMs` itself, since several comments can share
   * one block time: callers skip the ids they already hold.
   */
  async commentsSince(govHash: string, sinceMs: number): Promise<Comment[]> {
    const r = await pageAll(this.reader, (c) => commentsSince(govHash, sinceMs, c));
    return convertAll(r.docs, toComment).filter((x) => x.govHash === govHash && x.createdAt >= sinceMs);
  }

  /** Profiles of these identities (F1b, 100 per query). */
  async profiles(ids: readonly string[]): Promise<Map<string, Profile>> {
    const out = new Map<string, Profile>();
    for (const batch of chunk([...new Set(ids)], PAGE)) {
      for (const p of convertAll((await this.one(profilesOf(batch))).docs, toProfile)) if (batch.includes(p.ownerId)) out.set(p.ownerId, p);
    }
    return out;
  }

  /** Every reaction on one target (F6, paged). `target` is base64 (see targetB64). */
  async reactions(target: string): Promise<Reaction[]> {
    return convertAll((await pageAll(this.reader, (c) => reactionsOn(target, c))).docs, toReaction);
  }

  /** My reactions among these targets (F5b, 100 per query), by target hex. */
  async myReactions(ownerId: string, targets: readonly string[]): Promise<Map<string, Reaction>> {
    const out = new Map<string, Reaction>();
    for (const batch of chunk([...new Set(targets)], PAGE)) {
      for (const r of convertAll((await this.one(myReactionsOn(ownerId, batch))).docs, toReaction)) if (r.ownerId === ownerId) out.set(r.target, r);
    }
    return out;
  }

  async claims(govHash: string): Promise<Claim[]> {
    return convertAll((await pageAll(this.reader, (c) => claimsOf(govHash, c))).docs, toClaim).filter((x) => x.govHash === govHash);
  }

  async attestations(govHash: string): Promise<ClaimAttestation[]> {
    return convertAll((await pageAll(this.reader, (c) => attestationsOf(govHash, c))).docs, toAttestation).filter((x) => x.govHash === govHash);
  }

  /** The post `ownerId` wrote for a proposal (F8), or null. */
  async post(govHash: string, ownerId: string): Promise<ProposalPost | null> {
    return convertAll((await this.one(postOf(govHash, ownerId))).docs, toPost).find((p) => p.ownerId === ownerId && p.govHash === govHash) ?? null;
  }

  /** One block list (M1 for `mod`, F10 for `forum`), every page. */
  async blocks(contract: 'forum' | 'mod', ownerId: string): Promise<Block[]> {
    return convertAll((await pageAll(this.reader, (c) => blocksOf(contract, ownerId, c))).docs, toBlock).filter((b) => b.ownerId === ownerId);
  }

  async blockSubs(ownerId: string): Promise<BlockSubs | null> {
    return convertAll((await this.one(blockSubsOf(ownerId))).docs, toBlockSubs)[0] ?? null;
  }
}
