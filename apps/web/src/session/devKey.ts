// DEVELOPMENT ONLY: sign in by pasting an identity id and the private key of one of its document keys. The key is
// held in this tab's memory (never stored) and only enabled in dev builds or builds made with
// VITE_GOVHUB_DEV_SIGNIN=1. The real sign-in (@govhub/auth) replaces this adapter.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, decodeWif, encodeWif, hash160, hexToBytes } from '@govhub/verify';
import { idToBytes, isIdentifier, pv13DocumentId, type DocumentOp, type DocumentResult } from '@govhub/forum';
import type { Registry } from '../config/registry.ts';
import { getSdk } from '../data/platform.ts';
import type { Session } from './session.ts';

export const DEV_SIGNIN_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_GOVHUB_DEV_SIGNIN === '1';

/** Identity key purposes and levels (rs-dpp): documents need an AUTHENTICATION key at CRITICAL (1) or HIGH (2). */
const AUTHENTICATION = 0;
const DOCUMENT_LEVELS = new Set([1, 2]);

/** WIF, or 64 hex characters, for the Platform network in use -> WIF + the compressed public key's hash160. */
export function parseSecret(secret: string, network: 'mainnet' | 'testnet'): { wif: string; keyHash: string } {
  const s = secret.trim();
  let priv: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) priv = hexToBytes(s);
  else {
    try {
      priv = decodeWif(s, network).privKey;
    } catch {
      throw new Error(`not a ${network} WIF or 64-character hex private key`);
    }
  }
  if (!secp256k1.utils.isValidSecretKey(priv)) throw new Error('not a valid secp256k1 private key');
  return { wif: encodeWif(priv, true, network), keyHash: bytesToHex(hash160(secp256k1.getPublicKey(priv, true))) };
}

/** Lagging nodes: a write right after another can fail with "document not found" or a stale nonce (spikes/sdk5 §5.3). */
const RETRYABLE = /40101|document not found|nonce/i;

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

const toSdk = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));

export async function devKeySession(registry: Registry, identityId: string, secret: string): Promise<Session> {
  if (!DEV_SIGNIN_ENABLED) throw new Error('dev sign-in is disabled in this build');
  if (!isIdentifier(identityId)) throw new Error('identity id must be a base58 identifier');
  const { wif, keyHash } = parseSecret(secret, registry.platformNetwork);
  const sdk = await getSdk(registry);
  const evo = await import('@dashevo/evo-sdk');
  const identity = await sdk.identities.fetch(identityId);
  if (!identity) throw new Error('identity not found on Platform');
  const found = identity.publicKeys.find(
    (k) => k.getPublicKeyHash().toLowerCase() === keyHash && k.purposeNumber === AUTHENTICATION && DOCUMENT_LEVELS.has(k.securityLevelNumber) && k.disabledAt === undefined,
  );
  if (!found) throw new Error('that key is not an enabled HIGH or CRITICAL authentication key of this identity');
  const key = found;
  let signer: InstanceType<typeof evo.IdentitySigner> | null = new evo.IdentitySigner();
  signer.addKeyFromWif(wif);
  const live = () => {
    if (!signer) throw new Error('signed out');
    return signer;
  };

  /**
   * Builds the transition's document once, so a retry re-sends the same document. A PV14 create is never retried:
   * its id comes from the nonce at broadcast, so a retry after a write that landed would create a second document.
   */
  function prepare(op: DocumentOp): (() => Promise<DocumentResult>) & { noRetry?: boolean } {
    const owner = idToBytes(identityId);
    const contract = idToBytes(op.contractId);
    if (op.action === 'delete') {
      return async () => {
        await sdk.documents.delete({ document: { id: op.id, ownerId: identityId, dataContractId: op.contractId, documentTypeName: op.type }, identityKey: key, signer: live() });
        return { id: op.id };
      };
    }
    if (op.action === 'replace') {
      const document = evo.Document.fromObject(
        { $formatVersion: '0', $id: idToBytes(op.id), $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: BigInt(op.revision + 1), ...toSdk(op.data) } as never,
        evo.PlatformVersion.latest(),
      );
      return async () => {
        await sdk.documents.replace({ document, identityKey: key, signer: live() });
        return { id: op.id, revision: op.revision + 1 };
      };
    }
    // Create. PV13 checks $id against sha256d(contract, owner, type, entropy) and has no generateId; PV14 derives the
    // id from the identity contract nonce when $id is zero (spikes/sdk5 README §8).
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    const id = sdk.version() <= 13 ? idToBytes(pv13DocumentId(op.contractId, identityId, op.type, entropy)) : new Uint8Array(32);
    const document = evo.Document.fromObject(
      { $formatVersion: '0', $id: id, $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: 1n, $entropy: entropy, ...toSdk(op.data) } as never,
      evo.PlatformVersion.latest(),
    );
    const run = async () => {
      const created = await sdk.documents.create({ document, identityKey: key, signer: live() });
      return { id: created.id.toString(), revision: 1 };
    };
    if (sdk.version() > 13) return Object.assign(run, { noRetry: true });
    // PV13: a retry re-sends the same id. If the first attempt did land, "already exists" means success.
    const pv13Id = pv13DocumentId(op.contractId, identityId, op.type, entropy);
    return Object.assign(
      async () => {
        try {
          return await run();
        } catch (e) {
          if (/already exists|duplicate/i.test(errText(e))) return { id: pv13Id, revision: 1 };
          throw e;
        }
      },
      { noRetry: false },
    );
  }

  return {
    identityId,
    label: `dev key ${key.keyId} (${key.securityLevel.toLowerCase()})`,
    async balance() {
      return (await sdk.identities.balance(identityId)) ?? 0n;
    },
    async signAndBroadcastDocument(op) {
      const run = prepare(op);
      for (let attempt = 0; ; attempt++) {
        try {
          return await run();
        } catch (e) {
          const msg = errText(e);
          // Retried only on errors a lagging node raises before executing (stale nonce, a just-created document not
          // found yet by the node a replace/delete went to).
          if (!run.noRetry && attempt < 3 && RETRYABLE.test(msg)) {
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          throw new Error(msg);
        }
      }
    },
    close() {
      signer?.free();
      signer = null;
    },
  };
}
