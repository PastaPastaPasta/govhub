// AppConnectPort over evo-sdk, proved reads only. The SDK is passed in (the app loads it lazily); nothing here imports it.
import type * as Evo from '@dashevo/evo-sdk';
import { fromBase64, toBase64 } from '../bytes.ts';
import { APP_CONNECT_CONTRACT_ID, RESPONSE_TYPE, type AppConnectPort, type Candidate, type ChainKey } from './port.ts';

type Sdk = InstanceType<(typeof Evo)['EvoSDK']>;

/** Bytes from the SDK's JSON forms (base64), or null when absent or of the wrong length. */
const bytesOf = (v: unknown, n?: number): Uint8Array | null => {
  let b: Uint8Array | null = null;
  if (v instanceof Uint8Array) b = Uint8Array.from(v);
  else if (typeof v === 'string') {
    try {
      b = fromBase64(v);
    } catch {
      b = null;
    }
  }
  return b && (n === undefined || b.length === n) ? b : null;
};

/** A wasm IdentityPublicKey reduced to ChainKey through its JSON form (base58 bound ids, base64 data). */
export function chainKeyOf(k: { toJSON(): unknown }): ChainKey | null {
  const j = k.toJSON() as {
    id: number;
    type: number;
    purpose: number;
    securityLevel: number;
    data: string;
    disabledAt?: number | null;
    contractBounds?: { $type: string; id: string; documentTypeName?: string } | null;
    totalBudget?: number | string | null;
    expiresAt?: number | string | null;
  };
  const data = bytesOf(j.data);
  if (!data) return null;
  let bounds: ChainKey['bounds'];
  const cb = j.contractBounds;
  if (cb) {
    if (cb.$type === 'singleContract') bounds = { kind: 'singleContract', contractId: cb.id };
    else if (cb.$type === 'documentType' && cb.documentTypeName) bounds = { kind: 'documentType', contractId: cb.id, documentTypeName: cb.documentTypeName };
    else if (cb.$type === 'contractGroup') bounds = { kind: 'contractGroup', groupId: cb.id };
    else bounds = 'unreadable';
  }
  const has = (x: unknown) => x !== null && x !== undefined;
  return {
    id: j.id,
    type: j.type,
    purpose: j.purpose,
    securityLevel: j.securityLevel,
    data,
    disabled: has(j.disabledAt),
    ...(bounds ? { bounds } : {}),
    ...(has(j.totalBudget) ? { totalBudget: BigInt(j.totalBudget!) } : {}),
    ...(has(j.expiresAt) ? { expiresAt: Number(j.expiresAt) } : {}),
  };
}

const keysOf = (ks: readonly { toJSON(): unknown }[]): ChainKey[] => ks.flatMap((k) => chainKeyOf(k) ?? []);

export function createEvoAppConnectPort(sdk: Sdk): AppConnectPort {
  return {
    async responses(hash, o) {
      const where: unknown[] = [['appEphemeralPubKeyHash', '==', toBase64(hash)]];
      if (o.hint) where.push(['$ownerId', '==', o.hint]);
      else if (o.startAfter) where.push(['$ownerId', '>', o.startAfter]);
      const r = await sdk.documents.queryWithProof({ dataContractId: APP_CONNECT_CONTRACT_ID, documentTypeName: RESPONSE_TYPE, where, orderBy: [['$ownerId', 'asc']], limit: o.limit } as never);
      const out: Candidate[] = [];
      for (const d of r.data.values()) {
        if (!d) continue;
        const j = d.toJSON() as Record<string, unknown>;
        const walletEphemeralPubKey = bytesOf(j.walletEphemeralPubKey, 33);
        const encryptedPayload = bytesOf(j.encryptedPayload);
        if (typeof j.$ownerId !== 'string' || !walletEphemeralPubKey || !encryptedPayload) continue;
        out.push({ ownerId: j.$ownerId, walletEphemeralPubKey, encryptedPayload });
      }
      return out;
    },
    async identityKeys(id) {
      const r = await sdk.identities.fetchWithProof(id);
      if (!r.data) return null;
      return { keys: keysOf(r.data.publicKeys), blockTimeMs: Number(r.metadata.timeMs) };
    },
    async remainingBudgets(id, keyIds) {
      const r = await sdk.identities.keysRemainingBudgetsWithProof(id, keyIds);
      const out = new Map<number, bigint>();
      for (const [k, v] of r.data) if (v !== null && v !== undefined) out.set(Number(k), BigInt(v));
      return out;
    },
    async contractKeys(id, contractId, purpose) {
      const r = await sdk.identities.contractKeysWithProof({ identityIds: [id], contractId, purposes: [purpose] } as never);
      const entries = r.data as Array<{ identityId: { toBase58(): string }; keys: { toJSON(): unknown }[] }>;
      const entry = entries.find((e) => e.identityId.toBase58() === id);
      // filtered here too: the query's contract filter is documented as reserved
      const boundHere = (b: ChainKey['bounds']) => typeof b === 'object' && b.kind === 'singleContract' && b.contractId === contractId;
      return entry ? keysOf(entry.keys).filter((k) => k.purpose === purpose && boundHere(k.bounds)) : [];
    },
  };
}
