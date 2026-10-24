// Offline: derive the mainnet funding key and confirm its address matches the deposit address. Prints addresses only.
import { FUNDING_ADDRESS, FUNDING_PATH, IDENTITY_KEY_PATH, addressOf, keyHexAt, pubKeyOf } from './mainnet-lib.ts';

const a0 = addressOf(keyHexAt(FUNDING_PATH(0)));
console.log(`funding key 0 address ${a0} ${a0 === FUNDING_ADDRESS ? 'MATCHES deposit address' : 'DOES NOT MATCH'}`);
console.log(`funding key 1 address ${addressOf(keyHexAt(FUNDING_PATH(1)))}`);
for (const idx of [0, 1]) for (const k of [0, 1, 2]) console.log(`identity ${idx} key ${k} pubkey bytes ${pubKeyOf(keyHexAt(IDENTITY_KEY_PATH(idx, k))).length}`);
process.exit(a0 === FUNDING_ADDRESS ? 0 : 1);
