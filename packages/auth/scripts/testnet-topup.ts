// TESTNET tooling: tops up a phase-0 identity (state.json name, default `owner`) from the EvoVote QA wallet with a chain-lock
// asset-lock proof. Used before the forum contract update (a DataContractUpdate adding a type costs ~0.46 DASH on testnet).
//
//   npx vite-node scripts/testnet-topup.ts [owner|u3|u6] [duffs]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDapi, parseTx } from '@govhub/dapi';
import { createEvoPlatform } from '../src/evo.ts';
import { hash160, publicKeyOf } from '../src/index.ts';
import { minedHeight, waitForChainLockedHeight } from '../src/funding.ts';
import { parseVoucher } from '../src/voucher.ts';
import { qaFunder } from './qa-funder.ts';

process.on('unhandledRejection', (e: any) => {
  console.error('unhandled:', e?.name, e?.code, e?.message ?? String(e));
  process.exit(1);
});
const who = process.argv[2] ?? 'owner';
const duffs = BigInt(process.argv[3] ?? '60000000');
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const state = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8')) as { items: Array<{ name: string; identityId: string }> };
const identityId = state.items.find((i) => i.name === who)!.identityId;

const evo = await import('@dashevo/evo-sdk');
await evo.ensureInitialized?.();
const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const platform = createEvoPlatform(evo, sdk, 'testnet');
const dapi = createDapi({ network: 'testnet' });
const before = (await platform.balance(identityId)) ?? 0n;
log(`${who} ${identityId}: ${Number(before) / 1e11} DASH`);
const v = await qaFunder(dapi).mintVoucher(duffs);
log(`asset lock ${v.txid} (${Number(duffs) / 1e8} tDASH)`);
const voucher = parseVoucher(v.link, 'testnet');
const { value: claim } = await dapi.call((core, s) => core.getTransaction(voucher.txid, { signal: s }));
const tx = parseTx(claim.raw);
const creditIndex = 0;
if (!tx.outputs.length || !hash160(publicKeyOf(voucher.privateKey))) throw new Error('bad voucher');
while (!(await minedHeight(dapi, tx.txid))) await new Promise((r) => setTimeout(r, 10_000));
const cl = await waitForChainLockedHeight(dapi, platform, tx.txid, { onWait: (m, p) => log(`mined ${m}, Platform chain lock ${p}`) });
await platform.topUpIdentity({ identityId, proof: { kind: 'chain', txid: tx.txid, creditIndex, coreChainLockedHeight: cl }, assetLockKey: voucher.privateKey });
voucher.privateKey.fill(0);
for (let i = 0; i < 20; i++) {
  const b = (await platform.balance(identityId)) ?? 0n;
  if (b > before) {
    log(`balance ${Number(b) / 1e11} DASH`);
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
process.exit(0);
