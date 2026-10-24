// PlatformPort on evo-sdk 5.x (spikes/sdk5 patterns). The caller passes the already-loaded module and a connected EvoSDK, so this
// file never pulls the SDK into a bundle by itself. All reads use the proof-verifying calls.
//
// Notes carried over from phase 0:
//  - PV13: the SDK rejects a zero `$id` and Document.generateId() throws; the id is sha256d(contractId || ownerId || type || entropy).
//    PV14 derives it from the identity-contract nonce when `$id` is zero.
//  - byteArray `where` values are base64 strings (hex silently matches nothing).
//  - A broadcast through a lagging node can fail with 40101 / nonce errors right after a write: retried here.
//  - WASM errors are not Error instances: read `.message`.
import type * as Evo from '@dashevo/evo-sdk';
import { concatBytes, fromBase64, identifierBytes, randomBytes, sha256d, toBase64 } from './bytes.ts';
import { publicKeyOf as evoPub, type IdentityKeyInfo, type Network } from './keys.ts';
import type { AssetLockProofInput, PlatformPort, SigningKey, VaultEntryDoc } from './platform.ts';

type EvoModule = typeof Evo;
type Sdk = InstanceType<EvoModule['EvoSDK']>;

const PURPOSE = ['authentication', 'encryption', 'decryption', 'transfer', 'system', 'voting', 'owner'] as const;
const LEVEL = ['master', 'critical', 'high', 'medium'] as const;
const KTYPE = ['ecdsa_secp256k1', 'bls12_381', 'ecdsa_hash160', 'bip13_script_hash', 'eddsa_25519_hash160'] as const;

const errText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries a write that a lagging node refused (40101 not found / nonce), as the phase-0 scripts had to. */
async function lagRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = errText(e);
      if (i >= tries || !/40101|not found|nonce/i.test(m)) throw e;
      await sleep(3000);
    }
  }
}

export function createEvoPlatform(evo: EvoModule, sdk: Sdk, network: Network): PlatformPort {
  const w = evo as unknown as {
    Identity: new (id: Uint8Array | string) => Evo.Identity;
    IdentityPublicKey: new (o: Evo.IdentityPublicKeyOptions) => Evo.IdentityPublicKey;
    IdentityPublicKeyInCreation: new (o: Evo.IdentityPublicKeyInCreationOptions) => Evo.IdentityPublicKeyInCreation;
    IdentitySigner: new () => Evo.IdentitySigner;
    PrivateKey: typeof Evo.PrivateKey;
    AssetLockProof: typeof Evo.AssetLockProof;
    OutPoint: new (txid: string, vout: number) => Evo.OutPoint;
    ContractBounds: typeof Evo.ContractBounds;
    Document: typeof Evo.Document;
    PlatformVersion: { latest(): unknown };
  };

  const pk = (priv: Uint8Array) => w.PrivateKey.fromBytes(priv, network);
  const signerFor = (keys: readonly SigningKey[]) => {
    const s = new w.IdentitySigner();
    for (const k of keys) s.addKey(pk(k.privateKey));
    return s;
  };
  const proofOf = (p: AssetLockProofInput) =>
    p.kind === 'instant'
      ? w.AssetLockProof.createInstantAssetLockProof(p.isLock, p.tx, p.creditIndex)
      : w.AssetLockProof.createChainAssetLockProof(p.coreChainLockedHeight, new w.OutPoint(p.txid, p.creditIndex));
  const keyInfo = (k: Evo.IdentityPublicKey): IdentityKeyInfo => {
    const o = k.toObject();
    return { id: o.id, purpose: o.purpose, securityLevel: o.securityLevel, type: o.type, data: Uint8Array.from(o.data), disabled: o.disabledAt !== undefined && o.disabledAt !== null, bound: !!o.contractBounds };
  };
  const fetchIdentity = async (id: string) => (await sdk.identities.fetchWithProof(id)).data;

  const docId = async (contractId: string, ownerId: string, type: string, entropy: Uint8Array): Promise<Uint8Array> =>
    sdk.version() <= 13 ? sha256d(concatBytes(identifierBytes(contractId), identifierBytes(ownerId), new TextEncoder().encode(type), entropy)) : new Uint8Array(32);

  const toEntry = (d: Record<string, unknown>): VaultEntryDoc => {
    const b = (k: string): Uint8Array => {
      const v = d[k];
      if (v instanceof Uint8Array) return Uint8Array.from(v);
      if (Array.isArray(v)) return Uint8Array.from(v as number[]);
      return fromBase64(String(v));
    };
    const n = (k: string) => Number(d[k]);
    return {
      id: String(d.$id),
      ownerId: String(d.$ownerId),
      revision: n('$revision'),
      credentialId: b('credentialId'),
      recipientKey: b('recipientKey'),
      version: n('version'),
      authKeyId: n('authKeyId'),
      enc: b('enc'),
      sealed: b('sealed'),
      createdAt: d.$createdAt === undefined ? undefined : n('$createdAt'),
      updatedAt: d.$updatedAt === undefined ? undefined : n('$updatedAt'),
    };
  };
  const queryVault = async (contractId: string, where: unknown[], orderBy?: unknown[]): Promise<VaultEntryDoc[]> => {
    const res = await sdk.documents.queryWithProof({ dataContractId: contractId, documentTypeName: 'vault', where, ...(orderBy ? { orderBy } : {}), limit: 100 } as never);
    return [...res.data.values()].filter((x): x is Evo.Document => !!x).map((x) => toEntry(x.toJSON(w.PlatformVersion.latest() as never) as Record<string, unknown>));
  };

  return {
    network,
    async identityByUniqueKeyHash(h) {
      const r = await sdk.identities.byPublicKeyHashWithProof(Uint8Array.from(h) as never);
      return r.data ? r.data.id.toString() : null;
    },
    async identitiesByNonUniqueKeyHash(h) {
      const r = await sdk.identities.byNonUniquePublicKeyHashWithProof(Uint8Array.from(h) as never);
      return r.data.map((i: Evo.Identity) => i.id.toString());
    },
    async identityKeys(id) {
      const i = await fetchIdentity(id);
      return i ? i.publicKeys.map(keyInfo) : null;
    },
    async balance(id) {
      const r = await sdk.identities.balanceWithProof(id);
      return r.data ?? null;
    },
    async coreChainLockedHeight() {
      const r = await sdk.system.totalCreditsInPlatformWithProof();
      return Number((r as unknown as { metadata: { coreChainLockedHeight: number } }).metadata.coreChainLockedHeight);
    },
    async createIdentity({ proof, assetLockKey, keys }) {
      const alp = proofOf(proof);
      const identity = new w.Identity(alp.createIdentityId().toString());
      for (const k of keys) {
        identity.addPublicKey(
          new w.IdentityPublicKey({ keyId: k.id, purpose: PURPOSE[k.purpose]!, securityLevel: LEVEL[k.securityLevel]!, keyType: KTYPE[k.type]!, isReadOnly: false, data: evoPub(k.privateKey) }),
        );
      }
      await sdk.identities.create({ identity, assetLockProof: alp, signer: signerFor(keys), assetLockPrivateKey: pk(assetLockKey) });
    },
    async topUpIdentity({ identityId, proof, assetLockKey }) {
      const identity = await fetchIdentity(identityId);
      if (!identity) throw new Error('identity not found');
      await sdk.identities.topUp({ identity, assetLockProof: proofOf(proof), assetLockPrivateKey: pk(assetLockKey) });
    },
    async addKeys({ identityId, master, keys }) {
      const identity = await fetchIdentity(identityId);
      if (!identity) throw new Error('identity not found');
      const add = keys.map(
        (k) =>
          new w.IdentityPublicKeyInCreation({
            keyId: k.id,
            purpose: PURPOSE[k.purpose]!,
            securityLevel: LEVEL[k.securityLevel]!,
            keyType: KTYPE[k.type]!,
            isReadOnly: false,
            data: evoPub(k.privateKey),
            ...(k.bound ? { contractBounds: w.ContractBounds.SingleContractDocumentType(k.bound.contractId, k.bound.documentType) } : {}),
          } as Evo.IdentityPublicKeyInCreationOptions),
      );
      await lagRetry(() => sdk.identities.update({ identity, addPublicKeys: add, signer: signerFor([master, ...keys]) }));
    },
    vault: {
      list: (contractId, ownerId) => queryVault(contractId, [['$ownerId', '==', ownerId]], [['$ownerId', 'asc'], ['credentialId', 'asc']]),
      async byCredential(contractId, ownerId, credentialId) {
        const r = await queryVault(contractId, [['$ownerId', '==', ownerId], ['credentialId', '==', toBase64(credentialId)]]);
        return r[0] ?? null;
      },
      async put({ contractId, ownerId, key, entry, existing }) {
        const identity = await fetchIdentity(ownerId);
        const idKey = identity?.getPublicKeyById(key.id);
        if (!identity || !idKey) throw new Error('signing key not found on the identity');
        const props = { credentialId: entry.credentialId, recipientKey: entry.recipientKey, version: entry.version, authKeyId: entry.authKeyId, enc: entry.enc, sealed: entry.sealed };
        const now = BigInt(Date.now());
        const signer = signerFor([key]);
        if (existing) {
          const doc = w.Document.fromObject(
            { $formatVersion: '0', $id: identifierBytes(existing.id), $ownerId: identifierBytes(ownerId), $dataContractId: identifierBytes(contractId), $type: 'vault', $revision: BigInt(existing.revision + 1), $updatedAt: now, ...props } as never,
            w.PlatformVersion.latest() as never,
          );
          await lagRetry(() => sdk.documents.replace({ document: doc, identityKey: idKey, signer }));
        } else {
          const entropy = randomBytes(32);
          const doc = w.Document.fromObject(
            { $formatVersion: '0', $id: await docId(contractId, ownerId, 'vault', entropy), $ownerId: identifierBytes(ownerId), $dataContractId: identifierBytes(contractId), $type: 'vault', $revision: 1n, $entropy: entropy, $createdAt: now, $updatedAt: now, ...props } as never,
            w.PlatformVersion.latest() as never,
          );
          await lagRetry(() => sdk.documents.create({ document: doc, identityKey: idKey, signer }));
        }
      },
      async remove({ contractId, ownerId, key, entry }) {
        const identity = await fetchIdentity(ownerId);
        const idKey = identity?.getPublicKeyById(key.id);
        if (!identity || !idKey) throw new Error('signing key not found on the identity');
        await lagRetry(() => sdk.documents.delete({ document: { id: entry.id, ownerId, dataContractId: contractId, documentTypeName: 'vault' }, identityKey: idKey, signer: signerFor([key]) }));
      },
    },
  };
}
