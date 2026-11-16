// govhub's App Connect request and the session a verified grant becomes. The request asks for one key: AUTHENTICATION, HIGH, bound
// to the profile's forum contract (which is also the app id), with a proposed budget and expiry. No CRITICAL, no encryption keys.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { identifierBytes, randomBytes, wipe } from '../bytes.ts';
import { SecurityLevel, type Network } from '../keys.ts';
import { makeSession, type Session } from '../signin.ts';
import { buildConnectUri, type ConnectRequest } from './codec.ts';
import type { Grant } from './verify.ts';

export const LOGIN_LABEL = 'govhub';
/** 0.1 DASH (1 DASH = 1e11 credits): the smallest of the wallets' budget presets, hundreds of comments. */
export const LOGIN_BUDGET_CREDITS = 10_000_000_000n;
/** 90 days: the wallets' default lifetime preset. */
export const LOGIN_LIFETIME_MS = 90 * 24 * 60 * 60_000;

export interface LoginRequest {
  request: ConnectRequest;
  /** The request's ephemeral private key: in memory only, wiped by `end()`. */
  appEphemeralPrivateKey: Uint8Array;
  uri: string;
  end(): void;
}

/**
 * A fresh login request. `connectionId` is 16 random bytes kept per browser and network (it lets the wallet retire the previous
 * grant's keys); `contractId` is the forum contract, the app id and the key's only bound.
 */
export function makeLoginRequest(o: { contractId: string; network: Network; connectionId: Uint8Array; now: number; identityHint?: string; callbackUrl?: string }): LoginRequest {
  const appEphemeralPrivateKey = secp256k1.utils.randomSecretKey();
  const contract = identifierBytes(o.contractId);
  const request: ConnectRequest = {
    appEphemeralPubKey: secp256k1.getPublicKey(appEphemeralPrivateKey, true),
    appId: contract,
    label: LOGIN_LABEL,
    authBindings: [{ kind: 'singleContract', securityLevel: SecurityLevel.HIGH, id: contract, totalBudget: LOGIN_BUDGET_CREDITS, expiresAt: o.now + LOGIN_LIFETIME_MS }],
    encBindings: [],
    createdAt: o.now,
    connectionId: o.connectionId,
    ...(o.identityHint ? { identityHint: identifierBytes(o.identityHint) } : {}),
  };
  return { request, appEphemeralPrivateKey, uri: buildConnectUri(request, o.network, o.callbackUrl), end: () => wipe(appEphemeralPrivateKey) };
}

export const newConnectionId = (): Uint8Array => randomBytes(16);

/** The session for a verified grant: it signs with the primary binding's key, which can only write to `boundContractId`. */
export function sessionFromGrant(grant: Grant, network: Network): Session {
  const primary = grant.authKeys.find((k) => k.bindingIndex === 0);
  if (!primary) throw new Error('the grant has no primary key');
  wipeGrant(grant, primary.privateKey);
  const b = primary.key.bounds;
  return makeSession({
    network,
    identityId: grant.identityId,
    identityIndex: null,
    keyId: primary.key.id,
    securityLevel: primary.key.securityLevel,
    source: 'wallet',
    privateKey: primary.privateKey,
    wallet: null,
    boundContractId: typeof b === 'object' && b.kind === 'singleContract' ? b.contractId : undefined,
  });
}

/** Wipes a grant's private keys, except `keep`. */
export const wipeGrant = (g: Grant, keep?: Uint8Array): void => wipe(...[...g.authKeys, ...g.encryptionKeys].map((k) => k.privateKey).filter((k) => k !== keep));
