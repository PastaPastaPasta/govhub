// Live TESTNET run of the starter credit, end to end, through the web app's own starter code (apps/web/src/starter/client.ts, the
// badge worker operations, the badge reader for the PROVED starter key) and the real funding flow (@govhub/auth runFunding):
//   masternode: voting-key request -> blind token -> faucet pays the new account's funding address -> asset lock + identity
//   proposal:   payment-address request (the QA wallet is the payout address of the test proposal) -> the same
// then the refusals: a second request for the same masternode / proposal (already-issued), and a faucet replay (same txid).
//
//   ISSUER_URL=http://127.0.0.1:8789 FAUCET_URL=http://127.0.0.1:8787 npx vite-node scripts/starter-live.ts [mn|proposal|all]
//
// MN voting keys come from ~/workspace/dash-network-configs/testnet.yml (owner key = voting key on these MNs; only MNs whose bridge
// voting address matches are used; the owner's reserved MNs, RESERVED_TESTNET_MNS in testnet-mn-keys.ts, are never used). The proposal key is the QA wallet's.
// State (phrases) in ~/.local/share/govhub-starter-live/ (0700/0600). Results (public data only: no keys, and on purpose no
// masternode/proposal next to the identity it funded) go to scripts/results/starter-live.json. Prints no keys.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDapi } from '@govhub/dapi';
import { generatePhrase, hexToBytes, runFunding, SeedWallet, storageFundingStore } from '@govhub/auth';
import { createEvoPlatform } from '@govhub/auth/evo';
import { decodeWif, encodeAddress, hash160, signMessage } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { defaultRegistry } from '../src/config/registry.ts';
import { BADGE_NETWORKS } from '../src/badge/config.ts';
import { badgeQuery } from '../src/badge/queries.ts';
import { BadgeReader } from '../src/badge/reader.ts';
import { handleBadgeCall } from '../src/badge/workerOps.ts';
import { fundingTarget, prepareStarterRequest, redeemStarter, requestMnStarter, signWithWif, StarterError, submitProposalStarter, type StarterDeps, type StarterToken } from '../src/starter/client.ts';
import { STARTER_ISSUERS } from '../src/starter/config.ts';
import { RESERVED_TESTNET_MNS, testnetMnKeys } from './testnet-mn-keys.ts';

const NET = 'testnet' as const;
const DIR = join(homedir(), '.local/share/govhub-starter-live');
const STATE = join(DIR, 'state.json');
const QA_KEY = join(homedir(), '.local/share/evovote-v2-qa-20261018/wallet.key');
const BRIDGE = 'https://gov-bridge-testnet.dashhq.org';
const RESULTS = new URL('./results/starter-live.json', import.meta.url);
const which = process.argv[2] ?? 'all';

interface State {
  phrases: Record<string, string>;
  usedMns: string[];
  usedProposals: string[];
}
mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { phrases: {}, usedMns: [], usedProposals: [] };
const save = () => {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(st, null, 2), { mode: 0o600 });
  renameSync(`${STATE}.tmp`, STATE);
};
const results: Record<string, unknown> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
const record = (k: string, v: unknown) => {
  results[k] = v;
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
};
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${m}`);


const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const port = createEvoPlatform(evo, sdk, NET);
const dapi = createDapi({ network: NET });
const registry = { ...defaultRegistry(), platformNetwork: NET } as ReturnType<typeof defaultRegistry>;
const contractId = BADGE_NETWORKS.testnet.contractId;
const reader = new BadgeReader({ net: NET, contractId, query: (q) => badgeQuery(registry, contractId, q), issuers: [] });
const issuer = { ...STARTER_ISSUERS.testnet!, url: process.env.ISSUER_URL ?? 'http://127.0.0.1:8789' };
const asTrusted = { name: 'starter', ...issuer, enabled: true };
const deps: StarterDeps = {
  network: NET,
  issuer,
  faucetUrl: process.env.FAUCET_URL ?? 'http://127.0.0.1:8787',
  coreHeight: () => reader.coreHeight(),
  issuerKey: (e) => reader.key(asTrusted, e),
  worker: ((call: Parameters<typeof handleBadgeCall>[0]) => handleBadgeCall(call)) as StarterDeps['worker'],
};

/** In-memory Storage for the funding records (one run). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear() };
}

/** New account funded by `token`: the faucet is asked once the deposit watcher is live; the identity is made with the seed's keys. */
async function fundWithStarter(label: string, wallet: SeedWallet, token: StarterToken) {
  const target = fundingTarget(wallet, 0);
  let redeem: Promise<{ txid: string; replay: boolean; amountSats: number }> | null = null;
  let paidAt = 0;
  const r = await runFunding({
    wallet, dapi, platform: port, store: storageFundingStore(memoryStorage()), kind: 'create', identityIndex: 0,
    onUpdate: (v) => {
      if (v.state === 'awaiting-deposit' && !redeem) {
        log(`${label}: funding watcher live; asking the faucet`);
        redeem = redeemStarter(deps, token, target.address).then((x) => ((paidAt = Date.now()), log(`${label}: faucet paid ${x.amountSats} duffs, tx ${x.txid}`), x));
        redeem.catch((e) => log(`${label}: faucet refused: ${(e as Error).message}`));
      } else log(`${label}: ${v.state}${v.isLocked ? ' (IS-locked)' : ''}${v.note ? ` - ${v.note}` : ''}`);
    },
  });
  const paid = await redeem!;
  const replay = await redeemStarter(deps, token, target.address);
  return { identityId: r.identityId, payoutTxid: paid.txid, amountSats: paid.amountSats, lockTxid: r.record.lock?.txid, proofKind: r.record.proofKind, secondsPaidToIdentity: Math.round((Date.now() - paidAt) / 1000), replay: { replay: replay.replay, sameTxid: replay.txid === paid.txid } };
}

async function refusedAgain(what: () => Promise<unknown>): Promise<string> {
  try {
    await what();
    return 'NOT REFUSED';
  } catch (e) {
    return e instanceof StarterError ? `${e.code}: ${e.message}` : `error: ${(e as Error).message}`;
  }
}

const fresh = (k: string) => {
  st.phrases[k] ??= generatePhrase(12);
  save();
  return SeedWallet.fromPhrase(st.phrases[k]!, NET);
};

const height = await deps.coreHeight();
log(`platform core height ${height}`);
record('run', { at: new Date().toISOString(), platformCoreHeight: height, issuer: issuer.identityId, faucet: deps.faucetUrl });

if (which === 'mn' || which === 'all') {
  // the shared helper drops the owner's reserved MNs (RESERVED_TESTNET_MNS: masternode-27/41/43, hp-masternode-23)
  const keys = new Map(testnetMnKeys().map((k) => [k.name, k.wif]));
  for (const name of st.usedMns) if (RESERVED_TESTNET_MNS.has(name)) throw new Error(`state used reserved ${name}: refusing`);
  const list = (await (await fetch(`${BRIDGE}/v1/mnlist`)).json()) as { masternodes: Array<{ proTxHash: string; votingAddress: string; valid: boolean }> };
  const byAddr = new Map(list.masternodes.filter((m) => m.valid).map((m) => [m.votingAddress, m.proTxHash]));
  let pick: { name: string; wif: string; proTxHash: string } | null = null;
  for (const [name, wif] of keys) {
    if (st.usedMns.includes(name)) continue;
    const { privKey, compressed } = decodeWif(wif, NET);
    const pro = byAddr.get(encodeAddress('p2pkh', hash160(secp256k1.getPublicKey(privKey, compressed)), NET));
    if (pro) {
      pick = { name, wif, proTxHash: pro };
      break;
    }
  }
  if (!pick) throw new Error('no usable valid testnet MN in testnet.yml');
  log(`masternode: using a testnet.yml MN (not recorded)`);
  const w = fresh(`mn-${pick.name}`);
  const token = await requestMnStarter(deps, { proTxHash: pick.proTxHash, pubKeyHash: fundingTarget(w, 0).pubKeyHash, sign: (req) => signWithWif(req, pick!.wif, NET) });
  log(`masternode: token for epoch ${token.epoch}`);
  st.usedMns.push(pick.name);
  save();
  const funded = await fundWithStarter('masternode', w, token);
  const again = await refusedAgain(() => requestMnStarter(deps, { proTxHash: pick!.proTxHash, pubKeyHash: fundingTarget(fresh(`mn-${pick!.name}-again`), 0).pubKeyHash, sign: (req) => signWithWif(req, pick!.wif, NET) }));
  log(`masternode: second request -> ${again}`);
  record('masternode', { epoch: token.epoch, ...funded, secondRequest: again });
}

if (which === 'proposal' || which === 'all') {
  const key = hexToBytes(readFileSync(QA_KEY, 'utf8').trim());
  const payTo = encodeAddress('p2pkh', hash160(secp256k1.getPublicKey(key, true)), NET);
  const props = (await (await fetch(`${BRIDGE}/v1/proposals`)).json()) as { proposals: Array<{ govHash: string; dataHex: string }> };
  const p = props.proposals.find((x) => !st.usedProposals.includes(x.govHash) && Buffer.from(x.dataHex, 'hex').toString('utf8').includes(`"payment_address":"${payTo}"`));
  if (!p) throw new Error('no unused testnet proposal pays the QA wallet');
  log('proposal: using a test proposal that pays the QA wallet (not recorded)');
  const sign = async (pending: Awaited<ReturnType<typeof prepareStarterRequest>>) => submitProposalStarter(deps, pending, payTo, signMessage(key, pending.request, { compressed: true }));
  const w = fresh(`proposal-${p.govHash}`);
  const token = await sign(await prepareStarterRequest(deps, { kind: 'proposal', subject: p.govHash, pubKeyHash: fundingTarget(w, 0).pubKeyHash }));
  log(`proposal: token for epoch ${token.epoch}`);
  st.usedProposals.push(p.govHash);
  save();
  const funded = await fundWithStarter('proposal', w, token);
  const again = await refusedAgain(async () => sign(await prepareStarterRequest(deps, { kind: 'proposal', subject: p.govHash, pubKeyHash: fundingTarget(fresh(`proposal-${p.govHash}-again`), 0).pubKeyHash })));
  log(`proposal: second request -> ${again}`);
  record('proposal', { epoch: token.epoch, ...funded, secondRequest: again });
}
log('done');
process.exit(0);
