// Fixture mode's stand-in for a wallet and for Platform: it answers a sign-in request the way a wallet does (a new key bound to the
// forum contract, sealed to the request) and serves that key back as the identity's, so the real verifier and the real views run
// with no network. Nothing here reaches Platform or holds a real identity's key.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, identifierBytes, KeyPurpose, KeyType, SecurityLevel, toBase58, wipe } from '@govhub/auth';
import { compareIds, LOGIN_BUDGET_CREDITS, LOGIN_LIFETIME_MS, requestHash, sealPayload, type AppConnectPort, type Candidate, type ChainKey, type ConnectRequest } from '@govhub/auth/appconnect';

export interface DemoWallet {
  port: AppConnectPort;
  /** Answers `request` as `identityId` with a key that verifies. */
  approve(request: ConnectRequest, identityId: string): void;
  /** Answers `request` as `identityId` with a key bound to another contract, which the verifier refuses. */
  answerBadly(request: ConnectRequest, identityId: string): void;
}

export function demoWallet(): DemoWallet {
  const answers = new Map<string, Candidate[]>();
  const keys = new Map<string, ChainKey[]>();
  const answer = (request: ConnectRequest, identityId: string, contractId: string) => {
    const b = request.authBindings[0]!;
    const priv = secp256k1.utils.randomSecretKey();
    const list = keys.get(identityId) ?? [];
    list.push({
      id: list.length + 1,
      type: KeyType.ECDSA_SECP256K1,
      purpose: KeyPurpose.AUTHENTICATION,
      securityLevel: SecurityLevel.HIGH,
      data: secp256k1.getPublicKey(priv, true),
      disabled: false,
      bounds: { kind: 'singleContract', contractId },
      totalBudget: b.totalBudget ?? LOGIN_BUDGET_CREDITS,
      expiresAt: b.expiresAt ?? Date.now() + LOGIN_LIFETIME_MS,
    });
    keys.set(identityId, list);
    const sealed = sealPayload({ appEphemeralPubKey: request.appEphemeralPubKey, ownerId: identifierBytes(identityId), slots: [priv] });
    wipe(priv);
    const h = bytesToHex(requestHash(request));
    answers.set(h, [...(answers.get(h) ?? []).filter((c) => c.ownerId !== identityId), { ownerId: identityId, ...sealed }]);
  };
  return {
    port: {
      async responses(hash, o) {
        const all = answers.get(bytesToHex(hash)) ?? [];
        const after = all.filter((c) => (o.hint ? c.ownerId === o.hint : !o.startAfter || compareIds(c.ownerId, o.startAfter) > 0));
        return after.sort((a, b) => compareIds(a.ownerId, b.ownerId)).slice(0, o.limit);
      },
      async identityKeys(id) {
        const k = keys.get(id);
        return k ? { keys: k, blockTimeMs: Date.now() } : null;
      },
      async remainingBudgets(id, keyIds) {
        const k = keys.get(id) ?? [];
        return new Map(k.filter((x) => keyIds.includes(x.id) && x.totalBudget !== undefined).map((x) => [x.id, x.totalBudget!]));
      },
      async contractKeys() {
        return [];
      },
    },
    approve: (request, identityId) => answer(request, identityId, toBase58(request.authBindings[0]!.id)),
    // the all-zero id stands in for "some other contract"
    answerBadly: (request, identityId) => answer(request, identityId, '11111111111111111111111111111111'),
  };
}
