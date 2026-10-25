// One-off TESTNET setup of the starter issuer identity (tooling, never shipped). The starter keys are `issuerKey` documents in the
// existing `badge` contract, owned by an identity used for nothing else, so a starter key can never pass as a badge key (readers
// trust badge issuers by identity) and the key material is separate from the badge issuer's:
//   1. a new identity from its own seed, funded with a 0.05 tDASH asset-lock voucher from the EvoVote QA wallet
//      (packages/auth/scripts/qa-funder.ts);
//   2. key files for it: critical.json (keyId 1: issuerKey documents, stays offline) and high.json (keyId 2, unused for now).
// Then, from services/issuer:
//   node bin/issuer.mjs keygen --purpose starter --dir ~/.local/share/govhub-starter-testnet/keys --from <E> --epochs 14
//   node bin/issuer.mjs publish-keys --purpose starter --dir ~/.local/share/govhub-starter-testnet/keys \
//     --identity-file ~/.local/share/govhub-starter-testnet/critical.json --contract 2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU --network testnet
// Everything secret stays in ~/.local/share/govhub-starter-testnet/ (0700 dir, 0600 files). Prints no secrets. Re-runs resume.
//
//   cd services/issuer && npx vite-node scripts/testnet-starter-setup.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDapi } from '@govhub/dapi';
import { bytesToHex, generatePhrase, parseVoucher, redeemVoucher, SeedWallet } from '@govhub/auth';
import { createEvoPlatform } from '@govhub/auth/evo';
import { qaFunder } from '../../../packages/auth/scripts/qa-funder.ts';

const DIR = join(homedir(), '.local/share/govhub-starter-testnet');
const STATE = join(DIR, 'state.json');
const NET = 'testnet' as const;
const FUND_DUFFS = 5_000_000n; // 0.05 tDASH: the identity plus a few dozen issuerKey documents

interface State {
  phrase?: string;
  voucher?: { txid: string; link: string };
  identityId?: string;
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
    const v = await qaFunder(dapi).mintVoucher(FUND_DUFFS);
    st.voucher = { txid: v.txid, link: v.link };
    save();
    log(`funding asset lock ${v.txid} (${Number(FUND_DUFFS) / 1e8} tDASH from the QA wallet)`);
  }
  const r = await redeemVoucher({ voucher: parseVoucher(st.voucher.link, NET), wallet, identityIndex: 0, dapi, platform, onUpdate: (n) => log(`identity: ${n}`) });
  st.identityId = r.identityId;
  delete st.voucher; // spent: the link carries a key that is useless now, but there is no reason to keep it
  save();
  log(`starter issuer identity ${r.identityId} (${r.proofKind} proof)`);
}

const identityId = st.identityId;
for (const [name, keyId] of [['critical.json', 1], ['high.json', 2]] as const) {
  writePrivate(join(DIR, name), { identityId, keyId, privateKeyHex: bytesToHex(wallet.identityKey(0, keyId).privateKey) });
}
log('key files written: critical.json (keyId 1, offline), high.json (keyId 2)');
const bal = BigInt((await sdk.identities.balance(identityId)) ?? 0n);
console.log(JSON.stringify({ identityId, balanceDash: Number(bal) / 1e11 }, null, 2));
process.exit(0);
