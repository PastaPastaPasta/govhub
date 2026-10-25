// Generate (or check) the pinned block hashes below the quorum checkpoint in src/quorumpins.ts. Read-only, needs network:
//   node --experimental-strip-types scripts/quorum-pins.mjs mainnet            print the table
//   node --experimental-strip-types scripts/quorum-pins.mjs mainnet --write    rewrite the generated block in src/quorumpins.ts
//   node --experimental-strip-types scripts/quorum-pins.mjs mainnet --check    exit 1 unless the committed table is exactly what this derives
//
// Why a pin is no new trust: it is derived from the pinned quorum checkpoint (QUORUM_CHECKPOINTS, src/quorumproof.ts). Every header
// from the lowest pin up to the checkpoint is downloaded over DAPI and checked by X11 hash linkage (LinkedChain.fromTop) to end at the
// checkpoint's pinned hash; each pin is read from that verified run. X11 second-preimage resistance means no other header chain links
// to that hash, so the pins are a function of the checkpoint. On top of that, every pin is cross-checked against two independent
// sources (mainnet: insight.dash.org and chainz.cryptoid.info; testnet: insight.testnet.networks.dash.org and getBlock by height from
// two DAPI nodes), and the run must agree with the proof-of-work header checkpoint (src/headerchain.ts) where it covers it.
import { readFileSync, writeFileSync } from 'node:fs';
import { CHECKPOINTS, DapiCore, LinkedChain, QUORUM_CHECKPOINTS, createDapi, hashBytes, parseBlock } from '../src/index.ts';
import { fetchHeaders } from '../src/anchor.ts';
import { QUORUM_PINS } from '../src/quorumpins.ts';
import { blockHashHex, x11Many } from '../src/x11.ts';

const SPACING = 2_000;
const DEPTH = 400_000;
/** Mainnet superblocks (governance/superblock.cpp: nSuperblockStartBlock 614,820, nSuperblockCycle 16,616): a payment check reads them. */
const SUPERBLOCKS = { mainnet: { start: 614_820, cycle: 16_616 }, testnet: null };
const FILE = new URL('../src/quorumpins.ts', import.meta.url);

const network = process.argv[2];
if (network !== 'mainnet' && network !== 'testnet') {
  console.error('usage: quorum-pins.mjs <mainnet|testnet> [--write|--check]');
  process.exit(2);
}
const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
const cp = QUORUM_CHECKPOINTS[network];

// ---- which heights
const heights = new Set([cp.height]);
for (let h = cp.height - SPACING; h >= cp.height - DEPTH; h -= SPACING) heights.add(h);
const sb = SUPERBLOCKS[network];
if (sb) for (let h = Math.ceil((cp.height - DEPTH) / sb.cycle) * sb.cycle; h < cp.height; h += sb.cycle) if (h >= sb.start) heights.add(h);
const pins = [...heights].sort((a, b) => a - b);
const lowest = pins[0];

// ---- 1. derive: every header from the lowest pin up to the checkpoint, linked to the checkpoint's hash
const dapi = createDapi({ network });
await dapi.ready();
let t = Date.now();
console.error(`${network}: downloading ${(cp.height - lowest + 1).toLocaleString('en-US')} headers ${lowest}..${cp.height} over DAPI`);
const run = await fetchHeaders(dapi, lowest, cp.height, x11Many);
const chain = LinkedChain.fromTop(network, run, { height: cp.height, hash: hashBytes(cp.blockHash) });
console.error(`linked to the quorum checkpoint ${cp.height} ${cp.blockHash} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
const derived = pins.map((h) => [h, chain.hashHexAt(h)]);
const pow = CHECKPOINTS[network];
if (pow.height >= lowest && pow.height <= cp.height) {
  if (chain.hashHexAt(pow.height) !== pow.hash) throw new Error(`the run disagrees with the proof-of-work header checkpoint at ${pow.height}`);
  console.error(`agrees with the proof-of-work header checkpoint ${pow.height}`);
}

// ---- 2. cross-check every pin against two independent sources
async function getJson(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      // explorers behind Cloudflare challenge Node's default user agent
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'govhub-quorum-pins/1 (+https://github.com/PastaPastaPasta/govhub)' } });
      if (r.ok) return await r.json();
      if (i >= tries) throw new Error(`${url}: HTTP ${r.status}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** Math.min(i, 4)));
  }
}
const nodes = dapi.pool.pick(6);
/** Block h's hash as two DAPI nodes agree on it (any node naming another block is a mismatch, reported as such). */
async function dapiHash(h) {
  const seen = [];
  for (const n of nodes) {
    let hash;
    try { hash = blockHashHex(parseBlock(await new DapiCore(n, { timeoutMs: 15_000 }).getBlock({ height: h })).header.raw); } catch { continue; }
    if (seen.length && seen[0] !== hash) return `nodes disagree: ${seen[0]} / ${hash}`;
    seen.push(hash);
    if (seen.length === 2) return hash;
  }
  throw new Error(`fewer than two DAPI nodes returned block ${h}`);
}
const SOURCES = network === 'mainnet'
  ? [
    { name: 'insight.dash.org', parallel: 4, get: async (h) => (await getJson(`https://insight.dash.org/insight-api/block-index/${h}`)).blockHash },
    { name: 'chainz.cryptoid.info', parallel: 1, pause: 350, get: async (h) => getJson(`https://chainz.cryptoid.info/dash/api.dws?q=getblockhash&height=${h}`) },
  ]
  : [
    { name: 'insight.testnet.networks.dash.org', parallel: 4, get: async (h) => (await getJson(`https://insight.testnet.networks.dash.org/insight-api/block-index/${h}`)).blockHash },
    { name: 'DAPI getBlock by height (two nodes agreeing)', parallel: 4, get: dapiHash },
  ];
for (const s of SOURCES) {
  t = Date.now();
  const got = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: s.parallel }, async () => {
    while (next < pins.length) {
      const h = pins[next++];
      got.set(h, String(await s.get(h)).toLowerCase());
      if (s.pause) await new Promise((res) => setTimeout(res, s.pause));
    }
  }));
  const bad = derived.filter(([h, hash]) => got.get(h) !== hash);
  if (bad.length) {
    for (const [h, hash] of bad) console.error(`MISMATCH ${s.name} at ${h}: ${got.get(h)} (linked run: ${hash})`);
    process.exit(1);
  }
  console.error(`${s.name}: all ${pins.length} pins match (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}

// ---- 3. print, write or check
const lines = (pairs) => pairs.map(([h, hash]) => `      [${h}, '${hash}'],`).join('\n');
const block = lines(derived);
const committed = lines(QUORUM_PINS[network].pins);
const named = QUORUM_PINS[network].checkpoint;
if (named.height !== cp.height || named.blockHash !== cp.blockHash) {
  console.error(`src/quorumpins.ts ${network} names checkpoint ${named.height}; QUORUM_CHECKPOINTS has ${cp.height}: update its checkpoint field`);
  if (mode !== 'print') process.exit(1);
}
if (mode === 'check') {
  if (committed !== block) {
    console.error(`src/quorumpins.ts ${network} differs from what the chain derives (${QUORUM_PINS[network].pins.length} committed, ${derived.length} derived)`);
    process.exit(1);
  }
  console.error(`src/quorumpins.ts ${network}: all ${derived.length} committed pins are exactly what the chain derives`);
} else if (mode === 'write') {
  const src = readFileSync(FILE, 'utf8');
  const re = new RegExp(`(\\/\\/ BEGIN GENERATED ${network}\\n)[\\s\\S]*?(\\n\\s*\\/\\/ END GENERATED ${network})`);
  if (!re.test(src)) throw new Error(`no generated block for ${network} in src/quorumpins.ts`);
  writeFileSync(FILE, src.replace(re, (_, a, b) => `${a}${block}${b}`));
  console.error(`wrote ${derived.length} ${network} pins to src/quorumpins.ts`);
} else console.log(block);
process.exit(0);
