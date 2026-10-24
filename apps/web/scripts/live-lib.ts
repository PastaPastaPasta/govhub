// Node helpers for the opt-in live testnet runs (scripts and e2e/live-forum.spec.ts): an evo-sdk client, the phase-0
// spike identities' keys (read from ~/.local/share/govhub-phase0/testnet/state.json, never copied into the repo) and
// settled balance reads (nodes lag right after a write).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { base58 } from '@scure/base';
import { encodeWif } from '@govhub/verify';

export const STATE_FILE = join(homedir(), '.local/share/govhub-phase0/testnet/state.json');

interface StateKey {
  keyId: number;
  purpose: string;
  securityLevel: string;
  hex: string;
}
interface StateItem {
  name: string;
  identityId: string;
  keys: StateKey[];
}

/** A spike identity: id and the hex of its HIGH authentication key (keyId 2). */
export function spikeIdentity(name: 'u3' | 'u6' | 'owner'): { identityId: string; highKeyHex: string } {
  const st = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { items: StateItem[] };
  const it = st.items.find((i) => i.name === name);
  const k = it?.keys.find((x) => x.purpose === 'authentication' && x.securityLevel === 'high');
  if (!it || !k) throw new Error(`no HIGH key for ${name} in ${STATE_FILE}`);
  return { identityId: it.identityId, highKeyHex: k.hex };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connect() {
  const evo = await import('@dashevo/evo-sdk');
  await evo.ensureInitialized?.();
  const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 30000, retries: 2 } });
  await sdk.connect();

  /** Reads until two consecutive answers agree and (if given) differ from `notEqual`. */
  async function stableBalance(id: string, notEqual?: bigint): Promise<bigint> {
    let prev: bigint | undefined;
    for (let i = 0; i < 30; i++) {
      const b = BigInt((await sdk.identities.balance(id)) ?? 0n);
      if (prev === b && b !== notEqual) return b;
      prev = b;
      await sleep(1500);
    }
    return prev!;
  }

  /** Documents of one type, proof-verified, as `toJSON()` objects. */
  async function queryDocs(contractId: string, documentTypeName: string, where: unknown[], orderBy?: unknown[], limit = 100) {
    const r = await sdk.documents.queryWithProof({ dataContractId: contractId, documentTypeName, where, ...(orderBy ? { orderBy } : {}), limit } as never);
    return [...r.data.values()].filter(Boolean).map((d) => d!.toJSON() as Record<string, unknown>);
  }

  /** Signs creates with a spike identity's HIGH key (PV14 testnet: zero $id, derived from the nonce). */
  function signerFor(name: 'u3' | 'u6' | 'owner') {
    const { identityId, highKeyHex } = spikeIdentity(name);
    const signer = new evo.IdentitySigner();
    signer.addKeyFromWif(encodeWif(Uint8Array.from(Buffer.from(highKeyHex, 'hex')), true, 'testnet'));
    const idBytes = (s: string) => base58.decode(s);
    return {
      identityId,
      async create(contractId: string, type: string, data: Record<string, unknown>) {
        const identity = await sdk.identities.fetch(identityId);
        const key = identity!.publicKeys.find((k) => k.keyId === 2)!;
        const props = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));
        const document = evo.Document.fromObject(
          { $formatVersion: '0', $id: new Uint8Array(32), $ownerId: idBytes(identityId), $dataContractId: idBytes(contractId), $type: type, $revision: 1n, $entropy: crypto.getRandomValues(new Uint8Array(32)), ...props } as never,
          evo.PlatformVersion.latest(),
        );
        const created = await sdk.documents.create({ document, identityKey: key, signer });
        return { id: created.id.toString() };
      },
      async delete(contractId: string, type: string, id: string) {
        const identity = await sdk.identities.fetch(identityId);
        const key = identity!.publicKeys.find((k) => k.keyId === 2)!;
        await sdk.documents.delete({ document: { id, ownerId: identityId, dataContractId: contractId, documentTypeName: type }, identityKey: key, signer });
      },
    };
  }

  return { sdk, evo, stableBalance, queryDocs, signerFor };
}
