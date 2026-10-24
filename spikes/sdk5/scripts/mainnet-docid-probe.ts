// Offline-ish probe (fails client-side, costs nothing): at PV13 evo-sdk rc.8 requires `$id` to equal the id derived from
// the entropy. Check that sha256d(contractId || ownerId || typeName || entropy) is that id, so the real script can pre-compute it.
import { createHash } from 'node:crypto';
import { errText } from './lib.ts';
import { keyHexAt, IDENTITY_KEY_PATH, readState, wifOf } from './mainnet-lib.ts';

const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.mainnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const st: any = readState(null);
const M = st.items[0].identityId, CID = st.check.contract.id;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const idBytes = (s: string): Uint8Array => { let v = 0n; for (const c of s) v = v * 58n + BigInt(B58.indexOf(c)); const o: number[] = []; while (v > 0n) { o.unshift(Number(v & 255n)); v >>= 8n; } return Uint8Array.from(o); };
const b58 = (b: Uint8Array): string => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); let out = ''; while (v > 0n) { out = B58[Number(v % 58n)] + out; v /= 58n; } return out; };
const sha256d = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

const entropy = Uint8Array.from(Buffer.alloc(32, 7));
const mine = b58(Uint8Array.from(sha256d(Buffer.concat([idBytes(CID), idBytes(M), Buffer.from('comment'), entropy]))));
const identity = await sdk.identities.fetch(M);
const signer = new w.IdentitySigner(); signer.addKeyFromWif(wifOf(keyHexAt(IDENTITY_KEY_PATH(0, 2))));
const doc = w.Document.fromObject({ $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(M), $dataContractId: idBytes(CID), $type: 'comment', $revision: 1n, $entropy: entropy, $createdAt: BigInt(Date.now()), govHash: new Uint8Array(32), body: 'x', fmt: 0n }, w.PlatformVersion.latest());
try { await sdk.documents.create({ document: doc, identityKey: identity.getPublicKeyById(2), signer }); console.log('UNEXPECTED success'); } catch (e) { console.log(errText(e)); }
console.log(`sha256d candidate: ${mine}`);
process.exit(0);
