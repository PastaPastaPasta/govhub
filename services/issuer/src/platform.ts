// The issuer's Platform access (evo-sdk 5.0.0-rc.8): proved reads of its own `badge` documents, and document writes through
// @govhub/auth's single document writer (nonce handling and settle-by-proved-read). Byte-array `where` values are base64.
import { createEvoPlatform } from '@govhub/auth/evo';
import { BADGE_TYPES, issuerKeyData, issuerReportData, parseIssuerKeyDoc, parseIssuerReportDoc, type IssuerKeyDoc, type IssuerReport } from '@govhub/badge';
import type { IdentityKeyFile, PlatformNetwork } from './config.ts';
import { errText } from './log.ts';

type Evo = typeof import('@dashevo/evo-sdk');
type Sdk = InstanceType<Evo['EvoSDK']>;

const SECURITY = { critical: 1, high: 2 } as const;

/** What the service and the CLI need from Platform; tests use a fake. */
export interface IssuerPlatform {
  /** Proved: the issuerKey of `issuerId` for `epoch` (B1), or null. */
  issuerKey(issuerId: string, epoch: number): Promise<IssuerKeyDoc | null>;
  /** Proved: the issuerReport for `epoch` (B3), or null. */
  issuerReport(issuerId: string, epoch: number): Promise<IssuerReport | null>;
  /** Platform's view of Core (proved metadata): the newest chain-locked core height. */
  coreHeight(): Promise<number>;
  publishIssuerKey(key: IdentityKeyFile, o: { epoch: number; spki: Uint8Array; keyId: Uint8Array }): Promise<string>;
  publishIssuerReport(key: IdentityKeyFile, o: { epoch: number; tokensIssued: number }): Promise<string>;
}

export async function connectPlatform(network: PlatformNetwork, contractId: string): Promise<IssuerPlatform> {
  const evo: Evo = await import('@dashevo/evo-sdk');
  await (evo as { ensureInitialized?: () => Promise<void> }).ensureInitialized?.();
  const opts = { settings: { timeoutMs: 30_000, retries: 2 } };
  const sdk: Sdk = network === 'mainnet' ? evo.EvoSDK.mainnetTrusted(opts) : evo.EvoSDK.testnetTrusted(opts);
  await sdk.connect();
  // One proved read first, so writes use the network's real protocol version (the SDK ratchets up from proven metadata).
  await sdk.contracts.fetchWithProof(contractId);
  const writer = createEvoPlatform(evo, sdk, network);
  const w = evo as unknown as { PrivateKey: { fromWIF(wif: string): { toBytes(): Uint8Array } } };

  async function query(type: string, where: unknown[][]): Promise<{ docs: Record<string, unknown>[]; coreHeight: number }> {
    const res = await sdk.documents.queryWithProof({ dataContractId: contractId, documentTypeName: type, where, limit: 2 } as never);
    const docs = [...res.data.values()].filter((d): d is NonNullable<typeof d> => !!d).map((d) => d.toJSON() as Record<string, unknown>);
    return { docs, coreHeight: Number((res as unknown as { metadata: { coreChainLockedHeight: number } }).metadata.coreChainLockedHeight) };
  }
  const one = async <T>(type: string, issuerId: string, epoch: number, parse: (d: Record<string, unknown>) => T): Promise<T | null> => {
    const { docs } = await query(type, [['$ownerId', '==', issuerId], ['epoch', '==', epoch]]);
    if (docs.length > 1) throw new Error(`${type}: more than one document for a unique index`);
    return docs[0] ? parse(docs[0]) : null;
  };
  const signingKey = (k: IdentityKeyFile, level: 1 | 2) => ({
    id: k.keyId,
    purpose: 0,
    securityLevel: level,
    type: 0,
    privateKey: k.privateKeyHex ? Uint8Array.from(Buffer.from(k.privateKeyHex, 'hex')) : w.PrivateKey.fromWIF(k.wif!).toBytes(),
  });
  const create = async (k: IdentityKeyFile, level: 1 | 2, type: string, data: Record<string, Uint8Array | number | string>) => {
    try {
      // Every badge type requires $createdAtCoreBlockHeight; Drive overwrites it with the block's core height, the client only
      // sends a plausible value.
      const $createdAtCoreBlockHeight = await this_.coreHeight();
      const r = await writer.writeDocument({ ownerId: k.identityId, key: signingKey(k, level), op: { action: 'create', contractId, type, data: { ...data, $createdAtCoreBlockHeight } } });
      return r.id;
    } catch (e) {
      throw new Error(`${type}: ${errText(e)}`);
    }
  };

  const this_: IssuerPlatform = {
    issuerKey: (issuerId, epoch) => one(BADGE_TYPES.issuerKey, issuerId, epoch, parseIssuerKeyDoc),
    issuerReport: (issuerId, epoch) => one(BADGE_TYPES.issuerReport, issuerId, epoch, parseIssuerReportDoc),
    async coreHeight() {
      const r = await sdk.contracts.fetchWithProof(contractId);
      return Number((r as unknown as { metadata: { coreChainLockedHeight: number } }).metadata.coreChainLockedHeight);
    },
    publishIssuerKey: (k, o) => create(k, SECURITY.critical, BADGE_TYPES.issuerKey, issuerKeyData(o)),
    publishIssuerReport: (k, o) => create(k, SECURITY.high, BADGE_TYPES.issuerReport, issuerReportData(o)),
  };
  return this_;
}

