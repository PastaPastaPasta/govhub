#!/usr/bin/env node
// Generates test/fixtures/claims.regtest.json from a REAL Dash Core regtest node.
//
// Test vectors for the "proposal ownership claim" verifier: Core's own `signmessage` / `verifymessage`
// over messages of the form
//
//   govhub-claim|<net>|<govHash>|<identityId>
//
// This script talks only to dash-cli (never to @govhub/verify), so the fixture contains what Core says,
// independent of our implementation. Usage:
//
//   DASH_CLI="/path/to/dash-cli -datadir=... -regtest -rpcport=... -rpcuser=.. -rpcpassword=.." \
//     node scripts/gen-claim-vectors.mjs
//
// The node must already be running with -txindex=1 and have a funded LEGACY (non-descriptor) wallet named "w"
// (>= 200 blocks mined to one of its addresses) so that `signmessage` works. Everything produced is regtest
// data (worthless keys).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

const cliParts = (process.env.DASH_CLI ?? '').split(/\s+/).filter(Boolean);
if (cliParts.length === 0) throw new Error('set DASH_CLI');
const [bin, ...baseArgs] = cliParts;

/** Run dash-cli; returns stdout trimmed. Errors are returned as {error} when `soft`. */
function cli(args, { wallet = 'w', soft = false } = {}) {
  const full = [...baseArgs, ...(wallet ? [`-rpcwallet=${wallet}`] : []), ...args.map(String)];
  try {
    return execFileSync(bin, full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (!soft) throw e;
    return { error: String(e.stderr ?? e.message).trim() };
  }
}
const json = (args, opts) => {
  const out = cli(args, opts);
  if (typeof out !== 'string') return out;
  return JSON.parse(out);
};
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

// ---- base58 (Bitcoin alphabet), leading zero bytes -> '1' -------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
const randomId = () => base58(randomBytes(32));

// gobject prepare/submit refuse to run until the (regtest, peerless) node believes it is synced.
cli(['mnsync', 'next'], { wallet: null, soft: true });
cli(['mnsync', 'next'], { wallet: null, soft: true });

const now = Math.floor(Date.now() / 1000);
const start = now;
const end = now + 3 * 365 * 86400;

// ---- addresses and identities ----------------------------------------------------------------
const addrA = cli(['getnewaddress']);
const addrB = cli(['getnewaddress']);
const pubB = json(['getaddressinfo', addrB]).pubkey;
const pubC = json(['getaddressinfo', cli(['getnewaddress'])]).pubkey;
const p2sh = json(['createmultisig', 1, JSON.stringify([pubB, pubC])]).address;

const I1 = randomId();
const I2 = randomId();
const identities = { I1, I2 };

// ---- proposals -------------------------------------------------------------------------------
// compact JSON, keys sorted alphabetically (the literal below is already in sorted order)
const data = (o) =>
  JSON.stringify({
    end_epoch: end,
    name: o.name,
    payment_address: o.payment_address,
    payment_amount: 10,
    start_epoch: start,
    type: 1,
    url: o.url,
  });

const specs = [
  { label: 'url-embedded', name: 'claim-url', payment_address: addrA, url: `https://gov.dashhq.org/p/${I1}/claim-url` },
  { label: 'pay-p2pkh', name: 'claim-pay', payment_address: addrA, url: 'https://example.org/claim-pay' },
  { label: 'pay-p2sh', name: 'claim-p2sh', payment_address: p2sh, url: 'https://example.org/claim-p2sh' },
  { label: 'url-wrong-name', name: 'claim-url-x', payment_address: addrB, url: `https://gov.dashhq.org/p/${I2}/some-other-name` },
].map((s, i) => ({ label: s.label, parentHash: '0', revision: 1, time: now + i, dataHex: hex(data(s)) }));

for (const s of specs) {
  s.collateralTxid = cli(['gobject', 'prepare', s.parentHash, s.revision, s.time, s.dataHex]);
}
const mineAddr = cli(['getnewaddress']);
cli(['generatetoaddress', 8, mineAddr]);

const prepared = json(['gobject', 'list-prepared', 100]);
const proposals = [];
for (const s of specs) {
  const m = prepared.find((o) => o.collateralHash === s.collateralTxid);
  if (!m) throw new Error('prepared object not found for ' + s.label);
  if (m.data.hex !== s.dataHex) throw new Error('data hex mismatch for ' + s.label);
  const dec = json(['getrawtransaction', s.collateralTxid, 'true']);
  const collateralInputs = dec.vin.map((vin) => {
    if (!vin.txid) throw new Error('collateral input without txid (coinbase?) in ' + s.label);
    const prev = json(['getrawtransaction', vin.txid, 'true']);
    const spk = prev.vout[vin.vout].scriptPubKey;
    return {
      address: spk.address ?? spk.addresses?.[0] ?? null,
      type: spk.type,
      prevTxid: vin.txid,
      prevVout: vin.vout,
    };
  });
  proposals.push({
    label: s.label,
    parentHash: m.parentHash,
    revision: m.revision,
    time: m.createdAt,
    dataHex: m.data.hex,
    govHash: m.objectHash,
    collateralTxid: s.collateralTxid,
    rawCollateralTx: cli(['getrawtransaction', s.collateralTxid]),
    collateralInputs,
  });
}
const byLabel = (l) => proposals.find((p) => p.label === l);

// ---- signatures ------------------------------------------------------------------------------
const msg = (net, hash, id) => `govhub-claim|${net}|${hash}|${id}`;
const rawOrder = (h) => Buffer.from(h, 'hex').reverse().toString('hex');
const verify = (address, sig, message) => {
  const r = cli(['verifymessage', address, sig, message], { soft: true });
  if (typeof r !== 'string') return false; // Core errors (e.g. malformed) count as "not accepted"
  return r === 'true';
};

const signatures = [];
const errors = [];

/** Sign with Core; `negAddress`/`negMessage` define the negative pairing (one of them differs). */
function addSig({ label, proposal, method, address, identity, net, message, negAddress = address, negMessage = message }) {
  const sig = cli(['signmessage', address, message]);
  const coreVerify = verify(address, sig, message);
  const negCore = verify(negAddress, sig, negMessage);
  if (!coreVerify) throw new Error('Core rejected its own signature for ' + label);
  if (negCore) throw new Error('negative pairing unexpectedly verified for ' + label);
  signatures.push({
    label,
    proposal,
    method,
    address,
    identity,
    net,
    message,
    sigBase64: sig,
    coreVerify,
    negative: { address: negAddress, message: negMessage, coreVerify: negCore },
  });
}

const payP2pkh = byLabel('pay-p2pkh');
const urlEmbedded = byLabel('url-embedded');

// method 2: payment-address signatures
addSig({
  label: 'pay-p2pkh-valid',
  proposal: 'pay-p2pkh',
  method: 2,
  address: addrA,
  identity: 'I1',
  net: 'regtest',
  message: msg('regtest', payP2pkh.govHash, I1),
  // same signature checked against the message that names the OTHER identity
  negMessage: msg('regtest', payP2pkh.govHash, I2),
});
addSig({
  label: 'pay-p2pkh-wrong-signer',
  proposal: 'pay-p2pkh',
  method: 2,
  address: addrB,
  identity: 'I1',
  net: 'regtest',
  message: msg('regtest', payP2pkh.govHash, I1),
  // B's signature does not verify against the proposal's payment address A
  negAddress: addrA,
});

// method 3: collateral-input signatures (first collateral input address, identity I2)
for (const p of [payP2pkh, urlEmbedded]) {
  const inAddr = p.collateralInputs[0].address;
  if (!inAddr) throw new Error('no collateral input address for ' + p.label);
  addSig({
    label: `collateral-${p.label}`,
    proposal: p.label,
    method: 3,
    address: inAddr,
    identity: 'I2',
    net: 'regtest',
    message: msg('regtest', p.govHash, I2),
    negMessage: msg('regtest', p.govHash, I1),
  });
}

// net binding: signature over a "mainnet" message must not verify for the "regtest" message
addSig({
  label: 'net-mainnet',
  proposal: 'pay-p2pkh',
  method: 2,
  address: addrA,
  identity: 'I1',
  net: 'mainnet',
  message: msg('mainnet', payP2pkh.govHash, I1),
  negMessage: msg('regtest', payP2pkh.govHash, I1),
});

// byte order: signature over the RAW (byte-reversed) govHash must not verify for the display-order message
addSig({
  label: 'govhash-raw-order',
  proposal: 'pay-p2pkh',
  method: 2,
  address: addrA,
  identity: 'I1',
  net: 'regtest',
  message: msg('regtest', rawOrder(payP2pkh.govHash), I1),
  negMessage: msg('regtest', payP2pkh.govHash, I1),
});

// P2SH payment address: Core cannot sign for it
{
  const p2shProp = byLabel('pay-p2sh');
  const message = msg('regtest', p2shProp.govHash, I1);
  const r = cli(['signmessage', p2sh, message], { soft: true });
  if (typeof r === 'string') throw new Error('signmessage unexpectedly succeeded for a P2SH address');
  errors.push({ label: 'pay-p2sh-signmessage', address: p2sh, message, coreError: r.error });
}

writeFileSync(
  join(outDir, 'claims.regtest.json'),
  JSON.stringify(
    {
      generatedAt: now,
      chain: 'regtest',
      messageFormat: 'govhub-claim|<net>|<govHash>|<identityId>',
      identities,
      addresses: { A: addrA, B: addrB, P2SH: p2sh },
      proposals,
      signatures,
      errors,
    },
    null,
    2,
  ) + '\n',
);
console.log('proposals', proposals.length, 'signatures', signatures.length, 'errors', errors.length);
