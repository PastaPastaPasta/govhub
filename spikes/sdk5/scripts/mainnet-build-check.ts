// Offline: build the two chained asset-lock txs against a fake 0.3 DASH UTXO and print their shape (no keys, nothing broadcast).
import { FUNDING_ADDRESS, FUNDING_PATH, buildAssetLockTx, keyHexAt } from './mainnet-lib.ts';

const k = keyHexAt(FUNDING_PATH(0));
const spk = '76a914b15bf3ffb1ad831a856302e835418ed323c3bab288ac';
const A = buildAssetLockTx(k, { txid: '11'.repeat(32), vout: 0, satoshis: 30_000_000, scriptPubKey: spk }, k, 29_000_000, 1000, FUNDING_ADDRESS);
console.log('A', { txid: A.txid, burnIndex: A.burnIndex, change: A.change && { ...A.change, scriptPubKey: undefined }, size: A.sizeBytes });
const B = buildAssetLockTx(k, { txid: A.txid, vout: A.change!.index, satoshis: A.change!.duffs, scriptPubKey: A.change!.scriptPubKey }, keyHexAt(FUNDING_PATH(1)), A.change!.duffs - 1000, 1000);
console.log('B', { txid: B.txid, burnIndex: B.burnIndex, change: B.change, size: B.sizeBytes, lock: B.lockDuffs });
