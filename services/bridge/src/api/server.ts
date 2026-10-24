// Read-only HTTP API. Spec: services/bridge/openapi.json (OpenAPI 3.1). CORS open for GETs.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { VOTE_OUTCOME_NAMES, VOTE_SIGNAL_NAMES } from '@govhub/verify';
import type { Bridge } from '../bridge.ts';
import type { GovObjectRow, VoteRow } from '../archive/db.ts';
import { latestSnapshot, snapshotAt } from '../mnlist.ts';
import { proposalView } from '../proposal.ts';
import { FUDGE_WINDOW_S, type ComputedTally } from '../tally.ts';
import { dashCentralBudget, dashCentralProposal } from './dashcentral.ts';

const HASH_RE = /^[0-9a-f]{64}$/;
const nowS = () => Math.floor(Date.now() / 1000);
export const SERVICE_VERSION = '0.1.0';

export function duffsToDash(d: number): string {
  const neg = d < 0;
  const a = Math.abs(d);
  return `${neg ? '-' : ''}${Math.floor(a / 1e8)}.${String(a % 1e8).padStart(8, '0')}`;
}

export function proposalJson(b: Bridge, r: GovObjectRow) {
  const v = proposalView(r.data_hex);
  const tip = b.ingest.height;
  const t = b.lastRun?.tallies.find((x) => x.govHash === r.hash);
  return {
    hash: r.hash,
    name: v?.name ?? null,
    url: v?.url ?? null,
    paymentAddress: v?.paymentAddress ?? null,
    paymentAmount: v ? (v.paymentAmountDuffs !== null ? duffsToDash(v.paymentAmountDuffs) : String(v.paymentAmount)) : null,
    paymentAmountDuffs: v?.paymentAmountDuffs ?? null,
    startEpoch: v?.startEpoch ?? null,
    endEpoch: v?.endEpoch ?? null,
    time: r.time,
    revision: r.revision,
    parentHash: r.parent_hash,
    collateralTxid: r.collateral_hash,
    collateralHeight: r.collateral_height,
    collateralConfirmations: r.collateral_height !== null && tip ? tip - r.collateral_height + 1 : null,
    verified: { hash: r.hash_ok === 1, data: r.data_valid === 1, collateral: r.collateral_ok === 1 },
    inCore: r.in_core === 1,
    firstSeenHeight: r.first_seen_height,
    firstSeenTime: r.first_seen_time,
    source: r.source,
    tally: t ? tallySummary(b, t) : null,
  };
}

export function tallySummary(b: Bridge, t: ComputedTally) {
  const c = b.lastComparisons.get(t.govHash);
  return {
    govHash: t.govHash,
    asOfHeight: t.asOfHeight,
    weighted: t.weighted,
    unweighted: t.unweighted,
    absoluteYes: t.absoluteYes,
    voteCount: t.counted.length,
    voteSetHash: t.voteSetHash,
    rank: t.rank,
    passing: t.passing,
    inNextBudget: t.inNextBudget,
    margin: t.margin,
    staleKeyVotes: t.staleKey,
    core: c ? { match: c.match, yes: c.core.yes, no: c.core.no, abstain: c.core.abstain, absoluteYes: c.core.absoluteYes, missingSigned: c.missingSigned.length, extra: c.extra.length } : null,
  };
}

function voteJson(v: VoteRow, extra: { weight?: number; proTxHash?: string | null; counted?: boolean } = {}) {
  return {
    hash: v.hash,
    rawHex: v.raw_hex,
    collateralOutpoint: `${v.collateral_txid}-${v.collateral_n}`,
    proTxHash: extra.proTxHash ?? v.pro_tx_hash,
    weight: extra.weight ?? null,
    outcome: VOTE_OUTCOME_NAMES[v.outcome] ?? String(v.outcome),
    signal: VOTE_SIGNAL_NAMES[v.signal] ?? String(v.signal),
    time: v.time,
    signatureHex: v.sig_hex,
    signatureStatus: v.sig_status,
    signerKeyId: v.signer_keyid,
    firstSeenHeight: v.first_seen_height,
    firstSeenTime: v.first_seen_time,
    source: v.source,
    ...(extra.counted !== undefined ? { counted: extra.counted } : {}),
  };
}

export function cycleJson(b: Bridge) {
  if (!b.lastRun || !b.govInfo) return null;
  const run = b.lastRun;
  const cycles = b.cycles(run);
  const toJson = (c: (typeof cycles)[number]) => ({ ...c, budgetDash: duffsToDash(c.budget), allocatedDash: duffsToDash(c.allocated), paidDash: duffsToDash(c.paid) });
  return {
    asOfHeight: run.height,
    governance: b.govInfo,
    fundingThreshold: run.threshold,
    next: toJson(cycles[0]!),
    last: cycles[1] ? toJson(cycles[1]) : null,
  };
}

export function createApi(b: Bridge): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'], maxAge: 86400 }));
  app.onError((e, c) => c.json({ error: String(e.message ?? e) }, 500));
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.get('/v1/status', (c) => {
    const db = b.db;
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const byStatus = Object.fromEntries((db.prepare('SELECT sig_status s, COUNT(*) n FROM votes GROUP BY sig_status').all() as Array<{ s: string; n: number }>).map((r) => [r.s, r.n]));
    const snap = latestSnapshot(db);
    const mismatches = [...b.lastComparisons.values()].filter((x) => !x.match).length;
    return c.json({
      service: 'govhub-bridge',
      version: SERVICE_VERSION,
      coreNetwork: b.cfg.coreNetwork,
      platformNetwork: b.cfg.platformNetwork,
      startedAt: b.startedAt,
      now: nowS(),
      core: { ...b.core, height: b.ingest.height, tipHash: b.ingest.tipHash || null, lastChainLockHash: b.ingest.lastChainLockHash || null },
      zmq: b.zmq ? { url: b.cfg.core.zmqUrl, received: b.zmq.received, gaps: b.zmq.gaps, lastMessageAt: b.zmq.lastMessageAt ? Math.floor(b.zmq.lastMessageAt / 1000) : null } : null,
      archive: {
        objects: count('SELECT COUNT(*) n FROM gov_objects'),
        proposals: count('SELECT COUNT(*) n FROM gov_objects WHERE type = 1'),
        triggers: count('SELECT COUNT(*) n FROM gov_objects WHERE type = 2'),
        votes: count('SELECT COUNT(*) n FROM votes'),
        votesByStatus: byStatus,
        mnSnapshots: count('SELECT COUNT(*) n FROM mn_snapshots'),
        latestSnapshotHeight: snap?.height ?? null,
        badMessages: count('SELECT COUNT(*) n FROM bad_messages'),
      },
      ingest: b.ingest.stats,
      lastReconcileAt: b.lastReconcileAt || null,
      tallies: { asOfHeight: b.lastRun?.height ?? null, computedAt: b.lastTallyAt || null, proposals: b.lastRun?.tallies.length ?? 0, coreMismatches: mismatches },
      publish: {
        enabled: b.cfg.publish.enabled,
        platformNetwork: b.cfg.platformNetwork,
        govContractId: b.cfg.publish.govContractId || null,
        identityId: b.platform?.identityId || null,
        last: b.lastPublish ? { ...b.lastPublish, skipped: b.lastPublish.skipped.length } : null,
      },
    });
  });

  app.get('/v1/proposals', (c) => {
    const state = c.req.query('state') ?? 'active';
    if (state !== 'active' && state !== 'past' && state !== 'all') return c.json({ error: 'state must be active, past or all' }, 400);
    const now = nowS();
    const rows = b.db.prepare('SELECT * FROM gov_objects WHERE type = 1 ORDER BY time DESC').all() as GovObjectRow[];
    const out = rows
      .filter((r) => {
        if (state === 'all') return true;
        const v = proposalView(r.data_hex);
        const active = r.in_core === 1 && v !== null && v.endEpoch + FUDGE_WINDOW_S >= now;
        return state === 'active' ? active : !active;
      })
      .map((r) => proposalJson(b, r));
    return c.json({ state, asOfHeight: b.lastRun?.height ?? null, count: out.length, proposals: out });
  });

  app.get('/v1/proposals/:hash', (c) => {
    const hash = c.req.param('hash').toLowerCase();
    if (!HASH_RE.test(hash)) return c.json({ error: 'hash must be 64 hex chars' }, 400);
    const r = b.db.prepare('SELECT * FROM gov_objects WHERE hash = ? AND type = 1').get(hash) as GovObjectRow | undefined;
    if (!r) return c.json({ error: 'unknown proposal' }, 404);
    return c.json({
      ...proposalJson(b, r),
      rawHex: r.raw_hex,
      dataHex: r.data_hex,
      dataString: Buffer.from(r.data_hex, 'hex').toString('utf8'),
      collateralRawTxHex: r.collateral_raw_hex,
      collateralBlockHash: r.collateral_blockhash,
      verification: { hashOk: r.hash_ok === 1, dataValid: r.data_valid === 1, dataErrors: r.data_errors, collateralOk: r.collateral_ok === null ? null : r.collateral_ok === 1, collateralError: r.collateral_error },
      removedFromCoreAt: r.removed_from_core_at,
    });
  });

  app.get('/v1/proposals/:hash/votes', (c) => {
    const hash = c.req.param('hash').toLowerCase();
    if (!HASH_RE.test(hash)) return c.json({ error: 'hash must be 64 hex chars' }, 400);
    const all = c.req.query('all') === '1';
    const t = b.lastRun?.tallies.find((x) => x.govHash === hash);
    if (!t && !all) {
      const known = b.db.prepare('SELECT 1 FROM gov_objects WHERE hash = ?').get(hash);
      return known ? c.json({ error: 'no tally for this proposal (not active or not computed yet); use ?all=1 for archived votes' }, 404) : c.json({ error: 'unknown proposal' }, 404);
    }
    const counted = new Map((t?.counted ?? []).map((v) => [v.hash, v]));
    const votes = all
      ? (b.db.prepare('SELECT * FROM votes WHERE parent_hash = ? ORDER BY collateral_txid, collateral_n, time').all(hash) as VoteRow[]).map((v) => {
          const cv = counted.get(v.hash);
          return voteJson(v, { weight: cv?.weight, proTxHash: cv?.proTxHash, counted: !!cv });
        })
      : [...counted.values()].sort((x, y) => (x.collateral_txid < y.collateral_txid ? -1 : x.collateral_txid > y.collateral_txid ? 1 : x.collateral_n - y.collateral_n)).map((v) => voteJson(v, { weight: v.weight, proTxHash: v.proTxHash }));
    return c.json({
      govHash: hash,
      asOfHeight: t?.asOfHeight ?? null,
      mnListHash: t?.listHash ?? null,
      voteSetHash: t?.voteSetHash ?? null,
      voteSetHashVersion: 'govhub/voteset/v1',
      network: b.cfg.coreNetwork,
      weighted: t?.weighted ?? null,
      unweighted: t?.unweighted ?? null,
      count: votes.length,
      votes,
    });
  });

  app.get('/v1/tallies', (c) => {
    const run = b.lastRun;
    if (!run) return c.json({ error: 'tallies not computed yet' }, 503);
    return c.json({
      asOfHeight: run.height,
      mnListHash: run.listHash,
      computedAt: b.lastTallyAt,
      fundingThreshold: run.threshold,
      validWeighted: run.validWeighted,
      nextSuperblock: run.nextSuperblock,
      budget: duffsToDash(run.budgetDuffs),
      allocated: duffsToDash(run.allocatedDuffs),
      tallies: run.tallies.map((t) => tallySummary(b, t)),
    });
  });

  const mnlist = (heightParam: string | undefined) => {
    let snap;
    if (heightParam === undefined) {
      snap = b.lastRun ? snapshotAt(b.db, b.lastRun.height) : latestSnapshot(b.db);
    } else {
      const h = Number(heightParam);
      if (!Number.isInteger(h) || h < 0) return { status: 400 as const, body: { error: 'height must be a non-negative integer' } };
      snap = snapshotAt(b.db, h);
      if (snap && snap.height > h) snap = null;
    }
    if (!snap) return { status: 404 as const, body: { error: 'no masternode list snapshot at or below that height' } };
    const l = b.ingest.lists.load(snap.listHash)!;
    return {
      status: 200 as const,
      body: {
        height: snap.height,
        blockHash: snap.blockHash,
        listHash: snap.listHash,
        count: l.list.count,
        validCount: l.list.validCount,
        validWeighted: l.list.validWeighted,
        totalWeighted: l.list.totalWeighted,
        masternodes: l.list.entries.map((e) => ({
          proTxHash: e.proTxHash,
          collateralOutpoint: `${e.collateralTxid}-${e.collateralN}`,
          type: e.type === 'Evo' ? 'evo' : e.type === 'Regular' ? 'regular' : e.type,
          weight: e.weight,
          votingAddress: e.votingAddress,
          keyIdVoting: e.votingKeyId,
          isValid: e.isValid,
          poseBanHeight: e.poseBanHeight,
        })),
      },
    };
  };
  app.get('/v1/mnlist', (c) => {
    const r = mnlist(undefined);
    return c.json(r.body, r.status);
  });
  app.get('/v1/mnlist/:height', (c) => {
    const r = mnlist(c.req.param('height'));
    return c.json(r.body, r.status);
  });

  app.get('/v1/cycle', (c) => {
    const j = cycleJson(b);
    return j ? c.json(j) : c.json({ error: 'cycle not computed yet' }, 503);
  });

  // DashCentral-compatible API (subset; values honest: what we do not know is null)
  app.get('/api/v1/budget', (c) => {
    const j = dashCentralBudget(b);
    return c.json(j, j.status === 'ok' ? 200 : 503);
  });
  app.get('/api/v1/proposal', (c) => {
    const hash = (c.req.query('hash') ?? '').toLowerCase();
    if (!HASH_RE.test(hash)) return c.json({ status: 'error', error_type: 'invalid_hash', error_message: 'hash must be 64 hex chars' }, 400);
    const j = dashCentralProposal(b, hash);
    return c.json(j, j.status === 'ok' ? 200 : 404);
  });

  return app;
}
