// A bridge loaded with the recorded mainnet fixtures (no Core, no Platform).
import { hexToBytes } from '@govhub/verify';
import { Bridge } from '../src/bridge.ts';
import { loadConfig } from '../src/config.ts';
import { parseRawGovObject, parseRawVote } from '../src/core/govparse.ts';
import type { CoreRpc, GovernanceInfo } from '../src/core/rpc.ts';
import { computeAll, storeTally } from '../src/tally.ts';
import { archiveWithList, objectsFixture, votesFixture } from './helpers.ts';

/** Fixture time: proposals active, as when recorded (2026-10-24). */
export const FIXTURE_NOW = 1792813000;
export const GOV_INFO: GovernanceInfo = {
  governanceminquorum: 10,
  proposalfee: 1,
  superblockcycle: 16616,
  superblockmaturitywindow: 1662,
  lastsuperblock: 2558864,
  nextsuperblock: 2575480,
  fundingthreshold: 332,
  governancebudget: 6828.2637816,
};

export async function fixtureBridge(env: Record<string, string> = {}): Promise<Bridge> {
  const vf = votesFixture();
  const of = objectsFixture();
  const { db } = archiveWithList(vf);
  const b = new Bridge(loadConfig({ PUBLISH: '0', CORE_NETWORK: 'mainnet', ...env }), db);
  // collateral through the real code path, with Core's answers from the fixture
  const txs = new Map(of.objects.map((o) => [o.collateralTxid, o]));
  (b.ingest as { rpc: CoreRpc }).rpc = {
    getRawTransactionVerbose: async (txid: string) => ({ txid, hex: txs.get(txid)!.collateralRawTxHex, height: txs.get(txid)!.collateralHeight, blockhash: 'aa'.repeat(32) }),
  } as unknown as CoreRpc;
  b.ingest.height = vf.mnList.height;
  for (const o of of.objects) {
    b.ingest.archiveObject(parseRawGovObject(hexToBytes(o.rawHex)), 'zmq', vf.mnList.height - 10, FIXTURE_NOW - 1000);
    await b.ingest.checkCollateral(o.hash);
  }
  for (const p of vf.proposals) for (const v of p.votes) b.ingest.archiveVote(parseRawVote(hexToBytes(v.rawHex)), 'zmq', v.firstSeenHeight, FIXTURE_NOW - 500);
  b.ingest.verifyPendingVotes();
  b.govInfo = GOV_INFO;
  b.nextBudgetDuffs = 682826378160;
  const list = b.ingest.lists.load((db.prepare('SELECT list_hash FROM mn_snapshots').get() as { list_hash: string }).list_hash)!;
  b.lastRun = computeAll(db, list, vf.mnList.height, GOV_INFO, b.nextBudgetDuffs, FIXTURE_NOW);
  for (const t of b.lastRun.tallies) storeTally(db, t, null);
  db.prepare('INSERT INTO superblocks(height, block_hash, block_time, budget_duffs, paid_duffs, trigger_hash, payments, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    2558864,
    'bb'.repeat(32),
    1792700000,
    682826378160,
    539300000000,
    '20a49169e2249ad279ca29c9fec1f51b37b29b7455d5bd932163a556f53712d9',
    JSON.stringify([{ address: 'X', amountDuffs: 539300000000, proposalHash: null, paid: true }]),
    FIXTURE_NOW,
  );
  return b;
}
