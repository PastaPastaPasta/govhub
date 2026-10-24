#!/usr/bin/env node
// Generates test/fixtures/*.regtest.json from a REAL Dash Core regtest node.
//
// This script talks only to dash-cli (never to @govhub/verify), so the fixtures contain what Core says,
// independent of our implementation. Usage:
//
//   DASH_CLI="/path/to/dash-cli -datadir=... -regtest -rpcport=... -rpcuser=.. -rpcpassword=.." \
//     node scripts/gen-regtest-vectors.mjs
//
// The node must already be running with -txindex=1 and have a funded wallet named "w" (>= 200 blocks mined).
// Everything produced is regtest data (worthless keys).
import { execFileSync } from 'node:child_process';
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

// gobject submit refuses to run until the (regtest, peerless) node believes it is synced.
cli(['mnsync', 'next'], { wallet: null, soft: true });
cli(['mnsync', 'next'], { wallet: null, soft: true });

const now = Math.floor(Date.now() / 1000);
const start = now;
const end = now + 3 * 365 * 86400;

// ---- addresses -------------------------------------------------------------------------------
const addrA = cli(['getnewaddress']);
const addrB = cli(['getnewaddress']);
const pubB = json(['getaddressinfo', addrB]).pubkey;
const pubC = json(['getaddressinfo', cli(['getnewaddress'])]).pubkey;
const p2sh = json(['createmultisig', 1, JSON.stringify([pubB, pubC])]).address;

// ---- proposals -------------------------------------------------------------------------------
const compact = (o) => JSON.stringify(o);
const prop = (over) => ({
  end_epoch: end,
  name: 'govhub-test',
  payment_address: addrA,
  payment_amount: 100.5,
  start_epoch: start,
  type: 1,
  url: 'https://gov.dashhq.org/p/abc/govhub-test',
  ...over,
});

const proposalSpecs = [
  { label: 'p2pkh-basic', parent: '0', revision: 1, time: now, data: compact(prop({})) },
  {
    label: 'p2sh-payout',
    parent: '0',
    revision: 1,
    time: now + 1,
    data: compact(prop({ name: 'p2sh_payout-01', payment_address: p2sh, payment_amount: 12.34567891 })),
  },
  {
    label: 'extra-fields-nonascii-url',
    parent: '0',
    revision: 3,
    time: now + 2,
    // unicode in url, extra unknown field, non-alphabetical key order
    data: '{"type":1,"name":"Mixed-CASE_ok","url":"https://example.org/éè?a=1&b=2","payment_amount":1,"payment_address":"' + addrB + '","start_epoch":' + start + ',"end_epoch":' + end + ',"description":"x"}',
  },
  {
    // non-zero parent hash (the hash preimage includes hashParent) and large revision
    label: 'nonzero-parent',
    parent: 'aa'.repeat(16) + '0102030405060708090a0b0c0d0e0f10',
    revision: 258,
    time: now + 3,
    data: compact(prop({ name: 'nonzero-parent', payment_amount: 0.00000001 })),
  },
];

const proposals = [];
for (const spec of proposalSpecs) {
  const dataHex = hex(spec.data);
  const txid = cli(['gobject', 'prepare', spec.parent, spec.revision, spec.time, dataHex]);
  proposals.push({ ...spec, dataHex, txid });
}
// confirm everything with 8 blocks
const mineAddr = cli(['getnewaddress']);
cli(['generatetoaddress', 8, mineAddr]);

const prepared = json(['gobject', 'list-prepared', 100]);

for (const p of proposals) {
  const match = prepared.find((o) => o.collateralHash === p.txid);
  if (!match) throw new Error('prepared object not found for ' + p.label);
  p.coreHash = match.objectHash;
  p.coreParentHash = match.parentHash;
  p.coreCreatedAt = match.createdAt;
  p.coreRevision = match.revision;
  p.coreDataHex = match.data.hex;
  p.rawTx = cli(['getrawtransaction', p.txid]);
  const dec = json(['getrawtransaction', p.txid, 'true']);
  p.blockhash = dec.blockhash;
  p.confirmations = dec.confirmations;
  p.decodedVout = dec.vout.map((v) => ({ n: v.n, valueSat: Math.round(v.value * 1e8), scriptHex: v.scriptPubKey.hex, type: v.scriptPubKey.type }));
  // Does Core itself accept the submission (collateral valid, 6 confs)?
  const submit = cli(['gobject', 'submit', p.parent, p.revision, p.time, p.dataHex, p.txid], { soft: true });
  p.coreSubmit = submit;
}

writeFileSync(
  join(outDir, 'proposals.regtest.json'),
  JSON.stringify({ generatedAt: now, chain: 'regtest', network: 'testnet-prefix', proposals }, null, 2) + '\n',
);

// ---- hand-built collateral scenarios, judged by Core's `gobject submit` -----------------------
// For each scenario: prepare an object (only to learn Core's hash), then build OUR OWN collateral tx
// (possibly malformed), mine 8 blocks and let Core's IsCollateralValid decide via `gobject submit`.
const le = (n, bytes) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b.subarray(0, bytes);
};
const rev = (h) => Buffer.from(h, 'hex').reverse();
const cs = (n) => (n < 253 ? Buffer.from([n]) : Buffer.concat([Buffer.from([253]), le(n, 2)]));
const out = (sat, script) => Buffer.concat([le(sat, 8), cs(script.length), script]);
const p2pkhScript = (addr) => {
  const spk = json(['getaddressinfo', addr]).scriptPubKey;
  return Buffer.from(spk, 'hex');
};
const opReturn = (data) => Buffer.concat([Buffer.from([0x6a, data.length]), data]);

function buildCollateral({ utxo, outputs }) {
  const parts = [
    Buffer.from('02000000', 'hex'),
    cs(1),
    rev(utxo.txid),
    le(utxo.vout, 4),
    cs(0),
    Buffer.from('ffffffff', 'hex'),
    cs(outputs.length),
    ...outputs,
    le(0, 4),
  ];
  return Buffer.concat(parts).toString('hex');
}

const scenarios = [];
const scenarioDefs = [
  { label: 'good-exact', build: (h, ctx) => [out(100000000, opReturn(h)), out(ctx.change, ctx.changeSpk)] },
  { label: 'good-more-than-1-dash', build: (h, ctx) => [out(150000000, opReturn(h)), out(ctx.change - 50000000, ctx.changeSpk)] },
  {
    label: 'good-extra-unspendable-output',
    build: (h, ctx) => [out(100000000, opReturn(h)), out(0, opReturn(Buffer.from('hello'))), out(ctx.change, ctx.changeSpk)],
  },
  {
    label: 'good-hash-output-not-first',
    build: (h, ctx) => [out(ctx.change, ctx.changeSpk), out(100000000, opReturn(h))],
  },
  { label: 'bad-value-below-1-dash', build: (h, ctx) => [out(99999999, opReturn(h)), out(ctx.change + 1, ctx.changeSpk)] },
  { label: 'bad-reversed-hash', build: (h, ctx) => [out(100000000, opReturn(Buffer.from(h).reverse())), out(ctx.change, ctx.changeSpk)] },
  {
    label: 'bad-extra-p2sh-output',
    build: (h, ctx) => [out(100000000, opReturn(h)), out(1000000, Buffer.from('a914' + '11'.repeat(20) + '87', 'hex')), out(ctx.change - 1000000, ctx.changeSpk)],
  },
  {
    label: 'bad-extra-p2pk-output',
    build: (h, ctx) => [out(100000000, opReturn(h)), out(1000000, Buffer.from('21' + '02' + '22'.repeat(32) + 'ac', 'hex')), out(ctx.change - 1000000, ctx.changeSpk)],
  },
  { label: 'bad-hash-plus-extra-byte', build: (h, ctx) => [out(100000000, Buffer.concat([Buffer.from([0x6a, 33]), h, Buffer.from([0])])), out(ctx.change, ctx.changeSpk)] },
  { label: 'bad-no-op-return', build: (h, ctx) => [out(ctx.change + 100000000, ctx.changeSpk)] },
];
for (let i = 0; i < scenarioDefs.length; i++) {
  const def = scenarioDefs[i];
  const time = now + 100 + i;
  const data = compact(prop({ name: 'scenario-' + i, payment_amount: 1 + i }));
  const dataHex = hex(data);
  cli(['gobject', 'prepare', '0', 1, time, dataHex]); // learn Core's hash (this prepare's own tx is ignored)
  cli(['generatetoaddress', 1, mineAddr]);
  const o = json(['gobject', 'list-prepared', 200]).find((x) => x.createdAt === time);
  const coreHash = o.objectHash;
  const rawHash = Buffer.from(coreHash, 'hex').reverse(); // internal (raw) byte order
  const utxo = json(['listunspent', 1, 9999999, '[]', true, JSON.stringify({ minimumAmount: 20 })])[0];
  const inSat = Math.round(utxo.amount * 1e8);
  const changeSpk = p2pkhScript(cli(['getnewaddress']));
  const ctx = { changeSpk, change: inSat - 100000000 - 20000 };
  const unsigned = buildCollateral({ utxo, outputs: def.build(rawHash, ctx) });
  const signed = json(['signrawtransactionwithwallet', unsigned]);
  if (!signed.complete) throw new Error('sign failed ' + def.label);
  const txid = cli(['sendrawtransaction', signed.hex]);
  cli(['generatetoaddress', 8, mineAddr]);
  const submit = cli(['gobject', 'submit', '0', 1, time, dataHex, txid], { soft: true });
  scenarios.push({
    label: def.label,
    parent: '0',
    revision: 1,
    time,
    dataHex,
    coreHash,
    txid,
    rawTx: signed.hex,
    coreAccepted: typeof submit === 'string',
    coreResult: typeof submit === 'string' ? submit : submit.error,
  });
}
writeFileSync(
  join(outDir, 'collateral.regtest.json'),
  JSON.stringify({ generatedAt: now, chain: 'regtest', scenarios }, null, 2) + '\n',
);

// A non-collateral plain wallet tx (for negative tests): sendtoaddress
const plainTxid = cli(['sendtoaddress', addrB, 2]);
const plainRaw = cli(['getrawtransaction', plainTxid]);

// ---- gobject check parity cases --------------------------------------------------------------
const longName = 'a'.repeat(40);
const checkSpecs = [];
const add = (label, data, extra = {}) => checkSpecs.push({ label, dataHex: typeof data === 'string' ? hex(data) : data.hex, ...extra });
const raw = (o) => compact(o);

add('valid-basic', raw(prop({})));
add('valid-p2sh', raw(prop({ payment_address: p2sh })));
add('valid-name-40', raw(prop({ name: longName })));
add('valid-name-mixed-case', raw(prop({ name: 'Foo-BAR_9' })));
add('valid-amount-exponent', '{"end_epoch":' + end + ',"name":"x","payment_address":"' + addrA + '","payment_amount":1e2,"start_epoch":' + start + ',"type":1,"url":"abcd"}');
add('valid-url-4-chars', raw(prop({ url: 'a:bc' })));
add('valid-url-nbsp-not-whitespace', raw(prop({ url: 'http://a.b/ x' })));
add('valid-url-brackets-ipv6', raw(prop({ url: 'http://[::1]:80/x' })));
add('valid-url-brackets-in-path', raw(prop({ url: 'http://a.b/x[' })));
add('valid-url-no-scheme-brackets', raw(prop({ url: 'a[b' })));
add('valid-extra-unknown-field', raw(prop({ zzz: [1, 2, { a: null }] })));
add('valid-start-negative', raw(prop({ start_epoch: -5, end_epoch: 10 + end })));
// the quirk cases: Core ignores the return value of UniValue::read()
add('quirk-trailing-garbage', raw(prop({})) + ' garbage');
add('quirk-truncated-json', raw(prop({})).slice(0, -1));
add('quirk-duplicate-key-first-wins-valid-then-bad', '{"type":1,"type":2,"name":"x","payment_address":"' + addrA + '","payment_amount":1,"start_epoch":1,"end_epoch":' + end + ',"url":"abcd"}');
add('quirk-duplicate-key-first-bad-then-valid', '{"type":2,"type":1,"name":"x","payment_address":"' + addrA + '","payment_amount":1,"start_epoch":1,"end_epoch":' + end + ',"url":"abcd"}');

add('invalid-name-41', raw(prop({ name: 'a'.repeat(41) })));
add('invalid-name-empty', raw(prop({ name: '' })));
add('invalid-name-space', raw(prop({ name: 'a b' })));
add('invalid-name-dot', raw(prop({ name: 'a.b' })));
add('invalid-name-unicode', raw(prop({ name: 'café' })));
add('invalid-name-number', raw(prop({ name: 5 })));
add('invalid-name-missing', raw((({ name, ...r }) => r)(prop({}))));
add('invalid-type-2', raw(prop({ type: 2 })));
add('invalid-type-string', raw(prop({ type: '1' })));
add('invalid-type-float', '{"end_epoch":' + end + ',"name":"x","payment_address":"' + addrA + '","payment_amount":1,"start_epoch":' + start + ',"type":1.0,"url":"abcd"}');
add('invalid-type-missing', raw((({ type, ...r }) => r)(prop({}))));
add('invalid-end-before-start', raw(prop({ end_epoch: start - 1 })));
add('invalid-end-equals-start', raw(prop({ end_epoch: start })));
add('invalid-start-float', '{"end_epoch":' + end + ',"name":"x","payment_address":"' + addrA + '","payment_amount":1,"start_epoch":1.5,"type":1,"url":"abcd"}');
add('invalid-start-string', raw(prop({ start_epoch: String(start) })));
add('invalid-expired', raw(prop({ start_epoch: 1000, end_epoch: 2000 })), { note: 'rejected only because gobject check passes fCheckExpiration=true' });
add('invalid-amount-zero', raw(prop({ payment_amount: 0 })));
add('invalid-amount-negative', raw(prop({ payment_amount: -1 })));
add('invalid-amount-string', raw(prop({ payment_amount: '5' })));
add('invalid-amount-missing', raw((({ payment_amount, ...r }) => r)(prop({}))));
add('invalid-address-mainnet-p2pkh', raw(prop({ payment_address: 'XcsN8bCiZpFSxVq3bXjH6sCGxrCtmZ4vnJ' })));
add('invalid-address-garbage', raw(prop({ payment_address: 'notanaddress' })));
add('invalid-address-whitespace', raw(prop({ payment_address: ' ' + addrA })));
add('invalid-address-empty', raw(prop({ payment_address: '' })));
add('invalid-url-3-chars', raw(prop({ url: 'abc' })));
add('invalid-url-space', raw(prop({ url: 'http://a b.c' })));
add('invalid-url-tab', raw(prop({ url: 'http://a\tb.c' })));
add('invalid-url-open-bracket-only', raw(prop({ url: 'http://[::1/x' })));
add('invalid-url-close-bracket-only', raw(prop({ url: 'http://::1]/x' })));
add('invalid-url-missing', raw((({ url, ...r }) => r)(prop({}))));
add('invalid-not-object-array', '[1,2,3]');
add('invalid-not-json', 'hello world');
add('invalid-empty-object', '{}');
{
  // 513 bytes of data (JSON valid, padded via unknown field)
  const base = raw(prop({ pad: '' }));
  const padLen = 513 - base.length;
  add('invalid-data-513-bytes', raw(prop({ pad: 'p'.repeat(padLen) })));
  const base2 = raw(prop({ pad: '' }));
  add('valid-data-512-bytes', raw(prop({ pad: 'p'.repeat(512 - base2.length) })));
}
add('invalid-empty-data', { hex: '' });

const checks = [];
for (const c of checkSpecs) {
  const res = cli(['gobject', 'check', c.dataHex], { soft: true });
  const ok = typeof res === 'string';
  checks.push({
    label: c.label,
    dataHex: c.dataHex,
    note: c.note,
    coreValid: ok,
    coreError: ok ? null : res.error.replace(/^error message:\n/, ''),
    dataLen: c.dataHex.length / 2,
  });
}
// extra: where to find the mainnet vs regtest prefix info
writeFileSync(
  join(outDir, 'check.regtest.json'),
  JSON.stringify({ generatedAt: now, chain: 'regtest', addrA, addrB, p2sh, now, start, end, checks }, null, 2) + '\n',
);

// ---- signmessage / verifymessage parity ------------------------------------------------------
const keys = [];
for (let i = 0; i < 4; i++) {
  // dumpprivkey needs a legacy (non-descriptor) wallet; create it with
  //   dash-cli createwallet leg false false "" false false false
  const a = cli(['getnewaddress'], { wallet: 'leg' });
  const wif = cli(['dumpprivkey', a], { wallet: 'leg' });
  const info = json(['getaddressinfo', a], { wallet: 'leg' });
  keys.push({ address: a, wif, pubkey: info.pubkey });
}
const fakeHash = (n) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + n * 13) & 0xff)).toString('hex');
const msgs = [
  `${'ab'.repeat(32)}-0|${fakeHash(1)}|1|1|${now}`,
  `${fakeHash(2)}-1|${fakeHash(3)}|1|2|${now + 5}`,
  `${fakeHash(4)}-17|${fakeHash(5)}|1|3|1700000000`,
  'hello',
  '',
  'x'.repeat(300), // multi-byte compactsize length (>252)
  'héllo wörld ✓',
];
const signatures = [];
for (const k of keys) {
  for (const m of msgs) {
    const sig = cli(['signmessagewithprivkey', k.wif, m || '']);
    const ver = cli(['verifymessage', k.address, sig, m]);
    const ver2 = cli(['verifymessage', keys[0].address === k.address ? keys[1].address : keys[0].address, sig, m]);
    signatures.push({ address: k.address, wif: k.wif, pubkey: k.pubkey, message: m, coreSigBase64: sig, coreVerifiesOwn: ver === 'true', coreVerifiesOther: ver2 === 'true' });
  }
}
writeFileSync(
  join(outDir, 'messages.regtest.json'),
  JSON.stringify({ generatedAt: now, chain: 'regtest', pubkeyAddressVersion: 140, signatures }, null, 2) + '\n',
);

writeFileSync(
  join(outDir, 'plaintx.regtest.json'),
  JSON.stringify({ txid: plainTxid, rawTx: plainRaw }, null, 2) + '\n',
);
console.log('proposals', proposals.length, 'checks', checks.length, 'signatures', signatures.length);
