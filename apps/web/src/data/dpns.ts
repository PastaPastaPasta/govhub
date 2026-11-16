// DPNS usernames (alice.dash) of identities, the primary way govhub names a person. Lookups are batched: every id asked for within
// one tick goes into proved `records.identity in [...]` queries on the DPNS domain documents, a chunk of ids per query, and each
// answer is cached for the page's life. An identity with several names is shown by its first registered one (earliest $createdAt,
// then the label), the same in every view. A failed read is not cached as "no name": the next ask reads again.

/** The fields of a DPNS domain document a name is picked from (document JSON, as evo-sdk gives it). */
export interface DomainDoc {
  $id?: unknown;
  $ownerId?: unknown;
  $createdAt?: unknown;
  label?: unknown;
  normalizedLabel?: unknown;
  normalizedParentDomainName?: unknown;
  records?: { identity?: unknown } | null;
}

// DPNS's own label rule: 3 to 63 letters, digits and hyphens, not starting or ending with a hyphen.
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]$/;

const createdAt = (d: DomainDoc): number => {
  const v = d.$createdAt;
  const n = typeof v === 'number' ? v : typeof v === 'bigint' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/** The identity a domain document names as its own: a `.dash` name whose record points at its owner. Null for anything else. */
export function domainIdentity(d: DomainDoc): string | null {
  const id = d.records?.identity;
  if (typeof id !== 'string' || !id) return null;
  if (d.$ownerId !== undefined && d.$ownerId !== id) return null;
  if (d.normalizedParentDomainName !== 'dash' || typeof d.label !== 'string' || !LABEL.test(d.label)) return null;
  return id;
}

/** `identityId`'s primary name among `docs`: its first registered `.dash` name, as "label.dash"; undefined when it has none. */
export function primaryName(identityId: string, docs: readonly DomainDoc[]): string | undefined {
  const mine = docs.filter((d) => domainIdentity(d) === identityId);
  if (!mine.length) return undefined;
  const key = (d: DomainDoc) => String(d.normalizedLabel ?? (d.label as string).toLowerCase());
  mine.sort((a, b) => createdAt(a) - createdAt(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return `${mine[0]!.label as string}.dash`;
}

/** One page of domain documents whose `records.identity` is one of `ids`, ordered by it, after the document `startAfter`. */
export type DomainQuery = (ids: readonly string[], page: { limit: number; startAfter?: string }) => Promise<DomainDoc[]>;

export interface DpnsResolver {
  /** The primary DPNS name of each of these identities that has one. Rejects only when no id could be read. */
  names(ids: readonly string[]): Promise<Map<string, string>>;
}

export interface ResolverOptions {
  /** ids per query (Platform takes at most 100 values in an `in` clause) */
  chunk?: number;
  /** documents per page */
  limit?: number;
  /** pages per chunk at most: an identity holding hundreds of names cannot keep the reader paging */
  maxPages?: number;
}

export function createDpnsResolver(query: DomainQuery, o: ResolverOptions = {}): DpnsResolver {
  const chunk = o.chunk ?? 25;
  const limit = o.limit ?? 100;
  const maxPages = o.maxPages ?? 5;
  const cache = new Map<string, Promise<string | undefined>>();
  let queue: Array<{ id: string; resolve(n: string | undefined): void; reject(e: unknown): void }> = [];

  /** Every page up to `maxPages`; `complete` is false when more may follow. */
  async function readChunk(ids: string[]): Promise<{ docs: DomainDoc[]; complete: boolean }> {
    const docs: DomainDoc[] = [];
    let startAfter: string | undefined;
    for (let p = 0; p < maxPages; p++) {
      const page = await query(ids, { limit, ...(startAfter ? { startAfter } : {}) });
      docs.push(...page);
      const last = page[page.length - 1]?.$id;
      if (page.length < limit || typeof last !== 'string') return { docs, complete: true };
      startAfter = last;
    }
    return { docs, complete: false };
  }

  /**
   * The names of `ids`. Pages run in `records.identity` order, so an identity holding hundreds of names can use up the pages before
   * the ids after it are reached: those (none of their names read yet) are asked again on their own.
   */
  async function resolveChunk(ids: string[]): Promise<Map<string, string | undefined>> {
    const { docs, complete } = await readChunk(ids);
    const out = new Map(ids.map((id) => [id, primaryName(id, docs)] as const));
    const unseen = complete ? [] : ids.filter((id) => !docs.some((d) => domainIdentity(d) === id));
    if (unseen.length && unseen.length < ids.length) for (const [id, n] of await resolveChunk(unseen)) out.set(id, n);
    return out;
  }

  function flush() {
    const batch = queue;
    queue = [];
    for (let i = 0; i < batch.length; i += chunk) {
      const part = batch.slice(i, i + chunk);
      resolveChunk(part.map((x) => x.id)).then(
        (names) => part.forEach((x) => x.resolve(names.get(x.id))),
        (e: unknown) =>
          part.forEach((x) => {
            cache.delete(x.id);
            x.reject(e);
          }),
      );
    }
  }

  function lookup(id: string): Promise<string | undefined> {
    let p = cache.get(id);
    if (!p) {
      p = new Promise((resolve, reject) => {
        if (!queue.length) setTimeout(flush, 0);
        queue.push({ id, resolve, reject });
      });
      cache.set(id, p);
    }
    return p;
  }

  return {
    async names(ids) {
      const unique = [...new Set(ids)].filter(Boolean);
      const out = new Map<string, string>();
      const read = await Promise.allSettled(unique.map(lookup));
      read.forEach((r, i) => r.status === 'fulfilled' && r.value && out.set(unique[i]!, r.value));
      const failed = read.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed && read.every((r) => r.status === 'rejected')) throw failed.reason;
      return out;
    },
  };
}
