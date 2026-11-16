// The app's Session (session.ts) for a real sign-in from @govhub/auth: seed, pasted key, passkey or a Dash wallet (App Connect). Documents are written by the one
// document writer in @govhub/auth (`PlatformPort.writeDocument`, evo.ts), signed with the session's HIGH (else CRITICAL) key, which
// stays in the auth session's memory. close() ends the auth session (wipes the key and the seed).
import { assertLive, KeyType, type PlatformPort, type Session as AuthSession } from '@govhub/auth';
import type { Session } from './session.ts';

const HOW = { seed: 'recovery phrase', key: 'pasted key', passkey: 'passkey', wallet: 'Dash wallet' } as const;
const LEVEL = ['MASTER', 'CRITICAL', 'HIGH', 'MEDIUM'];

export interface AppAuthSession extends Session {
  /** The underlying auth session (top-ups, passkeys). */
  readonly auth: AuthSession;
}

export function appSessionFromAuth(auth: AuthSession, platform: () => Promise<PlatformPort>): AppAuthSession {
  return {
    auth,
    identityId: auth.identityId,
    label: `${HOW[auth.source]}, key ${auth.keyId} (${LEVEL[auth.securityLevel] ?? auth.securityLevel})`,
    async balance() {
      return (await (await platform()).balance(auth.identityId)) ?? 0n;
    },
    async signAndBroadcastDocument(op) {
      assertLive(auth);
      // a wallet key is bound to one contract: a write elsewhere would be refused by Platform and still cost fees from its budget
      if (auth.source === 'wallet' && op.contractId !== auth.boundContractId) throw new Error('Your wallet sign-in can only write govhub comments, reactions and posts. Sign in with a recovery phrase for this.');
      const port = await platform();
      return port.writeDocument({
        ownerId: auth.identityId,
        key: { id: auth.keyId, purpose: 0, securityLevel: auth.securityLevel, type: KeyType.ECDSA_SECP256K1, privateKey: auth.privateKey },
        op,
      });
    },
    close() {
      auth.end();
    },
  };
}
