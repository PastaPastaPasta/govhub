// Test tooling: the testnet masternode voting keys in ~/workspace/dash-network-configs/testnet.yml (the owner key of each
// masternode is its voting key there). Keys are read at run time and never printed or written; only public data leaves here.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TestMnKey {
  name: string;
  /** owner == voting address (public) */
  address: string;
  /** WIF; never log it */
  wif: string;
}

export function testnetMnKeys(): TestMnKey[] {
  const text = readFileSync(join(homedir(), 'workspace/dash-network-configs/testnet.yml'), 'utf8');
  const out: TestMnKey[] = [];
  let name: string | null = null;
  let section: string | null = null;
  let address: string | null = null;
  for (const line of text.split('\n')) {
    let m = /^  ((?:hp-)?masternode-\d+):\s*$/.exec(line);
    if (m) {
      name = m[1]!;
      section = null;
      continue;
    }
    m = /^    (\w+):\s*$/.exec(line);
    if (m) {
      section = m[1]!;
      address = null;
      continue;
    }
    if (section !== 'owner' || !name) continue;
    m = /^      address:\s*(\S+)/.exec(line);
    if (m) address = m[1]!;
    m = /^      private_key:\s*(\S+)/.exec(line);
    if (m && address) out.push({ name, address, wif: m[1]! });
  }
  return out;
}
