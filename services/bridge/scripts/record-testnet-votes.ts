// Records every signed (65-byte ECDSA) vote in a TESTNET bridge archive as a fixture for @govhub/verify's testnet vote
// scheme (Core verifies the binary vote hash there, not a signed message). Each vote's expected signer is the voting
// address Core itself lists for the masternode owning the vote's collateral outpoint (`protx list registered true`),
// so the fixture does not depend on the bridge's own verdicts. Public chain data only; prints JSON to stdout.
//
//   docker compose run --rm --no-deps -v "$PWD/../services/bridge/scripts:/app/services/bridge/scripts:ro" \
//     --entrypoint node bridge scripts/record-testnet-votes.ts > ../packages/verify/test/fixtures/testnet-votes.json
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.ts';
import { CoreRpc } from '../src/core/rpc.ts';

const cfg = loadConfig();
if (cfg.coreNetwork !== 'testnet') throw new Error(`CORE_NETWORK is ${cfg.coreNetwork}; this records testnet votes only`);
const db = new Database(cfg.dbPath, { readonly: true });
const rpc = new CoreRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword });

const height = await rpc.getBlockCount();
const version = ((await rpc.call<{ subversion: string }>('getnetworkinfo')).subversion);
const mns = await rpc.call<Array<{ proTxHash: string; collateralHash: string; collateralIndex: number; state: { votingAddress: string } }>>('protx', ['list', 'registered', true, height]);
const byOutpoint = new Map(mns.map((m) => [`${m.collateralHash}-${m.collateralIndex}`, m]));

type Row = { hash: string; raw_hex: string; collateral_txid: string; collateral_n: number; parent_hash: string };
const rows = db.prepare('SELECT hash, raw_hex, collateral_txid, collateral_n, parent_hash FROM votes WHERE length(sig_hex) = 130 ORDER BY hash').all() as Row[];
const votes = rows.flatMap((v) => {
  const mn = byOutpoint.get(`${v.collateral_txid}-${v.collateral_n}`);
  if (!mn) { console.error(`skip ${v.hash}: no registered masternode for ${v.collateral_txid}-${v.collateral_n} at ${height}`); return []; }
  return [{ hash: v.hash, govHash: v.parent_hash, rawHex: v.raw_hex, proTxHash: mn.proTxHash, votingAddress: mn.state.votingAddress }];
});
process.stdout.write(JSON.stringify({
  recordedAt: new Date().toISOString(),
  source: `ZMQ rawgovernancevote from testnet dashd ${version} (R730 CT 185) during a governance re-sync; voting addresses from protx list registered true ${height}`,
  height,
  votes,
}, null, 1) + '\n');
