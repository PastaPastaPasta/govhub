// Read-only HTTP API. Spec: services/bridge/openapi.json (OpenAPI 3.1). CORS open for GETs.
// Proposal / tally / cycle objects use the field names of the Platform `gov` documents (packages/contracts-v1), plus extras.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { routePath } from 'hono/route';
import type { Bridge } from '../bridge.ts';
import type { GovObjectRow, TallyRow, VoteRow } from '../archive/db.ts';
import { latestSnapshot, mnAddresses, snapshotAt } from '../mnlist.ts';
import { proposalView } from '../proposal.ts';
import { FUDGE_WINDOW_S, type ComputedTally, type RecordedVoteSet } from '../tally.ts';
import { dashCentralBudget, dashCentralProposal } from './dashcentral.ts';
import { log, nowS } from '../log.ts';
import { QUORUM_PROOF_EXPOSED_HEADERS, QUORUM_PROOF_PATH, registerQuorumProof } from './quorumproof.ts';

const HASH_RE = /^[0-9a-f]{64}$/;
const SERVICE_VERSION = '0.1.0';

export function proposalJson(b: Bridge, r: GovObjectRow) {
  const v = proposalView(r.data_hex);
  const tip = b.ingest.height;
  const t = b.lastRun?.tallies.find((x) => x.govHash === r.hash);
  return {
    govHash: r.hash,
    parentHash: r.parent_hash,
    revision: r.revision,
    time: r.time,
    dataHex: r.data_hex,
    name: v?.name ?? null,
    url: v?.url ?? null,
    paymentAddress: v?.paymentAddress ?? null,
    /** duffs, as Core's ParsePaymentAmount reads payment_amount (null if Core could not pay it) */
    paymentAmount: v?.paymentAmountDuffs ?? null,
    startEpoch: v?.startEpoch ?? null,
    endEpoch: v?.endEpoch ?? null,
    collateralTxid: r.collateral_hash,
    collateralHeight: r.collateral_height,
    collateralConfirmations: r.collateral_height !== null && tip ? tip - r.collateral_height + 1 : null,
    verified: { hash: r.hash_ok === 1, data: r.data_valid === 1, collateral: r.collateral_ok === 1 },
    inCore: r.in_core === 1,
    firstSeenHeight: r.first_seen_height,
    firstSeenTime: r.first_seen_time,
    source: r.source,
    tally: t ? tallyJson(b, t) : null,
  };
}

export function tallyJson(b: Bridge, t: ComputedTally) {
  const c = b.lastComparisons.get(t.govHash);
  return {
    govHash: t.govHash,
    asOfHeight: t.asOfHeight,
    yesWeighted: t.weighted.yes,
    noWeighted: t.weighted.no,
    abstainWeighted: t.weighted.abstain,
    yesCount: t.unweighted.yes,
    noCount: t.unweighted.no,
    abstainCount: t.unweighted.abstain,
    voteSetHash: t.voteSetHash,
    rank: t.rank,
    inNextBudget: t.inNextBudget,
    margin: t.margin,
    absoluteYes: t.absoluteYes,
    passing: t.passing,
    voteCount: t.counted.length,
    staleKeyVotes: t.staleKey,
    mnListHash: t.listHash,
    core: c ? { match: c.match, yesWeighted: c.core.yes, noWeighted: c.core.no, abstainWeighted: c.core.abstain, absoluteYes: c.core.absoluteYes, missingSigned: c.missingSigned.length, extra: c.extra.length } : null,
  };
}

function voteJson(v: VoteRow, extra: { weight?: number; proTxHash?: string | null; counted?: boolean } = {}) {
  return {
    hash: v.hash,
    collateralTxid: v.collateral_txid,
    collateralIndex: v.collateral_n,
    proTxHash: extra.proTxHash ?? v.pro_tx_hash,
    weight: extra.weight ?? null,
    signal: v.signal,
    outcome: v.outcome,
    time: v.time,
    /** base64 of the 65-byte compact signature (the `voteraw` argument) */
    sig: Buffer.from(v.sig_hex, 'hex').toString('base64'),
    rawHex: v.raw_hex,
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
  const [next, last] = b.cycles(run);
  return {
    asOfHeight: run.height,
    cycle: next!,
    last: last ?? null,
    fundingThreshold: run.threshold,
    governance: b.govInfo,
  };
}

/** The set behind a stored tally row (vote_sets; `counted_votes` in 0.1.0 dev archives), or null when it is not recorded. */
function storedSet(b: Bridge, row: TallyRow): RecordedVoteSet | null {
  const set = b.db.prepare('SELECT vote_hashes FROM vote_sets WHERE gov_hash = ? AND vote_set_hash = ?').get(row.gov_hash, row.vote_set_hash) as { vote_hashes: string } | undefined;
  const json = set?.vote_hashes ?? row.counted_votes ?? null;
  if (json === null) return null;
  return { asOfHeight: row.as_of_height, listHash: row.list_hash, voteSetHash: row.vote_set_hash, weighted: { yes: row.yes_weighted, no: row.no_weighted, abstain: row.abstain_weighted }, voteHashes: JSON.parse(json) as string[] };
}

/** The newest set with this voteSetHash at or below `maxHeight`: the live tally's, a superseded live one's, or a stored one's. */
function setByHash(b: Bridge, govHash: string, voteSetHash: string, maxHeight = Number.MAX_SAFE_INTEGER): RecordedVoteSet | null {
  const found: RecordedVoteSet[] = [];
  const live = b.lastRun?.tallies.find((t) => t.govHash === govHash && t.voteSetHash === voteSetHash);
  if (live) found.push({ ...live, voteHashes: live.counted.map((v) => v.hash) });
  const retired = b.retiredSets.get(govHash, voteSetHash, nowS(), maxHeight);
  if (retired) found.push(retired);
  const row = b.db
    .prepare('SELECT * FROM tallies WHERE gov_hash = ? AND vote_set_hash = ? AND as_of_height <= ? ORDER BY as_of_height DESC, id DESC LIMIT 1')
    .get(govHash, voteSetHash, maxHeight) as TallyRow | undefined;
  const stored = row ? storedSet(b, row) : null;
  if (stored) found.push(stored);
  return found.filter((s) => s.asOfHeight <= maxHeight).sort((x, y) => y.asOfHeight - x.asOfHeight)[0] ?? null;
}

const byOutpoint = (x: { collateral_txid: string; collateral_n: number }, y: { collateral_txid: string; collateral_n: number }) =>
  x.collateral_txid < y.collateral_txid ? -1 : x.collateral_txid > y.collateral_txid ? 1 : x.collateral_n - y.collateral_n;

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** The one POST: a read-only query whose parameters do not fit a URL comfortably (same semantics as the GET). */
const methodsFor = (path: string): string[] => (path === QUORUM_PROOF_PATH ? [...READ_METHODS, 'POST'] : READ_METHODS);

export function createApi(b: Bridge, deps: { now?: () => number } = {}): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowMethods: (_origin, c) => methodsFor(c.req.path), allowHeaders: ['content-type'], exposeHeaders: QUORUM_PROOF_EXPOSED_HEADERS, maxAge: 86400 }));
  // Read-only API. The bridge may be published without a proxy in front (Cloudflare Tunnel), so it refuses
  // every other method itself instead of relying on Caddy's method filter, and sets the header Caddy would add.
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    const allowed = methodsFor(c.req.path);
    if (allowed.includes(c.req.method)) return next();
    c.header('Allow', allowed.join(', '));
    return c.json({ error: 'read-only API' }, 405);
  });
  app.onError((e, c) => {
    // The route pattern (`/v1/proposals/:hash`), never the URL: the path carries the proposal hash or height the client asked for.
    log.error('api error', { route: routePath(c), error: String(e?.stack ?? e) });
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // Always 200 while the process serves HTTP (health checks); `core.reachable` says whether Core answers.
  app.get('/v1/status', (c) => {
    const db = b.db;
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const byStatus = Object.fromEntries((db.prepare('SELECT sig_status s, COUNT(*) n FROM votes GROUP BY sig_status').all() as Array<{ s: string; n: number }>).map((r) => [r.s, r.n]));
    const snap = latestSnapshot(db);
    const proposals = count('SELECT COUNT(*) n FROM gov_objects WHERE type = 1');
    return c.json({
      service: 'govhub-bridge',
      version: SERVICE_VERSION,
      network: b.cfg.coreNetwork,
      platformNetwork: b.cfg.platformNetwork,
      height: b.ingest.height,
      bestBlockHash: b.ingest.tipHash || null,
      govContractId: b.cfg.publish.govContractId || null,
      bridgeIdentityId: b.platform?.identityId || null,
      proposals,
      startedAt: b.startedAt,
      now: nowS(),
      core: { ...b.core, lastChainLockHash: b.ingest.lastChainLockHash || null },
      zmq: b.zmq ? { url: b.cfg.core.zmqUrl, received: b.zmq.received, gaps: b.zmq.gaps, lastMessageAt: b.zmq.lastMessageAt ? Math.floor(b.zmq.lastMessageAt / 1000) : null } : null,
      archive: {
        objects: count('SELECT COUNT(*) n FROM gov_objects'),
        proposals,
        triggers: count('SELECT COUNT(*) n FROM gov_objects WHERE type = 2'),
        votes: count('SELECT COUNT(*) n FROM votes'),
        votesByStatus: byStatus,
        mnSnapshots: count('SELECT COUNT(*) n FROM mn_snapshots'),
        latestSnapshotHeight: snap?.height ?? null,
        badMessages: count('SELECT COUNT(*) n FROM bad_messages'),
      },
      ingest: b.ingest.stats,
      lastReconcileAt: b.lastReconcileAt || null,
      tallies: { asOfHeight: b.lastRun?.height ?? null, computedAt: b.lastTallyAt || null, count: b.lastRun?.tallies.length ?? 0, coreMismatches: [...b.lastComparisons.values()].filter((x) => !x.match).length },
      publish: { enabled: b.cfg.publish.enabled, platformNetwork: b.cfg.platformNetwork, last: b.lastPublish ? { ...b.lastPublish, skipped: b.lastPublish.skipped.length } : null },
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
    const known = b.db.prepare('SELECT 1 FROM gov_objects WHERE hash = ?').get(hash);
    if (!known) return c.json({ error: 'unknown proposal' }, 404);
    const base = { govHash: hash, network: b.cfg.coreNetwork, voteSetHashVersion: 'govhub-voteset-v1' };

    // every archived vote on the proposal, flagged with whether the live tally counts it
    if (c.req.query('all') === '1') {
      const t = b.lastRun?.tallies.find((x) => x.govHash === hash);
      const counted = new Map((t?.counted ?? []).map((v) => [v.hash, v]));
      const votes = (b.db.prepare('SELECT * FROM votes WHERE parent_hash = ? ORDER BY collateral_txid, collateral_n, time').all(hash) as VoteRow[]).map((v) => {
        const cv = counted.get(v.hash);
        return voteJson(v, { weight: cv?.weight, proTxHash: cv?.proTxHash, counted: !!cv });
      });
      return c.json({ ...base, asOfHeight: t?.asOfHeight ?? null, voteSetHash: t?.voteSetHash ?? null, count: votes.length, votes });
    }

    /** A recorded set (vote hashes) as a VoteSet, the weights and proTxHashes from the list it was counted against. */
    const serveSet = (asOfHeight: number, s: RecordedVoteSet) => {
      const get = b.db.prepare('SELECT * FROM votes WHERE hash = ?');
      const list = b.ingest.lists.load(s.listHash);
      const rows = s.voteHashes.map((vh) => get.get(vh) as VoteRow | undefined);
      if (rows.some((r) => !r)) return c.json({ error: 'archive inconsistency: a vote of that set is missing' }, 500);
      const votes = (rows as VoteRow[])
        .sort(byOutpoint)
        .map((v) => {
          const e = list?.byOutpoint.get(`${v.collateral_txid}-${v.collateral_n}`);
          return voteJson(v, { weight: e?.weight, proTxHash: e?.proTxHash ?? v.pro_tx_hash });
        });
      return c.json({
        ...base,
        asOfHeight,
        tallyHeight: s.asOfHeight,
        mnListHash: s.listHash,
        voteSetHash: s.voteSetHash,
        yesWeighted: s.weighted.yes,
        noWeighted: s.weighted.no,
        abstainWeighted: s.weighted.abstain,
        count: votes.length,
        votes,
      });
    };

    const hq = c.req.query('height');
    const vq = c.req.query('voteSetHash');
    let h: number | undefined;
    if (hq !== undefined) {
      h = Number(hq);
      if (!Number.isInteger(h) || h < 0) return c.json({ error: 'height must be a non-negative integer' }, 400);
      const maxH = b.lastRun?.height ?? (b.db.prepare('SELECT MAX(as_of_height) h FROM tallies').get() as { h: number | null }).h ?? -1;
      if (h > maxH) return c.json({ error: `height ${h} is above the latest tally height ${maxH}` }, 404);
    }

    // Exactly the set with that voteSetHash (at or below `height`, if given): the live tally's, a superseded live tally's (kept a while),
    // or a stored one's. A tally and its votes are fetched at different moments, and the live tally changes at the same height whenever a
    // vote arrives: asking by hash gets the set behind the tally the client holds, not whatever is current now.
    if (vq !== undefined) {
      const vsh = vq.toLowerCase();
      if (!HASH_RE.test(vsh)) return c.json({ error: 'voteSetHash must be 64 hex chars' }, 400);
      const s = setByHash(b, hash, vsh, h);
      if (!s) return c.json({ error: `no vote set with that voteSetHash for this proposal${h === undefined ? '' : ' at or below that height'}` }, 404);
      return serveSet(h ?? s.asOfHeight, s);
    }

    // the vote set behind the tally in force at a past height (e.g. a published tally document's asOfHeight)
    if (h !== undefined) {
      const row = b.db.prepare('SELECT * FROM tallies WHERE gov_hash = ? AND as_of_height <= ? ORDER BY as_of_height DESC, id DESC LIMIT 1').get(hash, h) as TallyRow | undefined;
      const s = row ? storedSet(b, row) : null;
      if (!s) return c.json({ error: 'no recorded vote set for this proposal at or below that height' }, 404);
      return serveSet(h, s);
    }

    // live: the counted set of the latest tally
    const t = b.lastRun?.tallies.find((x) => x.govHash === hash);
    if (!t) return c.json({ error: 'no live tally for this proposal (inactive, or not computed yet); use ?height= or ?all=1' }, 404);
    const votes = [...t.counted].sort(byOutpoint).map((v) => voteJson(v, { weight: v.weight, proTxHash: v.proTxHash }));
    return c.json({
      ...base,
      asOfHeight: t.asOfHeight,
      tallyHeight: t.asOfHeight,
      mnListHash: t.listHash,
      voteSetHash: t.voteSetHash,
      yesWeighted: t.weighted.yes,
      noWeighted: t.weighted.no,
      abstainWeighted: t.weighted.abstain,
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
      budget: run.budgetDuffs,
      allocated: run.allocatedDuffs,
      tallies: run.tallies.map((t) => tallyJson(b, t)),
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
    // the latest known collateral and payout addresses (not part of the list), so a client can refuse a pasted collateral or payout key
    const addrs = mnAddresses(b.db);
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
          collateralTxid: e.collateralTxid,
          collateralIndex: e.collateralN,
          type: e.type === 'Evo' ? 'evo' : e.type === 'Regular' ? 'regular' : e.type,
          weight: e.weight,
          votingAddress: e.votingAddress,
          ...addrs.get(e.proTxHash),
          keyIdVoting: e.votingKeyId,
          valid: e.isValid,
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

  // Relay of Core's getquorumproofchain (DIP 175). Self-authenticating from the client's checkpoint; see quorumproof.ts.
  // Registered per call so tests (and operators' `b.rpc`) see the live client.
  if (b.cfg.quorumProof.enabled) registerQuorumProof(app, { call: (m, p, o) => b.rpc.call(m, p, o) }, b.cfg, deps.now);

  return app;
}
