// TESTNET smoke test of the hardened relay: a replayed vote Core already counts is refused (409 already-current), and a fresh
// immediate vote still goes through. Keys from testnet.yml, never printed. Results: scripts/results/live-relay-hardening.json.
//   RELAY=http://127.0.0.1:18791 SKIP_INDEXES=18,24 npx vite-node scripts/live-relay-hardening.ts <govHash>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWif } from '@govhub/verify';
import { HttpBridge } from '../src/data/bridge.ts';
import { votingAddressOf } from '../src/voting/masternodes.ts';
import { planImmediate, signPlanned } from '../src/voting/plan.ts';
import { RelayClient, RelayError } from '../src/voting/relay.ts';
import { testnetMnKeys } from './testnet-mn-keys.ts';

const here = dirname(fileURLToPath(import.meta.url));
const relay = new RelayClient(process.env.RELAY ?? 'http://127.0.0.1:18791');
const bridge = new HttpBridge('testnet bridge', process.env.BRIDGE ?? 'https://gov-bridge-testnet.dashhq.org');
const govHash = process.argv[2]!;
const out: Record<string, unknown> = { at: new Date().toISOString(), govHash, relay: relay.base };

// 1. replay: the bridge's counted votes are public, signed votes; re-submitting one must be refused before it is stored
// (a vote this relay relayed itself is answered idempotently with its stored record instead, so pick one it never saw)
const set = await bridge.votes(govHash);
const skip = new Set((process.env.SKIP_INDEXES ?? '').split(',').filter(Boolean).map(Number));
const pub = set.votes.find((v) => !skip.has(v.collateralIndex))!;
try {
  await relay.submit({ proTxHash: '', collateralTxid: pub.collateralTxid, collateralIndex: pub.collateralIndex, govHash, outcome: pub.outcome as 1 | 2 | 3, time: pub.time, releaseAt: pub.time, sig: pub.sig, voteHash: '' }, 'testnet');
  out.replay = 'ACCEPTED (bug)';
} catch (e) {
  out.replay = e instanceof RelayError ? { status: e.status, code: e.code } : String(e);
}
console.log('replay of a counted public vote:', JSON.stringify(out.replay));

// 2. a fresh immediate vote with masternode-6
const k = testnetMnKeys().find((x) => x.name === 'masternode-6')!;
const { privKey, compressed } = decodeWif(k.wif, 'testnet');
const addr = votingAddressOf(privKey, compressed, 'testnet');
const mn = (await bridge.mnlist()).masternodes.find((m) => m.votingAddress === addr && m.valid)!;
const p = planImmediate([{ mn, govHash, outcome: 3 }], new Map(), Math.floor(Date.now() / 1000)).ok[0]!;
const s = signPlanned(p, privKey, compressed, 'testnet');
privKey.fill(0);
const st = await relay.submit(s, 'testnet');
let last = st.status as string;
for (let i = 0; i < 12 && last !== 'confirmed'; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  last = (await relay.status(st.id))?.status ?? 'unknown';
}
out.fresh = { masternode: 'masternode-6', voteHash: s.voteHash, outcome: 'abstain', time: s.time, relayStatus: last };
console.log('fresh immediate vote:', last);
writeFileSync(join(here, 'results/live-relay-hardening.json'), JSON.stringify(out, null, 2) + '\n');
process.exit(0);
