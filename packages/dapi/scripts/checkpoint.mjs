// Check (or move) the pinned checkpoint in src/headerchain.ts. Read-only, needs network:
//   node --experimental-strip-types scripts/checkpoint.mjs mainnet            verify the current pin
//   node --experimental-strip-types scripts/checkpoint.mjs mainnet 2600000    verify, then print a pin for height 2600000
// Starting from Dash Core's newest hard-coded checkpoint (chainparams.cpp), it downloads every header up to the pin (and the new
// height) and runs the same rules the client does (link, proof of work, Dark Gravity Wave, median time, future time) through
// HeaderChain, so a pin is only ever as trustworthy as Core's own checkpoint plus the work on top of it. It also asks 8 random
// nodes for the hash at the pinned height.
//
// Pin-age policy: a new pin must be at least 30 days old. The anchor's cost to forge grows with the pin's age (two real blocks of work
// per hour since the pin, headerchain.ts), so a fresh pin would be cheap to forge against: 30 days is ~1,440 real blocks, ~2.5 days of
// the whole network's hash rate.
import { createDapi, CHECKPOINTS, DGW_WINDOW, HeaderChain, POW_PARAMS, DapiCore, parseBlock, parseHeader } from '../src/index.ts';
import { fetchHeaders } from '../src/anchor.ts';
import { blockHashHex, x11Many } from '../src/x11.ts';

/** Dash Core's newest checkpoints (/Users/pasta/workspace/dash f35a24cfca12, src/chainparams.cpp:345 and :528). */
const CORE = {
  mainnet: { height: 2_487_500, hash: '00000000000000119fe42827219e0686d3f7b494ae65f823194c740c5dbab492' },
  testnet: { height: 1_380_000, hash: '000000a98084beaf77ed26a905a7d59979009e23367a55b5d634962d7d65a1f9' },
};

const network = process.argv[2] ?? 'mainnet';
const next = process.argv[3] ? Number(process.argv[3]) : null;
const pin = CHECKPOINTS[network];
const top = Math.max(pin.height, next ?? 0);
const dapi = createDapi({ network });
await dapi.ready();
const t0 = Date.now();
const run = await fetchHeaders(dapi, CORE[network].height - DGW_WINDOW, top, x11Many);
// Core pins only the hash; its header (which must hash to it: fromCheckpoint checks) supplies bits and time for the work floor
const coreHeader = parseHeader(run.headers.subarray(DGW_WINDOW * 80, DGW_WINDOW * 80 + 80));
const core = { ...CORE[network], bits: coreHeader.bits, time: coreHeader.time };
const chain = HeaderChain.fromCheckpoint(network, core, run, { pow: POW_PARAMS[network], now: Math.floor(Date.now() / 1000) });
console.log(`${network}: ${(top - CORE[network].height).toLocaleString('en-US')} headers from Core's checkpoint ${CORE[network].height} pass every header rule (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const ok = chain.hashHexAt(pin.height) === pin.hash;
console.log(`pin ${pin.height} ${pin.hash}: ${ok ? 'descends from Core\'s checkpoint' : `MISMATCH (chain has ${chain.hashHexAt(pin.height)})`}`);
const nodes = dapi.pool.pick(8);
const answers = await Promise.all(nodes.map(async (n) => {
  try { return blockHashHex(parseBlock(await new DapiCore(n, { timeoutMs: 10_000 }).getBlock({ height: pin.height })).header.raw); } catch { return null; }
}));
console.log(`nodes agreeing on the pin: ${answers.filter((a) => a === pin.hash).length} of ${answers.filter(Boolean).length} that answered`);
if (next) {
  const h = parseHeader(chain.rawAt(next));
  const ageDays = (Date.now() / 1000 - h.time) / 86400;
  if (ageDays < 30) { console.log(`refused: block ${next} is ${ageDays.toFixed(1)} days old; pins must be at least 30 days old`); process.exit(1); }
  console.log(`new pin (${ageDays.toFixed(1)} days old): { height: ${next}, hash: '${chain.hashHexAt(next)}', bits: 0x${h.bits.toString(16)}, time: ${h.time} }`);
}
process.exit(ok ? 0 : 1);
