// Moves tDASH from the EvoVote QA wallet (~/.local/share/evovote-v2-qa-20261018/wallet.key) to the spike wallet, so
// testnet-topup.ts can top up a spike identity. Spends only as many QA UTXOs as the amount needs. Nothing secret is printed.
//
//   npx vite-node scripts/testnet-fund-from-qa.ts <duffs>
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveResult, sleep } from './lib.ts';
import { addressOf, broadcastTx, buildSplitTx, fetchUtxos, readState } from './chain.ts';

const duffs = Number(process.argv[2]);
if (!Number.isInteger(duffs) || duffs < 100_000 || duffs > 200_000_000) throw new Error('usage: testnet-fund-from-qa.ts <duffs> (0.001 .. 2 tDASH)');
const st: any = readState(null);
const to: string = st.wallet.address;
const qaHex = readFileSync(join(homedir(), '.local/share/evovote-v2-qa-20261018/wallet.key'), 'utf8').trim();
const from = addressOf(qaHex);
const utxos = (await fetchUtxos(from)).filter((u: any) => u.confirmations > 0).sort((a: any, b: any) => b.satoshis - a.satoshis);
const picked: any[] = [];
let sum = 0;
for (const u of utxos) {
  if (sum >= duffs + 20_000) break;
  picked.push(u);
  sum += u.satoshis;
}
if (sum < duffs + 20_000) throw new Error(`QA wallet ${from} has only ${sum / 1e8} tDASH confirmed`);
const tx = buildSplitTx(qaHex, picked, [{ address: to, duffs }]);
await broadcastTx(tx.rawtx);
console.log(`sent ${duffs / 1e8} tDASH ${from} -> ${to} in ${tx.txid} (${picked.length} inputs)`);
for (let i = 0; i < 60; i++) {
  if ((await fetchUtxos(to)).some((u: any) => u.txid === tx.txid && u.confirmations > 0)) break;
  await sleep(10_000);
}
saveResult('testnet-fund-from-qa.json', { at: new Date().toISOString(), from, to, duffs, txid: tx.txid });
process.exit(0);
