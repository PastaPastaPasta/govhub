// Records offline test fixtures from live MAINNET nodes (read-only: no transaction is ever sent). No secrets involved.
//   node scripts/record-fixtures.mjs        needs network; writes test/fixtures/recorded.json
// The unit tests then replay this data through a fake DAPI node (test/fake-dapi.ts).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DapiCore, createDapi, decodeCbor, hex, matchAllFilter, parseBlock, parseChainLock, parseHeader, parseInstantLock, parseTx, sample, fetchNodes, unhex, BloomFilter, classifyScript,
} from '../src/index.ts';
import { x11, blockHashHex } from '../src/x11.ts';
import { verifyChainLock } from '../src/bls.ts';
import { encodeCbor } from '../test/helpers/cbor-encode.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dapi = createDapi({ verifiers: { hashHeader: x11, verifyChainLock } });
const nodes = await dapi.ready();
const log = (...a) => console.log(...a);
const out = { recordedAt: new Date().toISOString(), network: 'mainnet' };

// healthy node for the raw recordings
const best = await dapi.getBestBlockHeight();
const core = new DapiCore(best.node);
log('node', best.node, 'tip', best.height);

// 1. a confirmed non-coinbase tx ~40 blocks below the tip, its block, the header chain to the newest ChainLock, and that CLSIG
const txHeight = best.height - 40;
const blockRaw = await core.getBlock({ height: txHeight });
const block = parseBlock(blockRaw);
const hasP2pkh = (t) => t.outputs.some((o) => classifyScript(o.script).type === 'p2pkh');
const tx = block.txs.find((t, i) => i > 0 && t.type === 0 && hasP2pkh(t) && t.inputs.length <= 3) ?? block.txs.find((t, i) => i > 0 && hasP2pkh(t));
const claims = await core.getTransaction(tx.txid);
log('tx', tx.txid, 'in block', claims.blockHash, 'height', claims.height);
const headers = [];
let cl = null;
await new Promise((resolve, reject) => {
  const h = core.subscribeToBlockHeadersWithChainLocks({ fromHeight: txHeight }, (ev) => {
    if (ev.type === 'headers') headers.push(...ev.headers); else cl = ev.chainLock;
    if (cl && headers.length > parseChainLock(cl).height - txHeight) { h.cancel(); resolve(); }
  });
  h.closed.then((r) => r.reason === 'error' && reject(r.error));
  setTimeout(() => reject(new Error('timeout')), 30000);
});
const lock = parseChainLock(cl);
log('chainlock', lock.height, lock.blockHash, 'headers', headers.length);
out.tx = {
  txid: tx.txid, height: claims.height, blockHash: claims.blockHash,
  claims: { rawHex: hex(claims.raw), confirmations: claims.confirmations, isInstantLocked: claims.isInstantLocked, isChainLocked: claims.isChainLocked },
  blockHex: hex(blockRaw),
  headersHex: headers.slice(0, lock.height - txHeight + 1).map(hex),
  chainLockHex: hex(cl),
};

// 2. the SML at (or after) that ChainLock, trimmed, plus the base blocks of the signing-type quorums
let smlRaw = null;
{
  const c = new DapiCore(best.node);
  smlRaw = await new Promise((resolve, reject) => {
    const h = c.subscribeToMasternodeList((b) => { h.cancel(); resolve(b); });
    h.closed.then((r) => r.reason === 'error' && reject(r.error));
  });
}
const d = decodeCbor(smlRaw);
const evo = d.mnList.filter((m) => m.nType === 1 && m.isValid && m.addresses?.platform_https);
const trimmed = {
  ...d,
  mnList: [...d.mnList.filter((m) => m.nType !== 1).slice(0, 3), ...evo.slice(0, 4), d.mnList.find((m) => !m.isValid)].filter(Boolean),
  newQuorums: d.newQuorums.filter((q) => q.llmqType === 2 || q.llmqType === 5 && q.quorumIndex === 0),
  quorumsCLSigs: [],
};
out.smlTrimmedCborHex = hex(encodeCbor(trimmed));
out.smlFullDigestInfo = { blockHash: d.blockHash, mnCount: d.mnList.length, merkleRootMNList: d.merkleRootMNList };
log('sml tip', d.blockHash, 'quorums type2', trimmed.newQuorums.filter((q) => q.llmqType === 2).length);
out.quorumBlocks = {};
for (const q of trimmed.newQuorums.filter((q) => q.llmqType === 2)) {
  const raw = await core.getBlock({ hash: q.quorumHash });
  out.quorumBlocks[q.quorumHash] = hex(raw);
  log('quorum block', q.quorumHash.slice(0, 16), raw.length, 'bytes', 'hash ok', blockHashHex(parseBlock(raw).header.raw) === q.quorumHash);
}

// 3. real historical header pairs for the X11 chain-link test (header n+1 commits to X11(header n) in prevHash)
out.headerPairs = [];
for (const h of [1, 100000, 500000, 1000000, 1500000, 2000000]) {
  const a = parseBlock(await core.getBlock({ height: h })).header, b = parseBlock(await core.getBlock({ height: h + 1 })).header;
  out.headerPairs.push({ height: h, headerHex: hex(a.raw), nextHeaderHex: hex(b.raw), hash: blockHashHex(a.raw) });
  log('pair', h, blockHashHex(a.raw), b.prevHash === blockHashHex(a.raw));
}

// 4. live firehose: raw txs + ISDLOCK messages (match-all), and a real merkleblock from a P2PKH bloom filter
out.firehose = { txs: [], islocks: [] };
{
  const rawById = new Map();
  await new Promise((resolve) => {
    const h = core.subscribeToTransactionsWithProofs(matchAllFilter(), { fromHeight: best.height }, (ev) => {
      if (ev.type === 'rawtxs') for (const r of ev.txs) { const t = parseTx(r); if (!rawById.has(t.txid)) { rawById.set(t.txid, r); if (out.firehose.txs.length < 12) out.firehose.txs.push(hex(r)); } }
      else if (ev.type === 'islocks') for (const m of ev.messages) {
        const l = parseInstantLock(m), r = rawById.get(l.txid);
        // keep the lock together with the raw tx it locks, so tests can pair them
        if (out.firehose.islocks.length < 3 && r && !out.firehose.islocks.some((x) => x.txid === l.txid)) out.firehose.islocks.push({ hex: hex(m), txid: l.txid, rawTxHex: hex(r) });
      }
      if (out.firehose.islocks.length >= 3) { h.cancel(); resolve(); }
    });
    setTimeout(() => { h.cancel(); resolve(); }, 120000);
  });
  log('firehose txs', out.firehose.txs.length, 'islocks', out.firehose.islocks.length);
}
{
  const p2pkh = tx.outputs.map((o) => classifyScript(o.script)).find((c) => c.type === 'p2pkh');
  const f = new BloomFilter(1, 0.0001, 12345).insert(p2pkh.hash).toJSON();
  const mb = await new Promise((resolve, reject) => {
    const h = core.subscribeToTransactionsWithProofs(f, { fromHeight: txHeight, count: 1 }, (ev) => { if (ev.type === 'merkleblock') { h.cancel(); resolve(ev.merkleBlock); } });
    setTimeout(() => reject(new Error('merkleblock timeout')), 20000);
  });
  out.merkleblock = { hex: hex(mb), hash160: hex(p2pkh.hash), tweak: 12345, txid: tx.txid, height: txHeight };
}

writeFileSync(join(here, '../test/fixtures/recorded.json'), JSON.stringify(out));
log('wrote test/fixtures/recorded.json');
process.exit(0);
