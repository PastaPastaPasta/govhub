// Build step: the registration facts (type, collateral) of every masternode, proven the way the browser proves them, shipped as
// dist/verify/registrations-mainnet.bin (format and use: src/verify/registrations.ts).
//
// Each fact is read from the masternode's ProRegTx, fetched from DAPI by proTxHash and accepted only when the transaction hashes to
// that proTxHash (@govhub/dapi getProRegInfo): a node can withhold a transaction, not make one up. Which masternodes to cover comes
// from the governance bridge's list; that list is untrusted and only picks what to prove (the browser uses an entry only for a
// masternode in the masternode list it proved itself). Whatever could not be proven in time is left out; the browser proves those.
//
// Usage: node scripts/registrations.mjs [distDir]. Env: GOVHUB_PRERENDER_BRIDGE (as prerender.mjs), GOVHUB_PRERENDER_OFFLINE=1 (skip).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDapi } from '@govhub/dapi';
import { encodeRegistrations } from '../src/verify/registrations.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '../dist'));
const bridge = (process.env.GOVHUB_PRERENDER_BRIDGE ?? 'https://gov-bridge-mainnet.dashhq.org').replace(/\/+$/, '');
/** The whole step, list and proofs: a slow network leaves a partial table rather than a stuck build. */
const BUDGET_MS = 240_000;
const HASH = /^[0-9a-f]{64}$/;

if (process.env.GOVHUB_PRERENDER_OFFLINE === '1') {
  console.log('registrations: offline build, no table (the browser proves every registration itself)');
  process.exit(0);
}

const t0 = Date.now();
const proven = new Map();
let height = 0;
try {
  const res = await fetch(`${bridge}/v1/mnlist`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${bridge}/v1/mnlist: HTTP ${res.status}`);
  const list = await res.json();
  height = Number.isSafeInteger(list?.height) ? list.height : 0;
  const hashes = [...new Set((Array.isArray(list?.masternodes) ? list.masternodes : []).map((m) => String(m?.proTxHash ?? '').toLowerCase()).filter((h) => HASH.test(h)))];
  const dapi = createDapi({ network: 'mainnet' });
  await dapi.ready();
  // in chunks, so that a slow network still ships what was proven (each chunk's cache.save receives its proofs, even when it throws)
  const cache = { load: async () => new Map(), save: async (m) => { for (const [k, v] of m) proven.set(k, v); } };
  for (let i = 0; i < hashes.length && Date.now() - t0 < BUDGET_MS; i += 250) {
    await dapi.getProRegInfo(hashes.slice(i, i + 250), { cache, parallel: 16 }).catch((e) => console.warn(`registrations: ${e.message}`));
  }
  console.log(`registrations: ${proven.size} of ${hashes.length} masternode registrations proven (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} catch (e) {
  console.warn(`registrations: no table (${e.message}); the browser proves every registration itself`);
}
if (proven.size) {
  await fs.mkdir(path.join(dist, 'verify'), { recursive: true });
  await fs.writeFile(path.join(dist, 'verify', 'registrations-mainnet.bin'), encodeRegistrations('mainnet', height, proven));
}
// DAPI keeps connections open
process.exit(0);
