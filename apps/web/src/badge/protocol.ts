// Messages between the page and the badge worker (worker.ts). Byte fields are base64 strings.
import type { DapiConfig } from '../data/dapi.ts';
export type BadgeWorkerRequest =
  | { id: number; kind: 'blind'; spki: string; preparedMsg: string }
  | { id: number; kind: 'challenge'; url: string }
  | { id: number; kind: 'token'; url: string; request: string; signature: string; blindedMsg: string }
  | { id: number; kind: 'finalize'; spki: string; preparedMsg: string; blindSig: string; inv: string }
  /** The masternode count of the proven list (anchored chain, SML checked against the CbTx merkleRootMNList). */
  | { id: number; kind: 'provenMasternodes'; dapi: DapiConfig };

export type IssuerAnswer = { ok: true; blindSig: string } | { ok: false; status: number; error: string; message: string; issuingEpoch?: number };

export type BadgeWorkerResponse =
  | { id: number; kind: 'blind'; blindedMsg: string; inv: string }
  | { id: number; kind: 'challenge'; nonce: string }
  | { id: number; kind: 'token'; answer: IssuerAnswer }
  | { id: number; kind: 'finalize'; sig: string }
  | { id: number; kind: 'provenMasternodes'; count: number; height: number; weak: string | null }
  | { id: number; kind: 'error'; message: string };

/** A request without its id (distributes over the union). */
export type BadgeWorkerCall = BadgeWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
