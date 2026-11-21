// Verification of one `loginKeyResponse` candidate (DIP pasta-app-connect, "App Processing of connect"). Every rule there is
// checked against proved reads; anything else rejects the whole candidate. A verified grant is still not a sign-in: without an
// IDENTITY_HINT the user must confirm the identity first, because anyone who sees a request can answer it.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesEqual, hash160, identifierBytes, toBase58, wipe } from '../bytes.ts';
import { KeyPurpose, KeyType, SecurityLevel } from '../keys.ts';
import type { AuthBinding, ConnectRequest } from './codec.ts';
import { openPayload, PayloadError } from './envelope.ts';
import type { AppConnectPort, Bounds, Candidate, ChainKey } from './port.ts';

/** A granted key must stay valid this long past the latest block time. */
export const EXPIRY_MARGIN_MS = 60 * 60_000;

export type RejectReason =
  | 'hint-mismatch'
  | 'framing'
  | 'decrypt'
  | 'invalid-key'
  | 'identity-not-found'
  | 'key-not-found'
  | 'key-disabled'
  | 'key-master'
  | 'key-purpose'
  | 'key-type'
  | 'key-unbound'
  | 'key-unmatched'
  | 'key-level'
  | 'key-limits'
  | 'key-expired'
  | 'budget-exhausted'
  | 'budget-unknown'
  | 'encryption-key-not-current'
  | 'duplicate-binding'
  | 'primary-missing';

/** Reasons a lagging node can cause: the wallet's update may not have reached the node this app reads from yet. */
const RETRYABLE: ReadonlySet<RejectReason> = new Set(['identity-not-found', 'key-not-found', 'budget-unknown', 'encryption-key-not-current']);

export interface GrantedKey {
  /** 'auth' for a session key, else the encryption purpose. */
  role: 'auth' | 'encryption' | 'decryption';
  bindingIndex: number;
  privateKey: Uint8Array;
  key: ChainKey;
  remainingBudget?: bigint;
}

export interface Grant {
  identityId: string;
  authKeys: GrantedKey[];
  encryptionKeys: GrantedKey[];
}

export type Verification = { ok: true; grant: Grant } | { ok: false; reason: RejectReason; retryable: boolean };

class Reject {
  constructor(readonly reason: RejectReason) {}
}
const no = (reason: RejectReason): never => {
  throw new Reject(reason);
};

export function boundsOfBinding(b: AuthBinding): Bounds {
  const id = toBase58(b.id);
  if (b.kind === 'documentType') return { kind: 'documentType', contractId: id, documentTypeName: b.documentTypeName! };
  if (b.kind === 'contractGroup') return { kind: 'contractGroup', groupId: id };
  return { kind: 'singleContract', contractId: id };
}

export function sameBounds(a: Bounds, b: Bounds): boolean {
  if (a.kind === 'singleContract') return b.kind === 'singleContract' && a.contractId === b.contractId;
  if (a.kind === 'documentType') return b.kind === 'documentType' && a.contractId === b.contractId && a.documentTypeName === b.documentTypeName;
  return b.kind === 'contractGroup' && a.groupId === b.groupId;
}

export async function verifyCandidate(o: { request: ConnectRequest; appEphemeralPrivateKey: Uint8Array; candidate: Candidate; port: AppConnectPort; marginMs?: number }): Promise<Verification> {
  const { request, candidate, port } = o;
  let slots: Uint8Array[] = [];
  try {
    if (request.identityHint && candidate.ownerId !== toBase58(request.identityHint)) no('hint-mismatch');
    let owner: Uint8Array;
    try {
      owner = identifierBytes(candidate.ownerId);
    } catch {
      return no('identity-not-found');
    }
    try {
      slots = openPayload({
        appEphemeralPrivateKey: o.appEphemeralPrivateKey,
        ownerId: owner,
        walletEphemeralPubKey: candidate.walletEphemeralPubKey,
        encryptedPayload: candidate.encryptedPayload,
        maxSlots: request.authBindings.length + request.encBindings.length,
      });
    } catch (e) {
      return no(e instanceof PayloadError ? e.code : 'decrypt');
    }
    const grant = await verifySlots(request, candidate.ownerId, slots, port, o.marginMs ?? EXPIRY_MARGIN_MS);
    return { ok: true, grant };
  } catch (e) {
    wipe(...slots);
    if (e instanceof Reject) return { ok: false, reason: e.reason, retryable: RETRYABLE.has(e.reason) };
    throw e;
  }
}

async function verifySlots(request: ConnectRequest, ownerId: string, slots: Uint8Array[], port: AppConnectPort, margin: number): Promise<Grant> {
  const identity = await port.identityKeys(ownerId);
  if (!identity) return no('identity-not-found');
  const latest = identity.blockTimeMs;

  const granted: GrantedKey[] = [];
  for (const privateKey of slots) {
    let pub: Uint8Array;
    try {
      pub = secp256k1.getPublicKey(privateKey, true);
    } catch {
      return no('invalid-key');
    }
    const h = hash160(pub);
    const found = identity.keys.filter((k) => (k.type === KeyType.ECDSA_SECP256K1 && bytesEqual(k.data, pub)) || (k.type === KeyType.ECDSA_HASH160 && bytesEqual(k.data, h)));
    if (found.length !== 1) no(found.length ? 'duplicate-binding' : 'key-not-found');
    const key = found[0]!;
    if (key.disabled) no('key-disabled');
    if (key.securityLevel === SecurityLevel.MASTER) no('key-master');
    if (key.bounds === undefined) no('key-unbound');
    if (key.bounds === 'unreadable') no('key-unmatched');
    const bounds = key.bounds as Bounds;

    let g: GrantedKey;
    if (key.purpose === KeyPurpose.AUTHENTICATION) {
      const i = request.authBindings.findIndex((b) => sameBounds(boundsOfBinding(b), bounds));
      if (i < 0) no('key-unmatched');
      const b = request.authBindings[i]!;
      if (key.type !== KeyType.ECDSA_SECP256K1 && key.type !== KeyType.ECDSA_HASH160) no('key-type');
      if (key.securityLevel !== b.securityLevel) no('key-level');
      // The wallet may change the values but must set both, and never drop a limit the binding asked for.
      if (key.totalBudget === undefined || key.totalBudget <= 0n || key.expiresAt === undefined) no('key-limits');
      g = { role: 'auth', bindingIndex: i, privateKey, key };
    } else if (key.purpose === KeyPurpose.ENCRYPTION || key.purpose === KeyPurpose.DECRYPTION) {
      const i = request.encBindings.findIndex((e) => e.purpose === key.purpose && bounds.kind === 'singleContract' && bounds.contractId === toBase58(e.contractId));
      if (i < 0) no('key-unmatched');
      if (key.securityLevel !== SecurityLevel.MEDIUM) no('key-level');
      if (key.type !== KeyType.ECDSA_SECP256K1) no('key-type');
      g = { role: key.purpose === KeyPurpose.ENCRYPTION ? 'encryption' : 'decryption', bindingIndex: i, privateKey, key };
    } else return no('key-purpose');

    if (key.expiresAt !== undefined && key.expiresAt - latest <= margin) no('key-expired');
    if (granted.some((x) => x.key.id === key.id || (x.role === g.role && x.bindingIndex === g.bindingIndex))) no('duplicate-binding');
    granted.push(g);
  }

  if (!granted.some((g) => g.role === 'auth' && g.bindingIndex === 0)) no('primary-missing');

  for (const g of granted.filter((x) => x.role !== 'auth')) {
    const e = request.encBindings[g.bindingIndex]!;
    const current = await port.contractKeys(ownerId, toBase58(e.contractId), e.purpose);
    if (!current.some((k) => k.id === g.key.id && bytesEqual(k.data, g.key.data) && !k.disabled)) no('encryption-key-not-current');
  }

  const budgeted = granted.filter((g) => g.key.totalBudget !== undefined);
  if (budgeted.length) {
    const left = await port.remainingBudgets(ownerId, budgeted.map((g) => g.key.id));
    for (const g of budgeted) {
      const r = left.get(g.key.id);
      if (r === undefined) no('budget-unknown');
      if (r! <= 0n) no('budget-exhausted');
      g.remainingBudget = r;
    }
  }

  return { identityId: ownerId, authKeys: granted.filter((g) => g.role === 'auth'), encryptionKeys: granted.filter((g) => g.role !== 'auth') };
}
