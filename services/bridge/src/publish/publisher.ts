// Publishes `proposal`, `tally` and `cycle` documents to the gov contract. Idempotent and restart-safe:
//  - the archive (platform_docs) remembers every published document id / revision / content;
//  - without a local record the document is looked up on Platform by its unique index first (G1 / G5b / G6b);
//  - after a failed create the unique index is re-queried before retrying, so a create that landed is never duplicated.
// Query shapes follow packages/contracts-v1/README.md (PV13 rules: base64 byteArray values, equality on the unique index).
import { createHash } from 'node:crypto';
import type { DB, GovObjectRow, PlatformDocRow } from '../archive/db.ts';
import type { BridgeConfig } from '../config.ts';
import { errText, log } from '../log.ts';
import { proposalView } from '../proposal.ts';
import type { ComputedTally, CoreComparison, TallyRun } from '../tally.ts';
import { displayHashB64, displayHashBytes, type PlatformClient, type PlatformDoc } from './platform.ts';

export type DocType = 'proposal' | 'tally' | 'cycle';

export interface PublishSummary {
  created: number;
  replaced: number;
  unchanged: number;
  adopted: number;
  held: number;
  failed: number;
  skipped: Array<{ type: DocType; key: string; reason: string }>;
  creditsBefore: string | null;
  creditsAfter: string | null;
}

/** Plain values -> canonical JSON for change detection (bigint as string, bytes as hex). */
function canonical(props: Record<string, unknown>, omit: string[] = []): string {
  const keys = Object.keys(props).filter((k) => !omit.includes(k)).sort();
  return JSON.stringify(keys.map((k) => [k, props[k]]), (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
}
const contentHash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Fields that change without anything meaningful changing; ignored for "did it change?". */
const VOLATILE: Record<DocType, string[]> = { proposal: [], tally: ['asOfHeight'], cycle: ['estTime'] };

export function proposalProps(row: GovObjectRow): { props: Record<string, unknown> } | { error: string } {
  const v = proposalView(row.data_hex);
  if (!v) return { error: 'proposal data does not parse' };
  const amount = v.paymentAmountDuffs ?? Math.round(v.paymentAmount * 1e8);
  if (!/^[-_a-zA-Z0-9]{1,40}$/.test(v.name)) return { error: 'name does not fit the contract pattern' };
  if (v.url.length < 1 || v.url.length > 512) return { error: 'url length out of contract bounds' };
  if (v.paymentAddress.length < 26 || v.paymentAddress.length > 64) return { error: 'paymentAddress length out of contract bounds' };
  if (v.startEpoch < 0 || v.endEpoch < 0 || amount < 0 || row.time < 0) return { error: 'negative value' };
  if (row.data_hex.length > 1024) return { error: 'dataHex longer than 1024' };
  return {
    props: {
      govHash: displayHashBytes(row.hash),
      parentHash: displayHashBytes(row.parent_hash),
      revision: BigInt(row.revision),
      time: BigInt(row.time),
      dataHex: row.data_hex,
      name: v.name,
      url: v.url,
      paymentAddress: v.paymentAddress,
      paymentAmount: BigInt(amount),
      startEpoch: BigInt(v.startEpoch),
      endEpoch: BigInt(v.endEpoch),
      collateralTxid: displayHashBytes(row.collateral_hash),
      collateralHeight: BigInt(row.collateral_height ?? 0),
    },
  };
}

export function tallyProps(t: ComputedTally): Record<string, unknown> {
  return {
    govHash: displayHashBytes(t.govHash),
    asOfHeight: BigInt(t.asOfHeight),
    yesWeighted: BigInt(t.weighted.yes),
    noWeighted: BigInt(t.weighted.no),
    abstainWeighted: BigInt(t.weighted.abstain),
    yesCount: BigInt(t.unweighted.yes),
    noCount: BigInt(t.unweighted.no),
    abstainCount: BigInt(t.unweighted.abstain),
    voteSetHash: displayHashBytes(t.voteSetHash),
    rank: BigInt(t.rank),
    inNextBudget: t.inNextBudget,
    margin: BigInt(Math.max(-2147483648, Math.min(2147483647, t.margin))),
  };
}

export interface CycleValues {
  superblockHeight: number;
  budget: number;
  allocated: number;
  votingDeadlineHeight: number;
  estTime: number;
  validWeighted: number;
  paid: number;
}

export function cycleProps(c: CycleValues): Record<string, unknown> {
  return {
    superblockHeight: BigInt(c.superblockHeight),
    budget: BigInt(c.budget),
    allocated: BigInt(c.allocated),
    votingDeadlineHeight: BigInt(c.votingDeadlineHeight),
    estTime: BigInt(Math.max(0, c.estTime)),
    validWeighted: BigInt(c.validWeighted),
    paid: BigInt(c.paid),
  };
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const x = items[i++]!;
      await fn(x);
    }
  });
  await Promise.all(workers);
}

export class Publisher {
  readonly db: DB;
  readonly platform: PlatformClient;
  readonly cfg: BridgeConfig;

  constructor(db: DB, platform: PlatformClient, cfg: BridgeConfig) {
    this.db = db;
    this.platform = platform;
    this.cfg = cfg;
  }

  private record(type: DocType, key: string): PlatformDocRow | undefined {
    return this.db.prepare('SELECT * FROM platform_docs WHERE contract_id = ? AND doc_type = ? AND doc_key = ?').get(this.platform.contractId, type, key) as PlatformDocRow | undefined;
  }

  private save(type: DocType, key: string, id: string, revision: number, props: Record<string, unknown>): void {
    const json = canonical(props);
    this.db
      .prepare(
        `INSERT INTO platform_docs(contract_id, doc_type, doc_key, doc_id, revision, content_hash, content_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contract_id, doc_type, doc_key) DO UPDATE SET doc_id = excluded.doc_id, revision = excluded.revision, content_hash = excluded.content_hash,
           content_json = excluded.content_json, published_at = excluded.published_at`,
      )
      .run(this.platform.contractId, type, key, id, revision, contentHash(canonical(props, VOLATILE[type])), json, Math.floor(Date.now() / 1000));
  }

  private logWrite(type: DocType, key: string, op: string, id: string | null, revision: number | null, ok: boolean, error: string | null, attempts: number): void {
    this.db.prepare('INSERT INTO publish_log(at, contract_id, doc_type, doc_key, op, doc_id, revision, ok, error, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(Math.floor(Date.now() / 1000), this.platform.contractId, type, key, op, id, revision, ok ? 1 : 0, error, attempts);
  }

  /** The document behind a unique index on Platform (proved read), or null. */
  async lookup(type: DocType, key: string): Promise<PlatformDoc | null> {
    const where = type === 'cycle' ? [['superblockHeight', '==', Number(key)]] : [['govHash', '==', displayHashB64(key)]];
    const docs = await this.platform.query(type, { where, limit: 2 });
    if (docs.length > 1) log.error('unique index returned more than one document', { type, key });
    return docs[0] ?? null;
  }

  /**
   * Create-or-replace one document. `minIntervalSec` throttles replaces (0 = immutable type: never replaced).
   * Returns what happened.
   */
  async upsert(type: DocType, key: string, props: Record<string, unknown>, opts: { immutable?: boolean; minIntervalSec: number; createdAt?: boolean }): Promise<'created' | 'replaced' | 'unchanged' | 'adopted' | 'throttled'> {
    const changeHash = contentHash(canonical(props, VOLATILE[type]));
    let rec = this.record(type, key);
    if (!rec) {
      const found = await this.lookup(type, key);
      if (found) {
        // adopt the existing document; content is compared by re-publishing below when it differs
        this.save(type, key, found.id, found.revision, {});
        rec = this.record(type, key)!;
        this.db.prepare('UPDATE platform_docs SET content_hash = ? WHERE contract_id = ? AND doc_type = ? AND doc_key = ?').run('adopted', this.platform.contractId, type, key);
        rec.content_hash = 'adopted';
        log.info('adopted existing platform document', { type, key, id: found.id, revision: found.revision });
        if (opts.immutable) return 'adopted';
      }
    }
    if (!rec) {
      const label = `create ${type} ${key}`;
      try {
        const { value, attempts } = await this.platform.withRetries(
          label,
          () => this.platform.create(type, props, { createdAt: opts.createdAt }),
          async () => {
            const f = await this.lookup(type, key);
            return f ? { value: { id: f.id } } : null;
          },
        );
        this.save(type, key, value.id, 1, props);
        this.logWrite(type, key, 'create', value.id, 1, true, null, attempts);
        log.info('platform document created', { type, key, id: value.id });
        return 'created';
      } catch (e) {
        this.logWrite(type, key, 'create', null, null, false, errText(e).slice(0, 1000), 0);
        throw e;
      }
    }
    if (rec.content_hash === changeHash || opts.immutable) return 'unchanged';
    if (rec.content_hash !== 'adopted' && Date.now() / 1000 - rec.published_at < opts.minIntervalSec) return 'throttled';
    const revision = rec.revision + 1;
    const label = `replace ${type} ${key} r${revision}`;
    try {
      const { attempts } = await this.platform.withRetries(label, () => this.platform.replace(type, rec!.doc_id, revision, props), async () => {
        // a replace that landed although the call failed: do not send the same revision again
        const f = await this.lookup(type, key);
        return f && f.revision >= revision ? { value: undefined } : null;
      });
      this.save(type, key, rec.doc_id, revision, props);
      this.logWrite(type, key, 'replace', rec.doc_id, revision, true, null, attempts);
      log.info('platform document replaced', { type, key, id: rec.doc_id, revision });
      return 'replaced';
    } catch (e) {
      // the stored revision may be stale (another writer, or a replace that landed): resync it from Platform
      const f = await this.lookup(type, key).catch(() => null);
      if (f) this.db.prepare('UPDATE platform_docs SET revision = ? WHERE contract_id = ? AND doc_type = ? AND doc_key = ?').run(f.revision, this.platform.contractId, type, key);
      this.logWrite(type, key, 'replace', rec.doc_id, revision, false, errText(e).slice(0, 1000), 0);
      throw e;
    }
  }

  /** Proposals that may be published: hash, data and collateral verified, collateral buried >= minCollateralConfs. */
  publishableProposals(tipHeight: number): { ok: GovObjectRow[]; skipped: Array<{ key: string; reason: string }> } {
    const rows = this.db.prepare('SELECT * FROM gov_objects WHERE type = 1 ORDER BY first_seen_time').all() as GovObjectRow[];
    const ok: GovObjectRow[] = [];
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const r of rows) {
      if (!r.hash_ok) skipped.push({ key: r.hash, reason: 'hash does not recompute' });
      else if (r.data_valid !== 1) skipped.push({ key: r.hash, reason: `invalid data: ${r.data_errors}` });
      else if (r.collateral_ok !== 1) skipped.push({ key: r.hash, reason: `collateral not verified: ${r.collateral_error ?? 'pending'}` });
      else if (r.collateral_height === null || tipHeight - r.collateral_height + 1 < this.cfg.publish.minCollateralConfs) skipped.push({ key: r.hash, reason: 'collateral has < minCollateralConfs confirmations' });
      else ok.push(r);
    }
    return { ok, skipped };
  }

  async publish(run: TallyRun, comparisons: Map<string, CoreComparison>, cycles: CycleValues[], opts: { force?: boolean } = {}): Promise<PublishSummary> {
    const s: PublishSummary = { created: 0, replaced: 0, unchanged: 0, adopted: 0, held: 0, failed: 0, skipped: [], creditsBefore: null, creditsAfter: null };
    try {
      s.creditsBefore = (await this.platform.balance()).toString();
    } catch (e) {
      log.warn('balance read failed', { error: errText(e) });
    }
    const count = (r: string) => {
      if (r === 'created') s.created++;
      else if (r === 'replaced') s.replaced++;
      else if (r === 'adopted') s.adopted++;
      else s.unchanged++;
    };
    const limit = this.cfg.publish.maxConcurrentWrites;

    // 1. proposals (immutable)
    const { ok, skipped } = this.publishableProposals(run.height);
    for (const x of skipped) s.skipped.push({ type: 'proposal', ...x });
    await pool(ok, limit, async (row) => {
      const p = proposalProps(row);
      if ('error' in p) {
        s.skipped.push({ type: 'proposal', key: row.hash, reason: p.error });
        return;
      }
      try {
        count(await this.upsert('proposal', row.hash, p.props, { immutable: true, minIntervalSec: 0, createdAt: true }));
      } catch (e) {
        s.failed++;
        log.error('proposal publish failed', { hash: row.hash, error: errText(e) });
      }
    });

    // 2. tallies, only for proposals that are on Platform and only when they agree with Core (unless configured otherwise)
    const tallyInterval = opts.force ? 0 : this.cfg.publish.tallyIntervalSec;
    const tallies = run.tallies.filter((t) => this.record('proposal', t.govHash));
    await pool(tallies, limit, async (t) => {
      const cmp = comparisons.get(t.govHash);
      if (cmp && !cmp.match && !this.cfg.publish.publishOnMismatch) {
        s.held++;
        log.error('tally held back: bridge tally disagrees with Core', { hash: t.govHash, core: cmp.core, bridge: cmp.bridge, missingSigned: cmp.missingSigned.length, extra: cmp.extra.length });
        return;
      }
      try {
        const r = await this.upsert('tally', t.govHash, tallyProps(t), { minIntervalSec: tallyInterval });
        if (r === 'throttled') s.unchanged++;
        else count(r);
      } catch (e) {
        s.failed++;
        log.error('tally publish failed', { hash: t.govHash, error: errText(e) });
      }
    });

    // 3. cycles (sequential: few)
    const cycleInterval = opts.force ? 0 : this.cfg.publish.cycleIntervalSec;
    for (const c of cycles) {
      try {
        const r = await this.upsert('cycle', String(c.superblockHeight), cycleProps(c), { minIntervalSec: cycleInterval });
        if (r === 'throttled') s.unchanged++;
        else count(r);
      } catch (e) {
        s.failed++;
        log.error('cycle publish failed', { superblock: c.superblockHeight, error: errText(e) });
      }
    }
    try {
      s.creditsAfter = (await this.platform.balance()).toString();
    } catch {
      /* ignore */
    }
    return s;
  }
}
