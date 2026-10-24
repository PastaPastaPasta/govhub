// Measures adding the DashPay-layout keys (3 transfer, 4 ENC, 5 DEC, the last two bound to
// contactRequest) to the 3-key identity u3 with ONE identity update, i.e. "add them later to keep
// identity creation cheap" (PLAN 4.1). Compare with u6, which had all six keys at creation.
//
//   npx vite-node scripts/testnet-keys-add.ts
import { dash, errText, saveResult, sleep } from './lib.ts';
import { freshKeyHex, pubKeyOf, readState, wifOf, writeState } from './chain.ts';

process.on('unhandledRejection', (e) => { console.error('unhandled:', errText(e)); process.exit(1); });
const DASHPAY_CONTRACT = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7';
const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.testnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const st: any = readState(null);
const u3 = st.items.find((i: any) => i.name === 'u3');
if (u3.keys.length !== 3) { console.log('u3 already has more than 3 keys; nothing to do'); process.exit(0); }

const readBal = async () => BigInt(await sdk.identities.balance(u3.identityId));
const stable = async () => { let p: bigint | undefined; for (let i = 0; i < 20; i++) { const b = await readBal(); if (b === p) return b; p = b; await sleep(2000); } return p!; };
const before = await stable();

const add = [
  { keyId: 3, purpose: 'transfer', securityLevel: 'critical', bound: undefined as string | undefined, hex: freshKeyHex() },
  { keyId: 4, purpose: 'encryption', securityLevel: 'medium', bound: 'contactRequest', hex: freshKeyHex() },
  { keyId: 5, purpose: 'decryption', securityLevel: 'medium', bound: 'contactRequest', hex: freshKeyHex() },
];
u3.pendingKeys = add; writeState(st); // persist the new private keys BEFORE broadcasting: the update may land even if the call throws
const signer = new w.IdentitySigner();
for (const k of u3.keys) signer.addKeyFromWif(wifOf(k.hex)); // master key 0 signs the update
for (const k of add) signer.addKeyFromWif(wifOf(k.hex));     // each new key signs its own registration
const keysInCreation = add.map((k) => {
  const o: any = { keyId: k.keyId, purpose: k.purpose, securityLevel: k.securityLevel, keyType: 'ecdsa_secp256k1', isReadOnly: false, data: pubKeyOf(k.hex) };
  if (k.bound) o.contractBounds = w.ContractBounds.SingleContractDocumentType(DASHPAY_CONTRACT, k.bound);
  return new w.IdentityPublicKeyInCreation(o);
});
const identity = await sdk.identities.fetch(u3.identityId);
const t0 = performance.now();
let error: string | undefined;
try {
  await sdk.identities.update({ identity, addPublicKeys: keysInCreation, signer });
} catch (e) { error = errText(e); console.log(`update threw: ${error.slice(0, 300)}`); }
const ms = Math.round(performance.now() - t0);
let after = before;
for (let i = 0; i < 30; i++) { const b = await readBal(); if (b !== before) { await sleep(2000); after = await readBal(); break; } await sleep(2000); }
const now = await sdk.identities.fetch(u3.identityId);
const keyCount = now.publicKeys.length;
const fee = before - after;
if (keyCount === 6) { u3.keys.push(...add); delete u3.pendingKeys; writeState(st); }
console.log(`add 3 keys to u3: fee ${fee} credits (${dash(fee)} DASH), identity now has ${keyCount} keys, ${ms} ms`);
saveResult('testnet-keys-add.json', { at: new Date().toISOString(), identity: u3.identityId, added: add.map((k) => `${k.keyId}:${k.purpose}/${k.securityLevel}${k.bound ? ' bound ' + k.bound : ''}`), feeCredits: fee.toString(), feeDash: dash(fee), keyCountAfter: keyCount, ms, error, note: 'testnet is protocol 14; fee indicative of PV13' });
process.exit(error ? 1 : 0);
