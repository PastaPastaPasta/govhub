// Shared by the one-shot publish scripts: the `<identity key file | dev-owner>` argument. `dev-owner` is the dev gov owner's
// authentication/HIGH key from ~/.local/share/govhub-phase0/testnet/state.json. Nothing secret is printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readIdentityKeyFile, type IdentityKeyFile } from '../src/config.ts';

export function identityKeyFromArg(arg: string): IdentityKeyFile {
  if (arg !== 'dev-owner') return readIdentityKeyFile(arg);
  const st = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase0/testnet/state.json'), 'utf8'));
  const owner = st.items.find((i: any) => i.name === 'owner');
  const high = owner.keys.find((k: any) => k.purpose === 'authentication' && k.securityLevel === 'high');
  return { identityId: owner.identityId, keyId: high.keyId, privateKeyHex: high.hex };
}
