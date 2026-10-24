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
import { concatBytes, fromBase64, identifierBytes, randomBytes, sha256d, toBase58, toBase64 } from './bytes.ts';
import { publicKeyOf as evoPub, type IdentityKeyInfo, type Network } from './keys.ts';
import type { AssetLockProofInput, DocValue, DocumentWrite, DocumentWritten, PlatformPort, SigningKey, VaultEntryDoc } from './platform.ts';

type EvoModule = typeof Evo;
type Sdk = InstanceType<EvoModule['EvoSDK']>;

const PURPOSE = ['authentication', 'encryption', 'decryption', 'transfer', 'system', 'voting', 'owner'] as const;
const LEVEL = ['master', 'critical', 'high', 'medium'] as const;
const KTYPE = ['ecdsa_secp256k1', 'bls12_381', 'ecdsa_hash160', 'bip13_script_hash', 'eddsa_25519_hash160'] as const;

const errText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors a lagging node raises before executing: a just-written document not found yet (40101), a stale nonce. */
const LAGGING = /40101|document not found|nonce/i;

/** Retries a write that a lagging node refused, as the phase-0 scripts had to. `fn` gets the attempt number (0 first). */
async function lagRetry<T>(fn: (attempt: number) => Promise<T>, tries = 4, lagging: RegExp = LAGGING): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      if (i >= tries || !lagging.test(errText(e))) throw e;
      // Lagging nodes catch up within seconds to tens of seconds (a delete right after its create): back off 2.5 s, 5 s, 7.5 s, 10 s.
      await sleep(Math.min(2500 * (i + 1), 10_000));
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
  // WASM copies of private keys (PrivateKey objects, the signer's key map) are freed as soon as the call is done (best effort:
  // free() releases the WASM memory; it does not promise zeroing).
  const withKeys = async <T>(keys: readonly SigningKey[], extra: Uint8Array | null, fn: (signer: Evo.IdentitySigner, extraKey: Evo.PrivateKey | null) => Promise<T>): Promise<T> => {
    const s = new w.IdentitySigner();
    const pks = keys.map((k) => pk(k.privateKey));
    const x = extra ? pk(extra) : null;
    try {
      for (const k of pks) s.addKey(k);
      return await fn(s, x);
    } finally {
      // An object the SDK took by value is already consumed; freeing it again is a no-op we ignore.
      for (const o of [...pks, x, s]) {
        try {
          o?.free();
        } catch {
          /* already consumed */
        }
      }
    }
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

  // ---- the one document writer (govhub's forum writes, the passkey vault) ----
  // Integers go to the SDK as bigint. PV13 has no Document.generateId and checks $id against
  // sha256d(contract || owner || type || entropy); PV14 derives the id from the identity-contract nonce when $id is zero
  // (spikes/sdk5 README 8.3). A broadcast through a lagging node can fail with 40101 / a stale nonce before it executes: those are
  // retried, re-sending the same document. A PV14 create is never retried (a retry after a write that landed would make a second
  // document); a PV13 create retried after it landed answers "already exists", which is success only if a proved read finds the id it
  // sent (the id comes from fresh entropy, so only this write can have stored it).
  const toSdk = (data: Record<string, DocValue>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));
  async function writeDocument({ ownerId, key: callerKey, op }: { ownerId: string; key: SigningKey; op: DocumentWrite }): Promise<DocumentWritten> {
    // A private copy for the duration of the write: signing out mid-write wipes the session's key, not this one (wiped below).
    if (callerKey.privateKey.every((b) => b === 0)) throw new Error('This session has ended. Sign in again.');
    const key: SigningKey = { ...callerKey, privateKey: callerKey.privateKey.slice() };
    try {
      return await write(ownerId, key, op);
    } finally {
      key.privateKey.fill(0);
    }
  }
  async function write(ownerId: string, key: SigningKey, op: DocumentWrite): Promise<DocumentWritten> {
    const identity = await fetchIdentity(ownerId);
    const idKey = identity?.getPublicKeyById(key.id);
    if (!identity || !idKey) throw new Error('signing key not found on the identity');
    const owner = identifierBytes(ownerId);
    const contract = identifierBytes(op.contractId);
    let run: (attempt: number) => Promise<DocumentWritten>;
    let retry = true;
    if (op.action === 'delete') {
      // A 40101 on delete is a lagging node refusing before execution: retried, and after the last try it is an error, never success.
      run = () =>
        withKeys([key], null, async (signer) => {
          await sdk.documents.delete({ document: { id: op.id, ownerId, dataContractId: op.contractId, documentTypeName: op.type }, identityKey: idKey, signer });
          return { id: op.id };
        });
    } else if (op.action === 'replace') {
      const document = w.Document.fromObject(
        { $formatVersion: '0', $id: identifierBytes(op.id), $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: BigInt(op.revision + 1), ...toSdk(op.data) } as never,
        w.PlatformVersion.latest() as never,
      );
      run = () => withKeys([key], null, async (signer) => {
        await sdk.documents.replace({ document, identityKey: idKey, signer });
        return { id: op.id, revision: op.revision + 1 };
      });
    } else {
      const entropy = randomBytes(32);
      const pv13 = sdk.version() <= 13;
      const id = pv13 ? sha256d(concatBytes(contract, owner, new TextEncoder().encode(op.type), entropy)) : new Uint8Array(32);
      const document = w.Document.fromObject(
        { $formatVersion: '0', $id: id, $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: 1n, $entropy: entropy, ...toSdk(op.data) } as never,
        w.PlatformVersion.latest() as never,
      );
      const create = () => withKeys([key], null, async (signer) => ({ id: (await sdk.documents.create({ document, identityKey: idKey, signer })).id.toString(), revision: 1 }));
      if (!pv13) {
        retry = false;
        run = create;
      } else {
        // Only a RETRY that finds its own id already stored is success (the first attempt landed); a first attempt refused as a
        // duplicate is a real refusal (e.g. a unique index already holds a document).
        run = async (attempt) => {
          try {
            return await create();
          } catch (e) {
            if (attempt > 0 && /already (exists|present)|duplicate/i.test(errText(e)) && (await sdk.documents.getWithProof(op.contractId, op.type, toBase58(id)).then((r) => r.data, () => undefined))) return { id: toBase58(id), revision: 1 };
            throw e;
          }
        };
      }
    }
    try {
      return await (retry ? lagRetry(run, 4) : run(0));
    } catch (e) {
      throw new Error(errText(e)); // WASM errors are not Error instances
    }
  }

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
      await withKeys(keys, assetLockKey, (signer, alk) => sdk.identities.create({ identity, assetLockProof: alp, signer, assetLockPrivateKey: alk! }));
    },
    async topUpIdentity({ identityId, proof, assetLockKey }) {
      const identity = await fetchIdentity(identityId);
      if (!identity) throw new Error('identity not found');
      await withKeys([], assetLockKey, (_s, alk) => sdk.identities.topUp({ identity, assetLockProof: proofOf(proof), assetLockPrivateKey: alk! }));
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
      await withKeys([master, ...keys], null, (signer) => lagRetry(() => sdk.identities.update({ identity, addPublicKeys: add, signer }), 4, /40101|not found|nonce/i));
    },
    writeDocument: (o) => writeDocument(o),
    vault: {
      list: (contractId, ownerId) => queryVault(contractId, [['$ownerId', '==', ownerId]], [['$ownerId', 'asc'], ['credentialId', 'asc']]),
      async byCredential(contractId, ownerId, credentialId) {
        const r = await queryVault(contractId, [['$ownerId', '==', ownerId], ['credentialId', '==', toBase64(credentialId)]]);
        return r[0] ?? null;
      },
      async put({ contractId, ownerId, key, entry, existing }) {
        const now = Date.now();
        const data = { credentialId: entry.credentialId, recipientKey: entry.recipientKey, version: entry.version, authKeyId: entry.authKeyId, enc: entry.enc, sealed: entry.sealed, $updatedAt: now };
        await writeDocument({
          ownerId,
          key,
          op: existing ? { action: 'replace', contractId, type: 'vault', id: existing.id, revision: existing.revision, data } : { action: 'create', contractId, type: 'vault', data: { ...data, $createdAt: now } },
        });
      },
      async remove({ contractId, ownerId, key, entry }) {
        await writeDocument({ ownerId, key, op: { action: 'delete', contractId, type: 'vault', id: entry.id } });
      },
    },
  };
}
