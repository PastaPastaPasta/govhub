// One-shot: publishes the packed `talliesSet` page 0 of a gov contract from what a running bridge reports, through the bridge's own
// publisher code (tallySetEntry/tallySetProps + Publisher.upsert, with a throwaway archive). For a contract that just got
// `talliesSet` while its bridge still runs a version without it (testnet rollout): the deployed bridge adopts and replaces this
// document on its first publish. Fail closed like the publisher: an entry goes out only when Core agreed with the bridge AND the
// bridge's stored record in force at the set's height (what a reader recounts against) has the same vote set and counts.
//
//   node scripts/publish-tally-set.ts <bridge base URL> <identity key file | dev-owner> [--dry] [--replace]
//
// An existing page 0 is left alone unless --replace is given (a one-shot run must not overwrite what a newer bridge wrote).
//
// `dev-owner` reads the dev gov owner's HIGH key from ~/.local/share/govhub-phase0/testnet/state.json. Nothing secret is printed.
// Results (fee, height, entries): appended to scripts/results/publish-tally-set.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TALLY_SET_ENTRY_BYTES, TALLY_SET_HEADER_BYTES } from '@govhub/verify';
import { openArchive } from '../src/archive/db.ts';
import { loadConfig } from '../src/config.ts';
import { displayHashB64, PlatformClient } from '../src/publish/platform.ts';
import { Publisher, tallySetEntry, tallySetProps } from '../src/publish/publisher.ts';
import type { ComputedTally } from '../src/tally.ts';
import { identityKeyFromArg } from './identity-key-arg.ts';

const [base, keyArg, ...flags] = process.argv.slice(2);
if (!base || !keyArg) throw new Error('usage: publish-tally-set.ts <bridge base URL> <identity key file | dev-owner> [--dry]');
const dry = flags.includes('--dry');
const replace = flags.includes('--replace');
const here = dirname(fileURLToPath(import.meta.url));
const get = async (path: string) => {
  const r = await fetch(`${base.replace(/\/+$/, '')}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<any>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const key = identityKeyFromArg(keyArg);

const status = await get('/v1/status');
const contractId: string = status.govContractId;
const t = await get('/v1/tallies');
const H: number = t.asOfHeight;
// like the publisher: a funding threshold that differs from Core's makes every margin and inNextBudget suspect
const cycle = await get('/v1/cycle');
if (cycle.governance?.fundingthreshold !== t.fundingThreshold) throw new Error(`funding threshold ${t.fundingThreshold} differs from Core's ${cycle.governance?.fundingthreshold}: not publishing`);
console.log(`bridge ${base}: ${status.network}, contract ${contractId}, ${t.tallies.length} tallies as of block ${H}`);

const platform = new PlatformClient('testnet', contractId);
await platform.loadIdentity(key);
if (!platform.hasDocType('talliesSet')) throw new Error(`contract ${contractId} has no talliesSet type (update it first)`);

const entries: ComputedTally[] = [];
const skipped: Array<{ govHash: string; reason: string }> = [];
for (const x of t.tallies as any[]) {
  const why = await (async () => {
    if (!x.core?.match) return 'Core did not agree (or was not asked)';
    // the record in force at H is what a reader recounts the entry against
    const v = await get(`/v1/proposals/${x.govHash}/votes?height=${H}`);
    if (v.tallyHeight > H || v.voteSetHash !== x.voteSetHash || v.yesWeighted !== x.yesWeighted || v.noWeighted !== x.noWeighted || v.abstainWeighted !== x.abstainWeighted) return `stored record at ${v.tallyHeight} differs from the live tally (votes since the block)`;
    if (!(await platform.query('proposal', { where: [['govHash', '==', displayHashB64(x.govHash)]], limit: 1 })).length) return 'proposal not on Platform';
    return null;
  })();
  if (why) skipped.push({ govHash: x.govHash, reason: why });
  else entries.push({ govHash: x.govHash, weighted: { yes: x.yesWeighted, no: x.noWeighted, abstain: x.abstainWeighted }, unweighted: { yes: x.yesCount, no: x.noCount, abstain: x.abstainCount }, voteSetHash: x.voteSetHash, rank: x.rank, inNextBudget: x.inNextBudget, margin: x.margin } as ComputedTally);
}
console.log(`${entries.length} entries; skipped ${skipped.length}${skipped.length ? `: ${JSON.stringify(skipped)}` : ''}`);
const props = tallySetProps(0, H, entries.map(tallySetEntry));
if (dry) process.exit(0);
const existing = (await platform.query('talliesSet', { where: [['page', '==', 0]], limit: 1 }))[0];
if (existing && !replace) {
  console.log(`page 0 exists (doc ${existing.id}, revision ${existing.revision}, asOfHeight ${String(existing.data.asOfHeight)}): not replaced without --replace`);
  process.exit(0);
}

const cfg = loadConfig({ GOV_CONTRACT_ID: contractId, BRIDGE_IDENTITY_KEY_FILE: '/dev/null', PLATFORM_NETWORK: 'testnet', CORE_NETWORK: status.network });
const publisher = new Publisher(openArchive(':memory:'), platform, cfg);
const stable = async () => {
  let last = await platform.balance();
  for (let i = 0; i < 10; i++) {
    await sleep(1200);
    const b = await platform.balance();
    if (b === last) return b;
    last = b;
  }
  return last;
};
const before = await stable();
const op = await publisher.upsert('talliesSet', '0', props, { minIntervalSec: 0 });
let after = before;
for (let i = 0; i < 40 && after === before; i++) {
  await sleep(1500);
  after = await stable();
}
const doc = await publisher.lookup('talliesSet', '0');
const out = { at: new Date().toISOString(), bridge: base, coreNetwork: status.network, contractId, publisher: key.identityId, op, docId: doc?.id, revision: doc?.revision, asOfHeight: H, entries: entries.length, skipped, packedBytes: TALLY_SET_HEADER_BYTES + TALLY_SET_ENTRY_BYTES * entries.length, feeCredits: String(before - after), feeDash: (Number(before - after) / 1e11).toFixed(8) };
const file = join(here, 'results/publish-tally-set.json');
const all = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { runs: unknown[] }) : { runs: [] };
all.runs.push(out);
writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
