// Messages between the page and the badge worker (worker.ts). Byte fields are base64 strings.
import type { DapiConfig } from '../data/dapi.ts';

/** Which issuer API a challenge / token call targets: MN badges (`v1/...`, the default) or starter tokens (`v1/starter/...`). */
export type IssuerApi = 'badge' | 'starter';

/** The faucet's POST /api/starter body (starter-spec "Faucet API"). */
export interface StarterRedeemBody {
  network: 'mainnet' | 'testnet';
  epoch: number;
  /** P2PKH address of the token's pubKeyHash */
  address: string;
  /** base64, 32 bytes */
  msgPrefix: string;
  /** base64 */
  sig: string;
}

export type BadgeWorkerRequest =
  | { id: number; kind: 'blind'; spki: string; preparedMsg: string }
  | { id: number; kind: 'challenge'; url: string; api?: IssuerApi }
  | { id: number; kind: 'token'; url: string; request: string; signature: string; blindedMsg: string; api?: IssuerApi }
  | { id: number; kind: 'finalize'; spki: string; preparedMsg: string; blindSig: string; inv: string }
  /** The masternode count of the proven list (anchored chain, SML checked against the CbTx merkleRootMNList). */
  | { id: number; kind: 'provenMasternodes'; dapi: DapiConfig }
  /** POST the faucet's /api/starter (`url` is the faucet's base URL). */
  | { id: number; kind: 'starterRedeem'; url: string; body: StarterRedeemBody };

export type IssuerAnswer = { ok: true; blindSig: string } | { ok: false; status: number; error: string; message: string; issuingEpoch?: number };

export type FaucetAnswer =
  | { ok: true; txid: string; amountSats: number; address: string; replay: boolean }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number };

export type BadgeWorkerResponse =
  | { id: number; kind: 'blind'; blindedMsg: string; inv: string }
  /** `expiresAt`: unix seconds, when the issuer says (the starter API does) */
  | { id: number; kind: 'challenge'; nonce: string; expiresAt?: number }
  | { id: number; kind: 'token'; answer: IssuerAnswer }
  | { id: number; kind: 'finalize'; sig: string }
  | { id: number; kind: 'provenMasternodes'; count: number; height: number; weak: string | null }
  | { id: number; kind: 'starterRedeem'; answer: FaucetAnswer }
  | { id: number; kind: 'error'; message: string };

/** A request without its id (distributes over the union). */
export type BadgeWorkerCall = BadgeWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
