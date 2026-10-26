// Thin wrapper around evo-sdk 5.0.0-rc.8 for the bridge's writes and proved reads.
// Patterns come from spikes/sdk5 (testnet-costs.ts, mainnet-check.ts, mainnet-docid-probe.ts):
//  - integers are passed as bigint, byte arrays as Uint8Array; `where` values for byteArray fields are BASE64 strings;
//  - PV13: evo-sdk requires $id = sha256d(contractId || ownerId || typeName || entropy) (Document.generateId throws at PV13);
//    PV14: a zero $id is accepted and the SDK derives the id (it commits to the identity contract nonce);
//  - WasmSdkError is not an Error: use errText();
//  - lagging DAPI nodes answer 40101 "not found" / nonce errors right after a write: retry; "nonce already present in past"
//    means the SDK's cached nonce is stale: refreshIdentityNonce and retry.
import { randomBytes } from 'node:crypto';
import { concatBytes, hexToBytes, sha256d, utf8ToBytes } from '@govhub/verify';
import govSchemas from '@govhub/contracts-v1/gov.json' with { type: 'json' };
import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';
import { errText, log } from '../log.ts';
import type { IdentityKeyFile, PlatformNetwork } from '../config.ts';

type Evo = typeof import('@dashevo/evo-sdk');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58ToBytes(s: string): Uint8Array {
  let v = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('invalid base58');
    v = v * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (v > 0n) {
    out.unshift(Number(v & 255n));
    v >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** PV13 document id: sha256d(contractId || ownerId || typeName || entropy) (spikes/sdk5 §8.3, mainnet-docid-probe.ts). */
function pv13DocumentId(contractId: string, ownerId: string, typeName: string, entropy: Uint8Array): Uint8Array {
  return sha256d(concatBytes(base58ToBytes(contractId), base58ToBytes(ownerId), utf8ToBytes(typeName), entropy));
}

export interface PlatformDoc {
  id: string;
  revision: number;
  /** Fields as JSON (byte arrays base64, integers as numbers/strings as the SDK renders them). */
  data: Record<string, unknown>;
}

export interface QueryOptions {
  where?: unknown[][];
  orderBy?: unknown[][];
  limit?: number;
  startAfter?: string;
  prove?: boolean;
}

/** The PV13 lint's view of the gov contract (mainnet gov.json; the testnet shape has the same indexes and indexed types). */
const GOV_LINT_SCHEMAS = govSchemas as unknown as ContractSchemas;

/** The protocol version a proved response's metadata reports (0 when absent). */
const metaPv = (r: { metadata?: { protocolVersion?: unknown } } | null | undefined): number => Number(r?.metadata?.protocolVersion) || 0;

const RETRIABLE = /not found|40101|nonce|timeout|timed out|deadline|unavailable|no available addresses|connection|ECONNRESET|503|502/i;

export class PlatformClient {
  readonly network: PlatformNetwork;
  readonly contractId: string;
  identityId = '';
  private w!: Evo;
  private sdk: any;
  private signer: any;
  private identityKey: any;
  private connected = false;
  /** Highest protocol version seen in proved response metadata (the SDK's own version() can lag it, see protocolVersion). */
  private provedPv = 0;
  /** The contract's document schemas, from the proved read at connect: which gov shape is deployed (see hasDocType/hasProperty). */
  schemas: Record<string, { properties?: Record<string, unknown> }> = {};

  constructor(network: PlatformNetwork, contractId: string) {
    this.network = network;
    this.contractId = contractId;
  }

  /** Read-only connection (proved queries). */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.w = await import('@dashevo/evo-sdk');
    await (this.w as any).ensureInitialized?.();
    const opts = { settings: { timeoutMs: 60_000, retries: 2 } };
    this.sdk = this.network === 'mainnet' ? this.w.EvoSDK.mainnetTrusted(opts) : this.w.EvoSDK.testnetTrusted(opts);
    await this.sdk.connect();
    this.connected = true;
    // the version ratchets up from proven metadata: run one proved read so writes use the network's real version
    const fetched = await this.sdk.contracts.fetchWithProof(this.contractId);
    this.notePv(fetched);
    const contract = fetched?.data;
    if (!contract) throw new Error(`gov contract ${this.contractId} not found on ${this.network}`);
    this.schemas = contract.schemas;
    // the publisher picks the document shapes from these: fail closed on a contract that is not a gov contract
    if (!this.schemas.proposal || !this.schemas.tally) throw new Error(`contract ${this.contractId} has no proposal/tally types: not a gov contract`);
    log.info('platform connected', { network: this.network, protocolVersion: this.protocolVersion, contractId: this.contractId, docTypes: Object.keys(this.schemas) });
  }

  /** Loads the bridge identity and its document-signing key. The key must be AUTHENTICATION / HIGH (gov docs require HIGH). */
  async loadIdentity(key: IdentityKeyFile): Promise<void> {
    await this.connect();
    const identity = await this.sdk.identities.fetch(key.identityId);
    if (!identity) throw new Error(`bridge identity ${key.identityId} not found on ${this.network}`);
    this.identityId = key.identityId;
    this.identityKey = identity.getPublicKeyById(key.keyId);
    if (!this.identityKey) throw new Error(`identity has no key ${key.keyId}`);
    const signer = new this.w.IdentitySigner();
    if (key.wif) signer.addKeyFromWif(key.wif);
    else signer.addKey(this.w.PrivateKey.fromHex(key.privateKeyHex!, this.network));
    this.signer = signer;
  }

  /** Whether the deployed contract has this document type (`talliesSet`: mainnet gov.json, or a testnet contract after its update). */
  hasDocType(type: string): boolean {
    return Object.hasOwn(this.schemas, type);
  }

  /** Whether the deployed type has this property (`proposal.url`: the old, unslimmed testnet shape). */
  hasProperty(type: string, prop: string): boolean {
    return Object.hasOwn(this.schemas[type]?.properties ?? {}, prop);
  }

  /**
   * The network's protocol version: the higher of the SDK's version() and the proved metadata seen so far. Right after connect the SDK can
   * still report its starting version (13) on a PV14 network, and the create id rule differs between them (packages/auth README).
   */
  get protocolVersion(): number {
    return Math.max(this.provedPv, Number(this.sdk.version()) || 0);
  }

  private notePv(r: { metadata?: { protocolVersion?: unknown } } | null | undefined): void {
    this.provedPv = Math.max(this.provedPv, metaPv(r));
  }

  /** A fresh proved read of the protocol version, right before a write that depends on it (the network may have upgraded since). */
  private async provedProtocolVersion(): Promise<number> {
    try {
      this.notePv(await this.sdk.identities.contractNonceWithProof(this.identityId, this.contractId));
    } catch (e) {
      log.warn('protocol version read failed; using the last known one', { error: errText(e) });
    }
    return this.protocolVersion;
  }

  async balance(): Promise<bigint> {
    return BigInt((await this.sdk.identities.balance(this.identityId)) ?? 0n);
  }

  /** Proved query. byteArray `where` values must already be base64 strings. */
  async query(type: string, q: QueryOptions): Promise<PlatformDoc[]> {
    await this.connect();
    // PV13 answers a bad shape with a silent [] (or rc.8 cannot verify it): every bridge query passes the same lint as the web app's
    const lint: DocQuery = { documentTypeName: type, where: (q.where ?? []) as unknown as DocQuery['where'], limit: q.limit ?? 100 };
    if (q.orderBy?.length) lint.orderBy = q.orderBy as unknown as DocQuery['orderBy'];
    if (q.startAfter) lint.startAfter = q.startAfter;
    assertQuery(GOV_LINT_SCHEMAS, lint);
    const req = { dataContractId: this.contractId, documentTypeName: type, where: q.where ?? [], orderBy: q.orderBy ?? [], limit: q.limit ?? 100, ...(q.startAfter ? { startAfter: q.startAfter } : {}) };
    let res: Map<string, any>;
    if (q.prove === false) res = await this.sdk.documents.query(req);
    else {
      const r = await this.sdk.documents.queryWithProof(req);
      this.notePv(r);
      res = r.data;
    }
    const out: PlatformDoc[] = [];
    for (const d of res.values()) if (d) out.push(this.toPlatformDoc(d));
    return out;
  }

  toPlatformDoc(d: any): PlatformDoc {
    const j = d.toJSON(this.sdk.version());
    return { id: d.id.toString(), revision: Number(d.revision ?? j.$revision ?? 1), data: j };
  }

  /** Creates a document. `props` uses bigint for integers and Uint8Array for byte arrays. Returns the id. */
  async create(type: string, props: Record<string, unknown>, requiredSystem: { createdAt?: boolean; updatedAt?: boolean } = {}): Promise<{ id: string }> {
    const pv = await this.provedProtocolVersion();
    const entropy = Uint8Array.from(randomBytes(32));
    const id = pv >= 14 ? new Uint8Array(32) : pv13DocumentId(this.contractId, this.identityId, type, entropy);
    const now = BigInt(Date.now());
    const obj: Record<string, unknown> = {
      $formatVersion: '0',
      $id: id,
      $ownerId: base58ToBytes(this.identityId),
      $dataContractId: base58ToBytes(this.contractId),
      $type: type,
      $revision: 1n,
      $entropy: entropy,
      ...(requiredSystem.createdAt ? { $createdAt: now } : {}),
      ...(requiredSystem.updatedAt ? { $updatedAt: now } : {}),
      ...props,
    };
    const doc = this.w.Document.fromObject(obj as any, this.w.PlatformVersion.latest());
    const created = await this.sdk.documents.create({ document: doc, identityKey: this.identityKey, signer: this.signer });
    return { id: created.id.toString() };
  }

  /** Replaces a document with `revision` (= current + 1). */
  async replace(type: string, id: string, revision: number, props: Record<string, unknown>): Promise<void> {
    const obj: Record<string, unknown> = {
      $formatVersion: '0',
      $id: base58ToBytes(id),
      $ownerId: base58ToBytes(this.identityId),
      $dataContractId: base58ToBytes(this.contractId),
      $type: type,
      $revision: BigInt(revision),
      $updatedAt: BigInt(Date.now()),
      ...props,
    };
    const doc = this.w.Document.fromObject(obj as any, this.w.PlatformVersion.latest());
    await this.sdk.documents.replace({ document: doc, identityKey: this.identityKey, signer: this.signer });
  }

  async refreshNonce(): Promise<void> {
    try {
      await this.sdk.wasm.refreshIdentityNonce(this.w.Identifier.fromBase58(this.identityId));
    } catch (e) {
      log.warn('refreshIdentityNonce failed', { error: errText(e) });
    }
  }

  /** Runs a write with retries for lagging nodes / nonce errors. `beforeRetry` lets the caller re-check whether the write landed. */
  async withRetries<T>(label: string, fn: () => Promise<T>, beforeRetry?: () => Promise<{ value: T } | null>, attempts = 5): Promise<{ value: T; attempts: number }> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return { value: await fn(), attempts: i };
      } catch (e) {
        last = e;
        const msg = errText(e);
        if (/already present in past|nonce .*past/i.test(msg)) await this.refreshNonce();
        if (i === attempts || !RETRIABLE.test(msg)) break;
        log.warn('platform write failed, retrying', { label, attempt: i, error: msg.slice(0, 300) });
        await new Promise((r) => setTimeout(r, 2000 * i));
        if (beforeRetry) {
          const landed = await beforeRetry().catch(() => null);
          if (landed) return { value: landed.value, attempts: i };
        }
      }
    }
    throw new Error(`${label}: ${errText(last)}`);
  }
}

/** Display-order hex hash -> 32 bytes (no reversal: Platform stores RPC/display order, contracts-v1 README "Hash byte order"). */
export const displayHashBytes = (hex: string): Uint8Array => hexToBytes(hex);
export const displayHashB64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');
