// KeyringStore on evo-sdk 5.x: proved reads of `forum.keyring` and writes through the app's single document writer
// (PlatformPort.writeDocument, evo.ts). Entry point '@govhub/auth/keyring-evo'; like '@govhub/auth/evo' it never imports the SDK
// itself (the caller passes the loaded module and a connected EvoSDK).
import type * as Evo from '@dashevo/evo-sdk';
import { fromBase64 } from '../bytes.ts';
import type { DocValue, PlatformPort } from '../platform.ts';
import type { KeyringDoc, KeyringStore } from './keyring.ts';

type EvoModule = typeof Evo;
type Sdk = InstanceType<EvoModule['EvoSDK']>;

export const KEYRING_DOCUMENT_TYPE = 'keyring';

/** Query shape K1 (packages/contracts-v1/README.md): one document by owner and kind, full coverage of `byOwnerKind`. */
export const keyringQuery = (contractId: string, ownerId: string, kind: number) => ({
  dataContractId: contractId,
  documentTypeName: KEYRING_DOCUMENT_TYPE,
  where: [
    ['$ownerId', '==', ownerId],
    ['kind', '==', kind],
  ] as Array<[string, '==', unknown]>,
  limit: 1,
});

/** Parses a document's JSON form (byte arrays come back base64). Exported for tests. */
export function keyringDocFromJson(d: Record<string, unknown>): KeyringDoc {
  const b = (k: string): Uint8Array | null => {
    const v = d[k];
    if (v === undefined || v === null) return null;
    if (v instanceof Uint8Array) return Uint8Array.from(v);
    if (Array.isArray(v)) return Uint8Array.from(v as number[]);
    return fromBase64(String(v));
  };
  const n = (k: string) => Number(d[k]);
  const chunks = ['c0', 'c1', 'c2'].map(b).filter((x): x is Uint8Array => x !== null);
  return {
    id: String(d.$id),
    ownerId: String(d.$ownerId),
    revision: n('$revision'),
    kind: n('kind'),
    sealed: { version: n('version'), bucket: n('bucket'), wraps: b('wraps') ?? new Uint8Array(0), chunks },
  };
}

export function createEvoKeyringStore(evo: EvoModule, sdk: Sdk, platform: PlatformPort, contractId: string): KeyringStore {
  const version = (evo as unknown as { PlatformVersion: { latest(): unknown } }).PlatformVersion;
  return {
    async get(ownerId, kind) {
      const res = await sdk.documents.queryWithProof(keyringQuery(contractId, ownerId, kind) as never);
      const docs = [...res.data.values()].filter((x): x is Evo.Document => !!x).map((x) => keyringDocFromJson(x.toJSON(version.latest() as never) as Record<string, unknown>));
      return docs.find((d) => d.ownerId === ownerId && d.kind === kind) ?? null;
    },
    async put({ ownerId, key, kind, sealed, existing }) {
      const data: Record<string, DocValue> = { kind, version: sealed.version, bucket: sealed.bucket, wraps: sealed.wraps };
      sealed.chunks.forEach((c, i) => (data[`c${i}`] = c));
      const r = await platform.writeDocument({
        ownerId,
        key,
        op: existing ? { action: 'replace', contractId, type: KEYRING_DOCUMENT_TYPE, id: existing.id, revision: existing.revision, data } : { action: 'create', contractId, type: KEYRING_DOCUMENT_TYPE, data },
      });
      return { id: r.id, revision: r.revision ?? (existing ? existing.revision + 1 : 1) };
    },
    async remove({ ownerId, key, doc }) {
      await platform.writeDocument({ ownerId, key, op: { action: 'delete', contractId, type: KEYRING_DOCUMENT_TYPE, id: doc.id } });
    },
  };
}
