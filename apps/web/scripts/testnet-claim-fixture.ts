// One-time testnet setup for the live claim test: publishes a SYNTHETIC proposal into the testnet `gov` contract whose
// payment address is a key we hold, so a payment-address claim can be exercised end to end. No real mainnet
// proposal has a payout key we control.
//
//   npx vite-node scripts/testnet-claim-fixture.ts
//
// - Signs as the phase-0 spike owner (the gov contract's owner, the only identity allowed to create `proposal`).
// - The claim key is a fresh mainnet-format secp256k1 key kept OUTSIDE the repo in
//   ~/.local/share/govhub-phase0/testnet/claim-test.json (0600); it holds no funds and never will.
// - The proposal ended on 2026-10-01 (it lists under Past, not Active), its URL is not a portal URL (so method 1 does
//   not apply), and its collateral txid is a placeholder: the browser's collateral check reports it as failed, which is
//   the truth. Its gov hash is computed correctly from dataHex, so the claim verifier accepts the data as committed.
// Idempotent: an existing document with the same name is reused.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildProposalDataHex, encodeWif, governanceObjectHash, hash160, hexToBytes, p2pkhAddress } from '@govhub/verify';
import { connect } from './live-lib.ts';

export const CLAIM_KEY_FILE = join(homedir(), '.local/share/govhub-phase0/testnet/claim-test.json');
const GOV = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
const NAME = 'govhub-claim-test';
const TIME = 1_790_000_000; // 2026-09-21
const END = 1_790_812_800; // 2026-10-01

interface ClaimKey {
  wif: string;
  address: string;
  govHash?: string;
  docId?: string;
}
const key: ClaimKey = existsSync(CLAIM_KEY_FILE)
  ? (JSON.parse(readFileSync(CLAIM_KEY_FILE, 'utf8')) as ClaimKey)
  : (() => {
      const priv = Uint8Array.from(randomBytes(32));
      return { wif: encodeWif(priv, true, 'mainnet'), address: p2pkhAddress(hash160(secp256k1.getPublicKey(priv, true)), 'mainnet') };
    })();
const save = () => {
  writeFileSync(CLAIM_KEY_FILE, JSON.stringify(key, null, 2) + '\n');
  chmodSync(CLAIM_KEY_FILE, 0o600);
};
save();

const url = 'https://example.org/govhub-claim-test';
const dataHex = buildProposalDataHex({ type: 1, name: NAME, paymentAddress: key.address, paymentAmount: 1, startEpoch: TIME, endEpoch: END, url });
const govHash = governanceObjectHash({ parentHash: '0', revision: 1, time: TIME, dataHex }).display;
console.log(`claim-test proposal ${NAME}: govHash ${govHash}, pays ${key.address}`);

const { queryDocs, signerFor, stableBalance } = await connect();
const found = await queryDocs(GOV, 'proposal', [['name', '==', NAME]], [['name', 'asc'], ['$createdAt', 'asc']], 10);
if (found.length) {
  Object.assign(key, { govHash, docId: String(found[0]!.$id) });
  save();
  console.log(`already published: ${key.docId}`);
  process.exit(0);
}

const owner = signerFor('owner');
const before = await stableBalance(owner.identityId);
const r = await owner.create(GOV, 'proposal', {
  $createdAt: Date.now(),
  govHash: hexToBytes(govHash),
  parentHash: new Uint8Array(32),
  revision: 1,
  time: TIME,
  dataHex,
  name: NAME,
  url,
  paymentAddress: key.address,
  paymentAmount: 100_000_000,
  startEpoch: TIME,
  endEpoch: END,
  collateralTxid: sha256(new TextEncoder().encode('govhub-claim-test has no collateral')),
  collateralHeight: 1,
});
const after = await stableBalance(owner.identityId, before);
Object.assign(key, { govHash, docId: r.id });
save();
console.log(`published ${r.id}; owner paid ${before - after} credits (${Number(before - after) / 1e11} DASH)`);
process.exit(0);
