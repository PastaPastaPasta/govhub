// The bridge process: ZMQ listener + RPC reconciliation + tallies + optional Platform publishing + HTTP API state.
import { openArchive, recordEvent, setMeta, type DB } from './archive/db.ts';
import { readIdentityKeyFile, type BridgeConfig } from './config.ts';
import { CoreRpc, type GovernanceInfo } from './core/rpc.ts';
import { ZmqListener } from './core/zmq.ts';
import { dashToDuffs, Ingestor } from './ingest.ts';
import { errText, log } from './log.ts';
import { latestSnapshot, snapshotAt, snapshotMnList } from './mnlist.ts';
import { PlatformClient } from './publish/platform.ts';
import { Publisher, type CycleValues, type PublishSummary } from './publish/publisher.ts';
import { triggerView } from './proposal.ts';
import { coreCurrentFundingVotes, compareWithCore, computeAll, storeTally, type CoreComparison, type TallyRun } from './tally.ts';

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CoreState {
  reachable: boolean;
  lastError: string | null;
  blockchainSynced: boolean;
  governanceSynced: boolean;
  txindexSynced: boolean | null;
  version: string | null;
}

export class Bridge {
  readonly cfg: BridgeConfig;
  readonly db: DB;
  readonly rpc: CoreRpc;
  readonly ingest: Ingestor;
  zmq: ZmqListener | null = null;
  platform: PlatformClient | null = null;
  publisher: Publisher | null = null;
  readonly startedAt = nowS();
  core: CoreState = { reachable: false, lastError: null, blockchainSynced: false, governanceSynced: false, txindexSynced: null, version: null };
  govInfo: GovernanceInfo | null = null;
  nextBudgetDuffs = 0;
  lastRun: TallyRun | null = null;
  lastComparisons = new Map<string, CoreComparison>();
  lastReconcileAt = 0;
  lastTallyAt = 0;
  lastPublish: (PublishSummary & { at: number }) | null = null;
  private stopping = false;
  private tickRunning = false;

  constructor(cfg: BridgeConfig, db?: DB) {
    this.cfg = cfg;
    this.db = db ?? openArchive(cfg.dbPath);
    this.rpc = new CoreRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword, timeoutMs: cfg.core.rpcTimeoutMs, retries: cfg.core.rpcRetries });
    this.ingest = new Ingestor(this.db, this.rpc, cfg.coreNetwork);
    setMeta(this.db, 'core_network', cfg.coreNetwork);
  }

  startZmq(): void {
    if (!this.cfg.core.zmqUrl) {
      log.warn('CORE_ZMQ_URL is empty: no signed votes will be archived');
      return;
    }
    this.zmq = new ZmqListener(this.cfg.core.zmqUrl, {
      onMessage: (m) => this.ingest.onZmq(m),
      onGap: (g) => {
        recordEvent(this.db, 'zmq-gap', g);
        // objects can be recovered over RPC; dropped votes only by a governance re-sync (see README "Backfill")
        this.lastReconcileAt = 0;
      },
    });
    this.zmq.start();
  }

  async startPublisher(): Promise<void> {
    if (!this.cfg.publish.enabled) return;
    const key = readIdentityKeyFile(this.cfg.publish.identityKeyFile);
    this.platform = new PlatformClient(this.cfg.platformNetwork, this.cfg.publish.govContractId);
    await this.platform.loadIdentity(key);
    this.publisher = new Publisher(this.db, this.platform, this.cfg);
    log.info('publisher ready', { identityId: key.identityId, keyId: key.keyId, protocolVersion: this.platform.protocolVersion });
  }

  /** Probes Core once; updates `this.core`. */
  async probeCore(): Promise<boolean> {
    try {
      const sync = await this.rpc.mnsyncStatus();
      this.core.reachable = true;
      this.core.lastError = null;
      this.core.blockchainSynced = !!sync.IsBlockchainSynced;
      this.ingest.chainSynced = this.core.blockchainSynced;
      this.core.governanceSynced = !!sync.IsSynced;
      if (!this.core.version) this.core.version = (await this.rpc.getNetworkInfo()).subversion;
      try {
        const idx = await this.rpc.getIndexInfo();
        this.core.txindexSynced = idx.txindex ? idx.txindex.synced : false;
      } catch {
        this.core.txindexSynced = null;
      }
      return true;
    } catch (e) {
      this.core.reachable = false;
      this.core.lastError = errText(e);
      return false;
    }
  }

  /** Waits (with capped exponential backoff) until Core answers and its chain is synced. */
  async waitForCore(maxWaitMs = Infinity): Promise<boolean> {
    const t0 = Date.now();
    let delay = 2000;
    for (;;) {
      if (this.stopping) return false;
      // a peerless regtest node may never report a synced chain; there the chain is whatever was mined
      if ((await this.probeCore()) && (this.core.blockchainSynced || this.cfg.coreNetwork === 'regtest')) return true;
      if (Date.now() - t0 > maxWaitMs) return false;
      log.info('waiting for Core', { reachable: this.core.reachable, blockchainSynced: this.core.blockchainSynced, error: this.core.lastError });
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  /** One full cycle: height, MN snapshot, reconcile (when due), budget, superblock bookkeeping, tallies + Core comparison. */
  async refresh(opts: { reconcile?: boolean; compare?: boolean } = {}): Promise<TallyRun | null> {
    await this.probeCore();
    if (!this.core.reachable) throw new Error(`Core unreachable: ${this.core.lastError}`);
    const height = await this.ingest.refreshHeight();
    await this.ingest.ensureSnapshot(height);
    if (opts.reconcile ?? nowS() - this.lastReconcileAt >= this.cfg.reconcileIntervalSec) {
      // a peerless regtest node never finishes mnsync; archive what Core lists anyway, but only a synced node's list says
      // which objects were dropped
      const r = await this.ingest.reconcileObjects({ markRemoved: this.core.governanceSynced });
      log.info('reconciled with gobject list', { ...r, governanceSynced: this.core.governanceSynced });
      this.lastReconcileAt = nowS();
    }
    this.ingest.verifyPendingVotes(1_000_000);
    const { info, nextBudgetDuffs } = await this.ingest.snapshotBudget();
    this.govInfo = info;
    this.nextBudgetDuffs = nextBudgetDuffs;
    if (info.lastsuperblock > 0 && !this.db.prepare('SELECT 1 FROM superblocks WHERE height = ?').get(info.lastsuperblock)) {
      try {
        await this.ingest.recordSuperblock(info.lastsuperblock);
        if (!this.db.prepare('SELECT 1 FROM mn_snapshots WHERE height = ?').get(info.lastsuperblock)) await snapshotMnList(this.db, this.rpc, this.cfg.coreNetwork, info.lastsuperblock);
      } catch (e) {
        log.warn('superblock bookkeeping failed', { height: info.lastsuperblock, error: errText(e) });
      }
    }
    const snap = latestSnapshot(this.db);
    if (!snap) return null;
    const list = this.ingest.lists.load(snap.listHash)!;
    const run = computeAll(this.db, list, snap.height, info, nextBudgetDuffs, nowS());
    if (run.threshold !== run.coreThreshold) {
      recordEvent(this.db, 'threshold-mismatch', { bridge: run.threshold, core: run.coreThreshold, validWeighted: run.validWeighted, height: run.height });
      log.error('funding threshold differs from getgovernanceinfo', { bridge: run.threshold, core: run.coreThreshold });
    }
    if (opts.compare ?? true) {
      const cmps = new Map<string, CoreComparison>();
      let mismatches = 0;
      for (const t of run.tallies) {
        try {
          const [obj, cur] = await Promise.all([this.rpc.gobjectGet(t.govHash), this.rpc.gobjectCurrentVotes(t.govHash)]);
          const c = compareWithCore(t, obj.FundingResult, coreCurrentFundingVotes(cur));
          cmps.set(t.govHash, c);
          storeTally(this.db, t, c);
          if (!c.match) mismatches++;
        } catch (e) {
          storeTally(this.db, t, null);
          log.warn('core comparison failed', { hash: t.govHash, error: errText(e) });
        }
      }
      if (mismatches) {
        recordEvent(this.db, 'tally-mismatch', { height: run.height, mismatches, proposals: run.tallies.length });
        log.error('TALLY MISMATCH: bridge tallies disagree with Core', {
          mismatches,
          proposals: run.tallies.length,
          detail: [...cmps.values()].filter((c) => !c.match).slice(0, 10).map((c) => ({ hash: c.govHash, core: c.core, bridge: c.bridge, missingSigned: c.missingSigned.length, extra: c.extra.length })),
        });
      }
      this.lastComparisons = cmps;
    }
    this.lastRun = run;
    this.lastTallyAt = nowS();
    return run;
  }

  /** Cycle documents: the next superblock (live) and the last one (with what was actually paid). */
  cycles(run: TallyRun): CycleValues[] {
    const info = this.govInfo!;
    const out: CycleValues[] = [
      {
        superblockHeight: info.nextsuperblock,
        budget: this.nextBudgetDuffs,
        allocated: run.allocatedDuffs,
        votingDeadlineHeight: info.nextsuperblock - info.superblockmaturitywindow,
        estTime: run.sbTime,
        validWeighted: run.validWeighted,
        paid: 0,
      },
    ];
    const sb = this.db.prepare('SELECT * FROM superblocks WHERE height = ?').get(info.lastsuperblock) as any;
    if (sb) {
      const snap = snapshotAt(this.db, sb.height);
      const list = snap ? this.ingest.lists.load(snap.listHash) : null;
      const payments = JSON.parse(sb.payments) as Array<{ amountDuffs: number }>;
      out.push({
        superblockHeight: sb.height,
        budget: sb.budget_duffs,
        allocated: payments.reduce((a, p) => a + p.amountDuffs, 0),
        votingDeadlineHeight: sb.height - info.superblockmaturitywindow,
        estTime: sb.block_time,
        validWeighted: list?.list.validWeighted ?? run.validWeighted,
        paid: sb.paid_duffs,
      });
    }
    return out;
  }

  async publishOnce(opts: { force?: boolean } = {}): Promise<PublishSummary | null> {
    if (!this.publisher) return null;
    const run = this.lastRun ?? (await this.refresh());
    if (!run) throw new Error('no MN snapshot yet: cannot publish');
    const s = await this.publisher.publish(run, this.lastComparisons, this.cycles(run), opts);
    this.lastPublish = { ...s, at: nowS() };
    recordEvent(this.db, 'publish', { ...s, skipped: s.skipped.length });
    log.info('publish run finished', { ...s, skipped: s.skipped.length });
    return s;
  }

  /** Long-running loop. Never throws; Core outages are retried with backoff. */
  async run(): Promise<void> {
    this.startZmq();
    if (this.cfg.publish.enabled) {
      for (let delay = 5000; !this.stopping; delay = Math.min(delay * 2, 300_000)) {
        try {
          await this.startPublisher();
          break;
        } catch (e) {
          log.error('publisher init failed, retrying', { error: errText(e), retryInMs: delay });
          await sleep(delay);
        }
      }
    }
    await this.waitForCore();
    let lastHeight = 0;
    let delay = 5000;
    while (!this.stopping) {
      try {
        if (!this.tickRunning) {
          this.tickRunning = true;
          const due = this.ingest.height !== lastHeight || nowS() - this.lastTallyAt >= 300;
          if (due) {
            const run = await this.refresh();
            lastHeight = this.ingest.height;
            if (run && this.publisher) await this.publishOnce();
          }
          delay = 5000;
        }
      } catch (e) {
        log.error('bridge cycle failed (will retry)', { error: errText(e), retryInMs: delay });
        await sleep(delay);
        delay = Math.min(delay * 2, 120_000);
      } finally {
        this.tickRunning = false;
      }
      // the ZMQ hashblock handler advances ingest.height; poll RPC too in case ZMQ is down
      await sleep(15_000);
      try {
        await this.ingest.refreshHeight();
      } catch {
        /* reported by the next refresh */
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.zmq?.stop();
  }

  close(): void {
    this.db.close();
  }
}

export { dashToDuffs, triggerView };
