// The bridge in PUBLISH mode on the recorded mainnet fixtures (services/bridge/test/fixtures: 28 proposals, their real signed
// votes, the masternode list; Core's answers recorded), writing to a REAL testnet gov contract through `Bridge.publishOnce`, the
// pass `bridge run` / `bridge publish --once` makes. Meant for a contract of the mainnet shape (the rehearsal contract registered by
// testnet-cost-pass.ts from gov.json), so it exercises slim proposals, the packed tally set and the final tallies end to end:
//   1. first pass: 28 slim proposals, one talliesSet page with every tally, the cycles;
//   2. second pass: nothing written;
//   3. one tally changes: the packed document is replaced once;
//   4. one proposal leaves the active set: its final per-proposal tally is created, the packed set drops it.
// The archive is written to DB_PATH so `scripts/readback.ts` can check what reads back from Platform with proofs.
//
//   DB_PATH=/tmp/fixture-publish.sqlite node scripts/fixture-publish.ts <gov contract id> <identity key file | dev-owner>
//
// `dev-owner`: the dev gov owner's HIGH key from ~/.local/share/govhub-phase0/testnet/state.json. Nothing secret is printed.
import { loadConfig } from '../src/config.ts';
import { PlatformClient } from '../src/publish/platform.ts';
import { Publisher } from '../src/publish/publisher.ts';
import { storeTally, type CoreComparison } from '../src/tally.ts';
import { fixtureBridge } from '../test/world.ts';
import { identityKeyFromArg } from './identity-key-arg.ts';

const [contractId, keyArg] = process.argv.slice(2);
const dbPath = process.env.DB_PATH;
if (!contractId || !keyArg || !dbPath) throw new Error('usage: DB_PATH=... fixture-publish.ts <gov contract id> <identity key file | dev-owner>');
const key = identityKeyFromArg(keyArg);

const b = await fixtureBridge();
const cfg = loadConfig({ GOV_CONTRACT_ID: contractId, BRIDGE_IDENTITY_KEY_FILE: '/dev/null', CORE_NETWORK: 'mainnet', PLATFORM_NETWORK: 'testnet', TALLY_PUBLISH_INTERVAL_S: '0' });
const run = b.lastRun!;
// The fixture MN list is a subset of mainnet's, so Core's threshold is aligned with it and every tally "agreed with Core" (the
// recorded tallies do: services/bridge/test/live-votes.test.ts); stored again with that comparison, as a live bridge does.
run.coreThreshold = run.threshold;
const agree = (): Map<string, CoreComparison> =>
  new Map(run.tallies.map((t) => [t.govHash, { govHash: t.govHash, match: true, core: { yes: t.weighted.yes, no: t.weighted.no, abstain: t.weighted.abstain, absoluteYes: t.absoluteYes }, bridge: { yes: t.weighted.yes, no: t.weighted.no, abstain: t.weighted.abstain, absoluteYes: t.absoluteYes }, missingSigned: [], extra: [] }]));
b.lastComparisons = agree();
for (const t of run.tallies) storeTally(b.db, t, b.lastComparisons.get(t.govHash)!);
b.core.blockchainSynced = b.core.governanceSynced = true;

const platform = new PlatformClient('testnet', contractId);
await platform.loadIdentity(key);
console.log(`contract ${contractId}: types ${Object.keys(platform.schemas).join(', ')}; slim proposal: ${!platform.hasProperty('proposal', 'url')}; packed: ${platform.hasDocType('talliesSet')}`);
b.platform = platform;
b.publisher = new Publisher(b.db, platform, cfg);

const pass = async (label: string) => {
  const s = (await b.publishOnce())!;
  const spent = BigInt(s.creditsBefore ?? 0) - BigInt(s.creditsAfter ?? 0);
  console.log(`${label}: created ${s.created}, replaced ${s.replaced}, unchanged ${s.unchanged}, adopted ${s.adopted}, held ${s.held}, failed ${s.failed}, skipped ${s.skipped.length}; ~${spent} credits (balance read right after the writes; may lag)`);
  return s;
};
const s1 = await pass('1. first pass');
const s2 = await pass('2. second pass');
// 3. a vote moves one tally (the stored row moves with it, as the next block's refresh would store it)
const moved = run.tallies[0]!;
moved.weighted.no += 1;
moved.unweighted.no += 1;
run.height += 1;
moved.asOfHeight = run.height;
b.lastComparisons = agree();
storeTally(b.db, moved, b.lastComparisons.get(moved.govHash)!);
const s3 = await pass('3. one tally changed');
// 4. the lowest-ranked proposal leaves the active set
const gone = run.tallies.pop()!;
const s4 = await pass(`4. ${gone.govHash.slice(0, 12)} left the active set`);
await b.db.backup(dbPath);
// every tally write of the whole run is the one final (a burst of finals for entries nobody published here is a failure)
const tallyWrites = b.db.prepare("SELECT COUNT(*) n FROM publish_log WHERE contract_id = ? AND doc_type = 'tally' AND ok = 1").get(contractId) as { n: number };
const finalDoc = await b.publisher.lookup('tally', gone.govHash);
const ok =
  s1.failed + s2.failed + s3.failed + s4.failed === 0 && s2.created + s2.replaced === 0 && s3.replaced === 1 && s4.created + s4.replaced === 2 &&
  tallyWrites.n === 1 && String(finalDoc?.data.rank) === '0' && finalDoc?.data.inNextBudget === false;
console.log(JSON.stringify({ contractId, dbPath, final: gone.govHash, finalDoc: finalDoc?.id, tallyWrites: tallyWrites.n, ok }));
process.exit(ok ? 0 : 1);
