// TESTNET live test of masternode voting through a relay, with the app's own planning/signing/relay code (src/voting/*):
// one immediate vote, one deferred vote (nTime = release time a few minutes ahead), and one deferred vote that is cancelled.
// Keys: ~/workspace/dash-network-configs/testnet.yml (never printed). Results (public data only): scripts/results/live-vote.json.
//
//   RELAY=http://127.0.0.1:18791 BRIDGE=https://gov-bridge-testnet.dashhq.org npx vite-node scripts/live-vote.ts <govHash> [deferMinutes]
//   ... live-vote.ts --check            re-checks every recorded vote in the relay and the bridge
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWif } from '@govhub/verify';
import { HttpBridge, type BridgeMasternode } from '../src/data/bridge.ts';
import { votingAddressOf } from '../src/voting/masternodes.ts';
import { planDeferred, planImmediate, signPlanned, type Intent } from '../src/voting/plan.ts';
import { cancelSignature, RelayClient } from '../src/voting/relay.ts';
import { testnetMnKeys } from './testnet-mn-keys.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, 'results/live-vote.json');
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const relay = new RelayClient(process.env.RELAY ?? 'http://127.0.0.1:18791');
const bridge = new HttpBridge('testnet bridge', process.env.BRIDGE ?? 'https://gov-bridge-testnet.dashhq.org');
const nowS = () => Math.floor(Date.now() / 1000);
const results: any = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { runs: [] };
const save = () => writeFileSync(FILE, JSON.stringify(results, null, 2) + '\n');

async function check() {
  for (const run of results.runs) {
    const set = await bridge.votes(run.govHash).catch(() => null);
    for (const v of run.votes) {
      const st = await relay.status(v.relayId).catch((e) => ({ error: String(e.message) }));
      const inBridge = set?.votes.find((x) => x.collateralTxid === v.collateralTxid && x.collateralIndex === v.collateralIndex);
      v.check = { at: new Date().toISOString(), relay: st, bridgeCurrent: inBridge ? { outcome: inBridge.outcome, time: inBridge.time, ours: inBridge.time === v.time && inBridge.outcome === v.outcome } : null };
      log(`${v.kind} ${v.name}: relay ${(st as any)?.status ?? (st as any)?.error}, bridge ${inBridge ? (v.check.bridgeCurrent.ours ? 'shows OUR vote' : `shows another vote (${inBridge.outcome}@${inBridge.time})`) : 'no vote'}`);
    }
  }
  save();
}

if (process.argv[2] === '--check') {
  await check();
  process.exit(0);
}

const govHash = process.argv[2]!;
const deferMin = Number(process.argv[3] ?? '10');
if (!/^[0-9a-f]{64}$/.test(govHash)) throw new Error('usage: live-vote.ts <govHash> [deferMinutes]');
const keys = testnetMnKeys();
const list = (await bridge.mnlist()).masternodes;
const pick = (name: string): { mn: BridgeMasternode; priv: Uint8Array; compressed: boolean } => {
  const k = keys.find((x) => x.name === name)!;
  const { privKey, compressed } = decodeWif(k.wif, 'testnet');
  const addr = votingAddressOf(privKey, compressed, 'testnet');
  const mn = list.find((m) => m.votingAddress === addr && m.valid);
  if (!mn) throw new Error(`${name}: no valid masternode votes with this key`);
  return { mn, priv: privKey, compressed };
};
const [a, b, c] = ['masternode-2', 'masternode-3', 'masternode-4'].map(pick) as [ReturnType<typeof pick>, ReturnType<typeof pick>, ReturnType<typeof pick>];
const now = nowS();
const run: any = { at: new Date().toISOString(), govHash, relay: relay.base, votes: [] };
results.runs.push(run);
const record = (kind: string, name: string, s: ReturnType<typeof signPlanned>, relayId: string, status: string) => {
  run.votes.push({ kind, name, proTxHash: s.proTxHash, collateralTxid: s.collateralTxid, collateralIndex: s.collateralIndex, outcome: s.outcome, time: s.time, releaseAt: s.releaseAt, voteHash: s.voteHash, relayId, statusAtSubmit: status });
  save();
};

// 1. immediate
{
  const intent: Intent = { mn: a.mn, govHash, outcome: 1 };
  const p = planImmediate([intent], new Map(), now).ok[0]!;
  const s = signPlanned(p, a.priv, a.compressed, 'testnet');
  const st = await relay.submit(s, 'testnet');
  log(`immediate YES masternode-2: relay ${st.status}, vote ${s.voteHash.slice(0, 16)}…`);
  record('immediate', 'masternode-2', s, st.id, st.status);
}
// 2. deferred (release in deferMin minutes, uniform in a 60 s window there so it is still random)
{
  const at = now + deferMin * 60;
  const p = planDeferred([{ mn: b.mn, govHash, outcome: 3 }], new Map(), now, { earliest: at, latest: at + 60 }).ok[0]!;
  const s = signPlanned(p, b.priv, b.compressed, 'testnet');
  const st = await relay.submit(s, 'testnet');
  log(`deferred ABSTAIN masternode-3: relay ${st.status}, release ${new Date(st.releaseAt * 1000).toISOString()}`);
  record('deferred', 'masternode-3', s, st.id, st.status);
}
// 3. deferred, then cancelled with a signed cancel
{
  const at = now + (deferMin + 5) * 60;
  const p = planDeferred([{ mn: c.mn, govHash, outcome: 2 }], new Map(), now, { earliest: at, latest: at + 60 }).ok[0]!;
  const s = signPlanned(p, c.priv, c.compressed, 'testnet');
  const st = await relay.submit(s, 'testnet');
  log(`deferred NO masternode-4: relay ${st.status}`);
  record('cancelled', 'masternode-4', s, st.id, st.status);
  // a cancel signed by ANOTHER voting key must be refused
  const forged = cancelSignature(a.priv, a.compressed, 'testnet', s.voteHash);
  const refused = await relay.cancel(st.id, forged).then(() => 'ACCEPTED (bug)', (e) => `refused (${(e as Error).message})`);
  log(`cancel signed by the wrong key: ${refused}`);
  const ok = await relay.cancel(st.id, cancelSignature(c.priv, c.compressed, 'testnet', s.voteHash));
  log(`cancel signed by masternode-4's voting key: ${ok}`);
  run.cancel = { wrongKey: refused, rightKey: ok };
  save();
}
for (const k of [a, b, c]) k.priv.fill(0);
await new Promise((r) => setTimeout(r, 20_000));
await check();
process.exit(0);
