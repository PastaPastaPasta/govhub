// Moves tDASH from the EvoVote QA wallet (~/.local/share/evovote-v2-qa-20261018/wallet.key) to the spike wallet, so
// testnet-topup.ts can top up a spike identity. Spends only as many QA UTXOs as the amount needs. Nothing secret is printed.
//
//   npx vite-node scripts/testnet-fund-from-qa.ts <duffs> [--again]
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveResult, sleep } from './lib.ts';
import { addressOf, broadcastTx, buildSplitTx, fetchUtxos, readState } from './chain.ts';

const duffs = Number(process.argv[2]);
if (!Number.isInteger(duffs) || duffs < 100_000 || duffs > 200_000_000) throw new Error('usage: testnet-fund-from-qa.ts <duffs> (0.001 .. 2 tDASH)');
const resultFile = join(dirname(fileURLToPath(import.meta.url)), '../results/testnet-fund-from-qa.json');
if (existsSync(resultFile) && !process.argv.includes('--again')) {
  const last = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (last.status !== 'confirmed') throw new Error(`a transfer (${last.txid}) is recorded as ${last.status ?? 'unknown'}: check it, then rerun with --again`);
}
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
// recorded before broadcasting: a rerun after a crash finds it here instead of sending the funds again
saveResult('testnet-fund-from-qa.json', { at: new Date().toISOString(), from, to, duffs, txid: tx.txid, status: 'broadcasting' });
await broadcastTx(tx.rawtx);
console.log(`sent ${duffs / 1e8} tDASH ${from} -> ${to} in ${tx.txid} (${picked.length} inputs)`);
let confirmed = false;
for (let i = 0; i < 60 && !confirmed; i++) {
  confirmed = (await fetchUtxos(to).catch(() => [])).some((u: any) => u.txid === tx.txid && u.confirmations > 0);
  if (!confirmed) await sleep(10_000);
}
saveResult('testnet-fund-from-qa.json', { at: new Date().toISOString(), from, to, duffs, txid: tx.txid, status: confirmed ? 'confirmed' : 'pending' });
if (!confirmed) console.log(`not confirmed after 10 minutes: ${tx.txid} is pending; check it before sending again`);
process.exit(confirmed ? 0 : 1);
