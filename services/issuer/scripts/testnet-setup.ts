// One-off TESTNET setup of the project's issuer (tooling, never shipped):
//   1. a new issuer identity from its own seed (separate from the bridge and moderation identities), funded with a 0.5 tDASH
//      asset-lock voucher from the EvoVote QA wallet (packages/auth/scripts/qa-funder.ts);
//   2. key files for it: critical.json (keyId 1: contract registration and issuerKey documents, stays offline) and
//      high.json (keyId 2: issuerReport documents, goes to the server);
//   3. a NEW `badge` contract registered from packages/contracts-v1/badge.json (the phase-0 one predates the spki cap).
// Everything secret stays in ~/.local/share/govhub-issuer-testnet/ (0700 dir, 0600 files). Prints no secrets. Re-runs resume.
//
//   cd services/issuer && npx vite-node scripts/testnet-setup.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDapi } from '@govhub/dapi';
import { bytesToHex, generatePhrase, parseVoucher, redeemVoucher, SeedWallet } from '@govhub/auth';
import { createEvoPlatform } from '@govhub/auth/evo';
import { qaFunder } from '../../../packages/auth/scripts/qa-funder.ts';

const DIR = join(homedir(), '.local/share/govhub-issuer-testnet');
const STATE = join(DIR, 'state.json');
const NET = 'testnet' as const;
const FUND_DUFFS = 50_000_000n; // 0.5 tDASH

interface State {
  phrase?: string;
  voucher?: { txid: string; link: string };
  identityId?: string;
  contract?: { id: string; credits: string; registeredAt: string };
}

function writePrivate(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}
mkdirSync(DIR, { recursive: true, mode: 0o700 });
chmodSync(DIR, 0o700);
const st: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writePrivate(STATE, st);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

st.phrase ??= generatePhrase(12);
save();
const wallet = SeedWallet.fromPhrase(st.phrase, NET);

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const platform = createEvoPlatform(evo, sdk, NET);
const dapi = createDapi({ network: NET });

if (!st.identityId) {
  if (!st.voucher) {
    const funder = qaFunder(dapi);
    const v = await funder.mintVoucher(FUND_DUFFS);
    st.voucher = { txid: v.txid, link: v.link };
    save();
    log(`funding asset lock ${v.txid} (${Number(FUND_DUFFS) / 1e8} tDASH from the QA wallet)`);
  }
  const r = await redeemVoucher({ voucher: parseVoucher(st.voucher.link, NET), wallet, identityIndex: 0, dapi, platform, onUpdate: (n) => log(`identity: ${n}`) });
  st.identityId = r.identityId;
  save();
  log(`issuer identity ${r.identityId} (${r.proofKind} proof)`);
}

const identityId = st.identityId;
for (const [name, keyId] of [['critical.json', 1], ['high.json', 2]] as const) {
  writePrivate(join(DIR, name), { identityId, keyId, privateKeyHex: bytesToHex(wallet.identityKey(0, keyId).privateKey) });
}
log(`key files written: critical.json (keyId 1, offline), high.json (keyId 2, server)`);

if (!st.contract) {
  const schemas = JSON.parse(readFileSync(new URL('../../../packages/contracts-v1/badge.json', import.meta.url), 'utf8'));
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error('issuer identity not found');
  const before = BigInt((await sdk.identities.balance(identityId)) ?? 0n);
  const nonce = BigInt((await sdk.identities.nonce(identityId)) ?? 0n) + 1n;
  const dc = new evo.DataContract({ ownerId: identityId, identityNonce: nonce, schemas, fullValidation: true, platformVersion: sdk.version() } as never);
  const signer = new evo.IdentitySigner();
  signer.addKey(evo.PrivateKey.fromBytes(wallet.identityKey(0, 1).privateKey, NET));
  const pub = await sdk.contracts.publish({ dataContract: dc, identityKey: identity.getPublicKeyById(1)!, signer } as never);
  const id = (pub as { id: { toString(): string } }).id.toString();
  let back = null;
  for (let i = 0; i < 10 && !back; i++) {
    back = await sdk.contracts.fetch(id);
    if (!back) await new Promise((r) => setTimeout(r, 2000));
  }
  const after = BigInt((await sdk.identities.balance(identityId)) ?? 0n);
  st.contract = { id, credits: (before - after).toString(), registeredAt: new Date().toISOString() };
  save();
  log(`badge contract ${id} registered (${Number(before - after) / 1e11} DASH), read back: ${back ? 'yes' : 'NO'}`);
}

const bal = BigInt((await sdk.identities.balance(identityId)) ?? 0n);
console.log(JSON.stringify({ identityId, contractId: st.contract.id, balanceDash: Number(bal) / 1e11 }, null, 2));
process.exit(0);
