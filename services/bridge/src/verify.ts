// `bridge verify`: recompute everything derivable from the archive and diff it against the stored verdicts and against Core.
import { checkCollateralTx, hexToBytes, uint256FromDisplay, validateProposalData } from '@govhub/verify';
import type { GovObjectRow, VoteRow } from './archive/db.ts';
import type { Bridge } from './bridge.ts';
import { govObjectHash, parseRawGovObject, parseRawVote } from './core/govparse.ts';
import { latestSnapshot } from './mnlist.ts';
import { computeAll } from './tally.ts';

export interface VerifyReport {
  ok: boolean;
  objects: { checked: number; hashMismatch: string[]; rawMismatch: string[]; dataVerdictChanged: string[]; collateralVerdictChanged: string[]; collateralInvalid: string[] };
  votes: { checked: number; rawMismatch: string[]; statusChanged: Array<{ hash: string; stored: string; now: string }>; byStatus: Record<string, number> };
  tallies: {
    asOfHeight: number | null;
    proposals: number;
    withCore: boolean;
    mismatches: Array<{ govHash: string; core: unknown; bridge: unknown; missingSigned: number; extra: number }>;
    thresholdBridge: number | null;
    thresholdCore: number | null;
  };
}

export async function verifyArchive(b: Bridge, opts: { withCore: boolean }): Promise<VerifyReport> {
  const db = b.db;
  const rep: VerifyReport = {
    ok: true,
    objects: { checked: 0, hashMismatch: [], rawMismatch: [], dataVerdictChanged: [], collateralVerdictChanged: [], collateralInvalid: [] },
    votes: { checked: 0, rawMismatch: [], statusChanged: [], byStatus: {} },
    tallies: { asOfHeight: null, proposals: 0, withCore: opts.withCore, mismatches: [], thresholdBridge: null, thresholdCore: null },
  };

  for (const r of db.prepare('SELECT * FROM gov_objects').all() as GovObjectRow[]) {
    rep.objects.checked++;
    if (r.raw_hex) {
      try {
        const p = parseRawGovObject(hexToBytes(r.raw_hex));
        if (p.hash !== r.hash) rep.objects.hashMismatch.push(r.hash);
        if (p.dataHex !== r.data_hex || p.time !== r.time || p.collateralHash !== r.collateral_hash || p.type !== r.type) rep.objects.rawMismatch.push(r.hash);
      } catch {
        rep.objects.rawMismatch.push(r.hash);
      }
    } else if (r.type === 1) {
      const h = govObjectHash({ parentHash: r.parent_hash, revision: r.revision, time: r.time, dataHex: r.data_hex, masternodeOutpoint: { txid: '0'.repeat(64), n: 0xffffffff }, sig: new Uint8Array() });
      if ((h === r.hash ? 1 : 0) !== r.hash_ok) rep.objects.hashMismatch.push(r.hash);
    }
    if (r.type === 1) {
      const v = validateProposalData(r.data_hex, b.cfg.coreNetwork);
      if ((v.valid ? 1 : 0) !== r.data_valid) rep.objects.dataVerdictChanged.push(r.hash);
      if (r.collateral_raw_hex) {
        const c = checkCollateralTx(hexToBytes(r.collateral_raw_hex), uint256FromDisplay(r.hash), { expectedTxid: r.collateral_hash });
        if ((c.valid ? 1 : 0) !== r.collateral_ok) rep.objects.collateralVerdictChanged.push(r.hash);
        if (!c.valid) rep.objects.collateralInvalid.push(r.hash);
      }
    }
  }

  const latest = latestSnapshot(db);
  const it = db.prepare('SELECT * FROM votes').iterate() as IterableIterator<VoteRow>;
  for (const v of it) {
    rep.votes.checked++;
    rep.votes.byStatus[v.sig_status] = (rep.votes.byStatus[v.sig_status] ?? 0) + 1;
    try {
      const p = parseRawVote(hexToBytes(v.raw_hex));
      if (p.hash !== v.hash || p.parentHash !== v.parent_hash || p.outcome !== v.outcome || p.signal !== v.signal || p.time !== v.time || p.outpoint.txid !== v.collateral_txid || p.outpoint.n !== v.collateral_n) rep.votes.rawMismatch.push(v.hash);
    } catch {
      // votes imported from governance.dat may carry a signature size the network format rejects
      rep.votes.rawMismatch.push(v.hash);
    }
    if (latest && (v.sig_status === 'valid' || v.sig_status === 'invalid' || v.sig_status === 'unknown-mn')) {
      const now = b.ingest.checkVote(v, latest.height).status;
      // 'unknown-mn' -> 'valid' just means the MN appeared in a later list; anything else is a changed verdict
      if (now !== v.sig_status && !(v.sig_status === 'unknown-mn' && now === 'valid')) rep.votes.statusChanged.push({ hash: v.hash, stored: v.sig_status, now });
    }
  }

  if (opts.withCore) {
    const run = await b.refresh({ reconcile: false, compare: true });
    if (run) {
      rep.tallies.asOfHeight = run.height;
      rep.tallies.proposals = run.tallies.length;
      rep.tallies.thresholdBridge = run.threshold;
      rep.tallies.thresholdCore = run.coreThreshold;
      for (const c of b.lastComparisons.values()) if (!c.match) rep.tallies.mismatches.push({ govHash: c.govHash, core: c.core, bridge: c.bridge, missingSigned: c.missingSigned.length, extra: c.extra.length });
    }
  } else if (latest) {
    const bs = db.prepare('SELECT * FROM budget_snapshots ORDER BY height DESC LIMIT 1').get() as { governance_info: string; next_budget_duffs: number } | undefined;
    if (bs) {
      const run = computeAll(db, b.ingest.lists.load(latest.listHash)!, latest.height, JSON.parse(bs.governance_info), bs.next_budget_duffs, Math.floor(Date.now() / 1000));
      rep.tallies.asOfHeight = run.height;
      rep.tallies.proposals = run.tallies.length;
      rep.tallies.thresholdBridge = run.threshold;
      rep.tallies.thresholdCore = run.coreThreshold;
    }
  }

  rep.ok =
    rep.objects.hashMismatch.length === 0 &&
    rep.objects.rawMismatch.length === 0 &&
    rep.objects.dataVerdictChanged.length === 0 &&
    rep.objects.collateralVerdictChanged.length === 0 &&
    rep.votes.rawMismatch.length === 0 &&
    rep.votes.statusChanged.length === 0 &&
    rep.tallies.mismatches.length === 0 &&
    rep.tallies.thresholdBridge === rep.tallies.thresholdCore;
  return rep;
}
