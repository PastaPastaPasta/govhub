// In-memory PlatformPort for unit tests: identities with keys, a vault store, write logs.
import { bytesEqual, hash160, toBase58 } from '../src/bytes.ts';
import { KeyType, publicKeyOf, type IdentityKeyInfo, type Network } from '../src/keys.ts';
import type { PlatformPort, SigningKey, VaultEntryDoc } from '../src/platform.ts';

export class FakePlatform implements PlatformPort {
  identities = new Map<string, IdentityKeyInfo[]>();
  balances = new Map<string, bigint>();
  vaultDocs: VaultEntryDoc[] = [];
  lookups = 0;
  constructor(readonly network: Network = 'testnet') {}

  addIdentity(id: string, keys: Array<{ id: number; purpose: number; securityLevel: number; priv: Uint8Array; type?: number; disabled?: boolean; bound?: boolean }>) {
    this.identities.set(
      id,
      keys.map((k) => {
        const type = k.type ?? KeyType.ECDSA_SECP256K1;
        const pub = publicKeyOf(k.priv);
        return { id: k.id, purpose: k.purpose, securityLevel: k.securityLevel, type, data: type === KeyType.ECDSA_HASH160 ? hash160(pub) : pub, disabled: !!k.disabled, bound: !!k.bound };
      }),
    );
  }

  async identityByUniqueKeyHash(h: Uint8Array) {
    this.lookups++;
    for (const [id, keys] of this.identities) if (keys.some((k) => k.securityLevel <= 2 && bytesEqual(k.type === KeyType.ECDSA_HASH160 ? k.data : hash160(k.data), h))) return id;
    return null;
  }
  async identitiesByNonUniqueKeyHash(h: Uint8Array) {
    return [...this.identities].filter(([, keys]) => keys.some((k) => k.securityLevel === 3 && bytesEqual(hash160(k.data), h))).map(([id]) => id);
  }
  async identityKeys(id: string) {
    return this.identities.get(id) ?? null;
  }
  async balance(id: string) {
    return this.identities.has(id) ? (this.balances.get(id) ?? 0n) : null;
  }
  async coreChainLockedHeight() {
    return 1000;
  }
  async createIdentity(): Promise<void> {
    throw new Error('not in unit tests');
  }
  async topUpIdentity(): Promise<void> {
    throw new Error('not in unit tests');
  }
  async addKeys(): Promise<void> {
    throw new Error('not in unit tests');
  }
  writes: unknown[] = [];
  async writeDocument(o: { op: unknown }) {
    this.writes.push(o.op);
    return { id: toBase58(crypto.getRandomValues(new Uint8Array(32))), revision: 1 };
  }
  vault = {
    list: async (_c: string, owner: string) => this.vaultDocs.filter((d) => d.ownerId === owner),
    byCredential: async (_c: string, owner: string, cred: Uint8Array) => this.vaultDocs.find((d) => d.ownerId === owner && bytesEqual(d.credentialId, cred)) ?? null,
    put: async (o: { ownerId: string; key: SigningKey; entry: Omit<VaultEntryDoc, 'id' | 'ownerId' | 'revision'>; existing?: VaultEntryDoc | null }) => {
      const keys = this.identities.get(o.ownerId) ?? [];
      const k = keys.find((x) => x.id === o.key.id);
      if (!k || !bytesEqual(k.data, publicKeyOf(o.key.privateKey))) throw new Error('bad signature');
      if (o.existing) Object.assign(o.existing, o.entry, { revision: o.existing.revision + 1 });
      else this.vaultDocs.push({ ...o.entry, id: toBase58(crypto.getRandomValues(new Uint8Array(32))), ownerId: o.ownerId, revision: 1 });
    },
    remove: async (o: { entry: VaultEntryDoc }) => {
      this.vaultDocs = this.vaultDocs.filter((d) => d !== o.entry);
    },
  };
}
