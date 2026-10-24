// Development only: write a BRIDGE_IDENTITY_KEY_FILE for the phase-0 testnet contract owner from the spike state
// (~/.local/share/govhub-phase0/testnet/state.json). Prints nothing secret.
//
//   node scripts/dev-keyfile.ts [out=~/.local/share/govhub-dev/bridge-key.json] [identityName=owner] [keyId=2]
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const out = process.argv[2] ?? join(homedir(), '.local/share/govhub-dev/bridge-key.json');
const name = process.argv[3] ?? 'owner';
const keyId = Number(process.argv[4] ?? 2);
const state = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8'));
const item = state.items.find((i: { name: string }) => i.name === name);
if (!item) throw new Error(`no identity ${name} in the phase-0 state`);
const key = item.keys.find((k: { keyId: number }) => k.keyId === keyId);
if (!key) throw new Error(`identity ${name} has no key ${keyId}`);
if (key.purpose !== 'authentication' || key.securityLevel !== 'high') throw new Error(`key ${keyId} is ${key.purpose}/${key.securityLevel}, gov documents need authentication/high`);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, JSON.stringify({ identityId: item.identityId, keyId, privateKeyHex: key.hex }) + '\n', { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`wrote ${out} for identity ${item.identityId} key ${keyId} (authentication/high)`);
