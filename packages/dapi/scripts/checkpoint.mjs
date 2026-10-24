// Check (or move) the pinned checkpoint in src/headerchain.ts. Read-only, needs network:
//   node --experimental-strip-types scripts/checkpoint.mjs mainnet            verify the current pin
//   node --experimental-strip-types scripts/checkpoint.mjs mainnet 2600000    verify, then print a pin for height 2600000
// Starting from Dash Core's newest hard-coded checkpoint (chainparams.cpp), it downloads every header up to the pin (and the new
// height) and runs the same rules the client does (link, proof of work, Dark Gravity Wave, median time, future time) through
// HeaderChain, so a pin is only ever as trustworthy as Core's own checkpoint plus the work on top of it. It also asks 8 random
// nodes for the hash at the pinned height.
import { createDapi, CHECKPOINTS, DGW_WINDOW, HeaderChain, POW_PARAMS, DapiCore, parseBlock } from '../src/index.ts';
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
const chain = HeaderChain.fromCheckpoint(network, CORE[network], run, { pow: POW_PARAMS[network], now: Math.floor(Date.now() / 1000) });
console.log(`${network}: ${(top - CORE[network].height).toLocaleString('en-US')} headers from Core's checkpoint ${CORE[network].height} pass every header rule (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const ok = chain.hashHexAt(pin.height) === pin.hash;
console.log(`pin ${pin.height} ${pin.hash}: ${ok ? 'descends from Core\'s checkpoint' : `MISMATCH (chain has ${chain.hashHexAt(pin.height)})`}`);
const nodes = dapi.pool.pick(8);
const answers = await Promise.all(nodes.map(async (n) => {
  try { return blockHashHex(parseBlock(await new DapiCore(n, { timeoutMs: 10_000 }).getBlock({ height: pin.height })).header.raw); } catch { return null; }
}));
console.log(`nodes agreeing on the pin: ${answers.filter((a) => a === pin.hash).length} of ${answers.filter(Boolean).length} that answered`);
if (next) console.log(`new pin: { height: ${next}, hash: '${chain.hashHexAt(next)}' }`);
process.exit(ok ? 0 : 1);
