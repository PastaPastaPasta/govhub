// Test flows executed INSIDE the browser page (driven by test/run.mjs through window.spike).
// Every flow returns plain JSON and never throws; failures are recorded in the result.
import {
  DapiCore, fetchNodes, sample, race, mergeStreams, BloomFilter, matchAllFilter, parseMasternodeListDiff,
  hex, parseTx, parseBlock, parseHeader, parseMerkleBlock, parseChainLock, parseInstantLock, classifyScript,
} from '../src/index.js';
import { verifyChainLock } from '../src/chainlock.js';

const COLLATERAL_HEIGHT = 2559683, COLLATERAL_PREFIX = '3451d292';
const now = () => performance.now();
const ms = (t0) => Math.round(now() - t0);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const errInfo = (e) => ({ name: e?.name, code: e?.code, message: String(e?.message ?? e).slice(0, 200), network: !!e?.network });
const attempt = async (fn) => { const t0 = now(); try { const r = await fn(); return { ok: true, ms: ms(t0), ...r }; } catch (e) { return { ok: false, ms: ms(t0), error: errInfo(e) }; } };
const stash = {}; // cross-flow state (chainlock, sml)

async function waitFor(pred, timeoutMs, step = 100) {
  const t0 = now();
  while (now() - t0 < timeoutMs) { if (pred()) return true; await sleep(step); }
  return pred();
}

async function listNodes() {
  const t0 = now();
  const nodes = await fetchNodes();
  stash.nodes = nodes;
  return { ms: ms(t0), count: nodes.length, nodes };
}

/** One getBlockchainStatus per node (cold connection: TLS + CORS preflight + request), `concurrency` at a time. */
async function healthSweep(nodes, concurrency = 20) {
  const results = new Array(nodes.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < nodes.length) {
      const i = next++, node = nodes[i];
      const r = await attempt(async () => {
        const s = await new DapiCore(node, { timeoutMs: 12000 }).getBlockchainStatus();
        return { height: s.chain.blocksCount, synced: s.chain.isSynced, agent: s.version.agent };
      });
      results[i] = { node, ...r };
    }
  }));
  const okMs = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => okMs[Math.min(okMs.length - 1, Math.floor(okMs.length * p))];
  return { total: results.length, failed: results.filter((r) => !r.ok).length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: okMs[okMs.length - 1], results };
}

/** Sequential repeat calls to one node: cold (TLS + preflight) vs warm (reused h2 connection, cached preflight). */
async function latencyFlow(node) {
  const c = new DapiCore(node), runs = [];
  for (let i = 0; i < 5; i++) runs.push((await attempt(() => c.getBestBlockHeight())).ms);
  await sleep(8000);
  const afterIdle = (await attempt(() => c.getBestBlockHeight())).ms;
  return { node, sequentialMs: runs, afterIdle8sMs: afterIdle };
}

async function unaryFlow(node) {
  const c = new DapiCore(node), out = { node };
  out.status = await attempt(async () => { const s = await c.getBlockchainStatus(); return { agent: s.version.agent, status: s.status, blocks: s.chain.blocksCount, synced: s.chain.isSynced, best: s.chain.bestBlockHash }; });
  out.height = await attempt(async () => ({ height: await c.getBestBlockHeight() }));
  const H = out.height.height;
  out.blockRecent = await attempt(async () => {
    const raw = await c.getBlock({ height: H - 2 });
    const b = parseBlock(raw);
    stash.recentTxids = b.txs.filter((t) => t.type === 0 && t.inputs[0].prevTxid !== '0'.repeat(64)).map((t) => t.txid);
    return { bytes: raw.length, txs: b.txs.length, merkleOk: b.merkleOk, prev: b.header.prevHash };
  });
  out.blockCollateral = await attempt(async () => {
    const raw = await c.getBlock({ height: COLLATERAL_HEIGHT });
    const b = parseBlock(raw);
    const hit = b.txs.find((t) => t.txid.startsWith(COLLATERAL_PREFIX));
    stash.collateralTxid = hit?.txid;
    return { bytes: raw.length, txs: b.txs.length, merkleOk: b.merkleOk, collateralTxid: hit?.txid };
  });
  const describeTx = async (txid) => {
    const r = await c.getTransaction(txid);
    const tx = parseTx(r.raw);
    return {
      txid, rawBytes: r.raw.length, txidMatches: tx.txid === txid, height: r.height, confirmations: r.confirmations,
      isInstantLocked: r.isInstantLocked, isChainLocked: r.isChainLocked, blockHash: r.blockHash,
      outputs: tx.outputs.map((o) => { const k = classifyScript(o.script); return { value: o.value.toString(), type: k.type, opReturn: k.type === 'op_return' && k.data ? hex(k.data) : undefined }; }),
    };
  };
  out.txCollateral = await attempt(async () => describeTx(stash.collateralTxid || '3451d292d461d1255007392a43d0da7b47eed938ff9a1234fb06ae19157fa365'));
  out.txRecent = await attempt(async () => describeTx(stash.recentTxids[0]));
  out.txUnknown = await attempt(async () => describeTx('00'.repeat(31) + '01')); // expect NOT_FOUND (5)
  return out;
}

async function headersFlow(node, H, waitMs = 25000) {
  const c = new DapiCore(node), t0 = now(), ev = { headers: [], chainlocks: [] }, out = { node };
  const h = c.subscribeToBlockHeadersWithChainLocks({ fromHeight: H - 3 }, (e) => {
    const t = ms(t0);
    if (e.type === 'headers') { ev.headers.push({ t, n: e.headers.length }); stash.lastHeaders = e.headers.map(parseHeader); }
    else { const cl = parseChainLock(e.chainLock); ev.chainlocks.push({ t, height: cl.height, blockHash: cl.blockHash }); stash.chainLock = cl; stash.chainLockNode = node; }
  });
  await waitFor(() => ev.headers.length && ev.chainlocks.length, waitMs);
  await sleep(500);
  h.cancel();
  const closed = await Promise.race([h.closed, sleep(3000).then(() => ({ reason: 'cancel-timeout' }))]);
  Object.assign(out, { events: ev, headerCount: ev.headers.reduce((a, b) => a + b.n, 0), closed: closed.reason, totalMs: ms(t0) });
  out.ok = ev.headers.length > 0 && ev.chainlocks.length > 0 && closed.reason === 'cancelled';
  if (stash.lastHeaders) out.linked = stash.lastHeaders.map((x) => x.prevHash.slice(-8));
  return out;
}

async function txFlow(node, H, { bloomMs = 8000, matchAllMs = 90000 } = {}) {
  const c = new DapiCore(node), out = { node };
  // (i) >=200 byte bloom filter for a random "address" (hash160): expect ~0 matches
  {
    const f = new BloomFilter(1, 0.0001);
    f.insert(crypto.getRandomValues(new Uint8Array(20)));
    const t0 = now(), n = { rawtxs: 0, txs: 0, merkle: 0, islocks: 0, matchedInMerkle: 0 }, first = {};
    const h = c.subscribeToTransactionsWithProofs(f.toJSON(), { fromHeight: H - 3 }, (e) => {
      first[e.type] ??= ms(t0);
      if (e.type === 'rawtxs') { n.rawtxs++; n.txs += e.txs.length; } else if (e.type === 'islocks') n.islocks += e.messages.length;
      else { n.merkle++; n.matchedInMerkle += parseMerkleBlock(e.merkleBlock).matched.length; }
    });
    await sleep(bloomMs); h.cancel();
    const closed = await Promise.race([h.closed, sleep(3000).then(() => ({ reason: 'cancel-timeout' }))]);
    out.bloom = { vDataBytes: f.vData.length, nHashFuncs: f.nHashFuncs, ...n, firstMs: first, closed: closed.reason };
  }
  // (i-b) positive control: filter containing a real P2PKH hash160 must return the tx paying it (validates our murmur3/BIP37 impl vs the server)
  {
    const t0 = now();
    const r = await c.getTransaction(stash.collateralTxid || '3451d292d461d1255007392a43d0da7b47eed938ff9a1234fb06ae19157fa365');
    const tx = parseTx(r.raw), pay = classifyScript(tx.outputs[0].script);
    const f = new BloomFilter(1, 0.0001); f.insert(pay.hash);
    const got = [], mbs = [];
    const h = c.subscribeToTransactionsWithProofs(f.toJSON(), { fromHeight: r.height, count: 1 }, (e) => {
      if (e.type === 'rawtxs') for (const raw of e.txs) got.push(parseTx(raw).txid);
      else if (e.type === 'merkleblock') mbs.push(parseMerkleBlock(e.merkleBlock));
    });
    await waitFor(() => got.length && mbs.length, 10000);
    h.cancel(); // no-op if the count:1 stream already ended by itself
    const closed = await Promise.race([h.closed, sleep(3000).then(() => ({ reason: 'cancel-timeout' }))]);
    out.bloomControl = { ms: ms(t0), gotCollateral: got.includes(tx.txid), txs: got.length, merkleBlocks: mbs.length, merkleRootOk: mbs.every((m) => m.rootOk), merkleContainsTx: mbs.some((m) => m.matched.includes(tx.txid)), endedBy: closed.reason };
  }
  // (ii) match-all: raw txs, merkle blocks, IS locks; stop once we have seen >= 2 islocks (or time out)
  {
    const t0 = now(), seen = new Map(), lat = [], mb = [], mempool = [], first = {}, probed = new Map();
    const n = { rawtxs: 0, txs: 0, merkle: 0, islocks: 0, islocksForSeenTx: 0 };
    let pendingProbes = 0;
    const h = c.subscribeToTransactionsWithProofs(matchAllFilter(), { fromHeight: H - 3 }, (e) => {
      const t = now(); first[e.type] ??= ms(t0);
      if (e.type === 'rawtxs') {
        n.rawtxs++; n.txs += e.txs.length;
        for (const raw of e.txs) {
          const tx = parseTx(raw); seen.set(tx.txid, t);
          // once we are past the historical replay, probe getTransaction for txs that are still unconfirmed
          if (now() - t0 > 4000 && mempool.length + pendingProbes < 4 && tx.type === 0 && tx.inputs[0].prevTxid !== '0'.repeat(64)) {
            pendingProbes++;
            const delay = ms(t0);
            const entry = { txid: tx.txid.slice(0, 12), atMs: delay }; probed.set(tx.txid, entry);
            c.getTransaction(tx.txid).then((r) => Object.assign(entry, { height: r.height, confirmations: r.confirmations, isInstantLocked: r.isInstantLocked, isChainLocked: r.isChainLocked }),
              (er) => Object.assign(entry, { error: errInfo(er) })).finally(() => { mempool.push(entry); pendingProbes--; });
          }
        }
      } else if (e.type === 'islocks') {
        for (const m of e.messages) {
          n.islocks++;
          const il = parseInstantLock(m);
          if (seen.has(il.txid)) { n.islocksForSeenTx++; lat.push(Math.round(t - seen.get(il.txid))); }
          const pe = probed.get(il.txid);
          if (pe && !pe.afterIsLock) {
            pe.afterIsLock = 'pending';
            for (const wait of [0, 1500]) { // right at the islock event, then 1.5 s later
              setTimeout(() => c.getTransaction(il.txid).then((r) => { (pe['getTxAtIsLock+' + wait] = { isInstantLocked: r.isInstantLocked, confirmations: r.confirmations }); }, () => {}), wait);
            }
          }
          stash.lastIsLock = { txid: il.txid, inputs: il.inputs.length, version: il.version, sigBytes: il.signature.length };
        }
      } else {
        n.merkle++;
        const p = parseMerkleBlock(e.merkleBlock);
        mb.push({ total: p.total, matched: p.matched.length, rootOk: p.rootOk, allMatchedDelivered: p.matched.every((id) => seen.has(id)) });
      }
    });
    await waitFor(() => n.merkle >= 1 && [...probed.values()].some((p) => p['getTxAtIsLock+1500']), matchAllMs);
    h.cancel();
    const closed = await Promise.race([h.closed, sleep(3000).then(() => ({ reason: 'cancel-timeout' }))]);
    out.matchAll = { ...n, firstMs: first, totalMs: ms(t0), rawTxToIsLockMs: lat.slice(0, 10), merkleBlocks: mb, mempoolProbes: mempool, lastIsLock: stash.lastIsLock, closed: closed.reason };
  }
  return out;
}

async function smlFlow(node) {
  const c = new DapiCore(node, { timeoutMs: 120000 }), t0 = now();
  let bytes = null, tMsg = 0;
  const h = c.subscribeToMasternodeList((b) => { if (!bytes) { bytes = b; tMsg = ms(t0); } });
  const got = await waitFor(() => bytes, 90000);
  h.cancel();
  const closed = await Promise.race([h.closed, sleep(3000).then(() => ({ reason: 'cancel-timeout' }))]);
  if (!got) return { node, ok: false, closed: closed.reason };
  const p0 = now();
  const sml = parseMasternodeListDiff(bytes);
  const parseMs = ms(p0);
  stash.sml = sml; stash.smlNode = node;
  return {
    node, ok: true, bytes: bytes.length, firstMessageMs: tMsg, parseMs, mnCount: sml.mnCount, validMnCount: sml.validMnCount,
    evonodeCount: sml.evonodeCount, quorumCount: sml.quorumCount, platformEndpoints: sml.platformEndpoints().length,
    tipBlockHash: sml.blockHash, baseBlockHash: sml.baseBlockHash, closed: closed.reason,
  };
}

/** BLS-verify the ChainLock received by headersFlow against the quorums in the SML from smlFlow. */
async function blsFlow() {
  const { chainLock, sml } = stash;
  if (!chainLock || !sml) return { ok: false, error: 'need chainlock + sml first' };
  const run = () => { const t0 = now(); const r = verifyChainLock(chainLock, sml); return { ...r, ms: ms(t0) }; };
  const cold = run(), warm = run();
  const tampered = verifyChainLock({ ...chainLock, height: chainLock.height + 1 }, sml);
  return { height: chainLock.height, cold, warm, tamperedRejected: !tampered.ok };
}

async function raceFlow(nodes) {
  const bad = ['127.0.0.1:1', 'invalid.invalid:443'];
  const tryRace = (list, n) => race(list, (node, signal) => new DapiCore(node).getBlockchainStatus({ signal }), { n, accept: (s) => s.chain.isSynced });
  const clean = await tryRace(nodes, 3);
  const withBad = await tryRace([...bad, ...nodes], 2);
  return {
    clean: { winner: clean.node, ms: clean.ms, failures: clean.failures.length },
    withBadNodesFirst: { winner: withBad.node, ms: withBad.ms, failures: withBad.failures.map((f) => ({ node: f.node, error: errInfo(f.error).message })) },
  };
}

/** Merge match-all tx + IS-lock streams from 3 nodes (a dead node first, to exercise replacement). */
async function mergeFlow(nodes, H, { maxMs = 90000, wantLocks = 2 } = {}) {
  const arrivals = new Map(); // key -> {node: t}
  const delivered = [];
  const t0 = now();
  const seenAt = (key, node) => { const a = arrivals.get(key) ?? {}; a[node] = Math.round(now() - t0); arrivals.set(key, a); };
  const open = (node, emit) => new DapiCore(node).subscribeToTransactionsWithProofs(matchAllFilter(), { fromHeight: H - 1 }, (e) => {
    if (e.type === 'islocks') {
      for (const m of e.messages) { const il = parseInstantLock(m); seenAt('is:' + il.txid, node); emit('is:' + il.txid, { kind: 'islock', txid: il.txid, node }); }
    } else if (e.type === 'rawtxs') {
      for (const raw of e.txs) { const { txid } = parseTx(raw); seenAt('tx:' + txid, node); emit('tx:' + txid, { kind: 'tx', txid, node }); }
    }
  });
  const m = mergeStreams(['127.0.0.1:1', ...nodes], open, (item) => delivered.push({ ...item, t: ms(t0) }), { n: 3 });
  await waitFor(() => delivered.filter((d) => d.kind === 'islock').length >= wantLocks, maxMs);
  await sleep(1500); // let slower nodes' duplicates arrive so dupes/spread are measurable
  const stats = m.stats();
  m.cancel();
  const closed = await Promise.race([m.closed.then(() => 'closed'), sleep(3000).then(() => 'timeout')]);
  const spread = (prefix) => [...arrivals].filter(([k, a]) => k.startsWith(prefix) && Object.keys(a).length > 1).map(([, a]) => { const v = Object.values(a); return Math.max(...v) - Math.min(...v); });
  const keys = delivered.map((d) => d.kind + d.txid);
  return {
    deliveredTxs: delivered.filter((d) => d.kind === 'tx').length,
    deliveredIsLocks: delivered.filter((d) => d.kind === 'islock').map((d) => ({ txid: d.txid.slice(0, 12), firstNode: d.node, t: d.t })),
    deliveredExactlyOnce: new Set(keys).size === keys.length,
    stats: { ...stats, firstBy: stats.firstBy }, isLockInterNodeSpreadMs: spread('is:'), txInterNodeSpreadMs: spread('tx:').slice(0, 20), closed,
  };
}

window.spike = { listNodes, healthSweep, latencyFlow, unaryFlow, headersFlow, txFlow, smlFlow, blsFlow, raceFlow, mergeFlow, sample, stash };
