// Live TESTNET check of the Recover tool's scan from Node (no browser, no localStorage): what a phrase's one-time keys hold on chain.
//
//   GOVHUB_PHRASE_FILE=<json file with a "phrase" field> npx vite-node scripts/live-recovery.ts [fromHeight]
//
// The phrase is read from the file and never printed; the output is public chain data only (addresses, txids, amounts, Platform's
// proved asset-lock state).
import { readFileSync } from 'node:fs';
import { createDapi } from '@govhub/dapi';
import { itemOptions, scanForFunds, SeedWallet } from '../src/index.ts';
import { createEvoPlatform } from '../src/evo.ts';

const file = process.env.GOVHUB_PHRASE_FILE;
if (!file) throw new Error('set GOVHUB_PHRASE_FILE');
const wallet = SeedWallet.fromPhrase((JSON.parse(readFileSync(file, 'utf8')) as { phrase: string }).phrase, 'testnet');
const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
await sdk.connect();
const platform = createEvoPlatform(evo, sdk, 'testnet');
const dapi = createDapi({ network: 'testnet' });
const t0 = Date.now();
let last = 0;
const scan = await scanForFunds({
  secret: { wallet },
  dapi,
  platform,
  fromHeight: process.argv[2] ? Number(process.argv[2]) : undefined,
  onProgress: (p) => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${p.phase} ${p.done}/${p.total} blocks, ${p.keys} keys ${p.note ?? ''}`);
  },
  log: (m) => console.log(`  log: ${m}`),
});
wallet.wipe();
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
console.log(
  JSON.stringify(
    {
      ms: Date.now() - t0,
      fromHeight: scan.fromHeight,
      toHeight: scan.toHeight,
      keysScanned: scan.keysScanned,
      identities: scan.identities,
      usedLocks: scan.usedLocks,
      provenDuffs: scan.provenDuffs,
      dropped: scan.dropped,
      items: scan.items.map((i) => ({ ...i, lock: i.lock && { ...i.lock, raw: `${i.lock.raw.length / 2} bytes` }, options: itemOptions(i, scan) })),
    },
    replacer,
    2,
  ),
);
process.exit(0);
