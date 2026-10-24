// Central login (PLAN 4.2): the accounts service, a later phase. Only the interface lives here, so the UI and the session code are
// written against it now and a provider plugs in through the endpoint registry later. Contract for implementations:
//  - The server stores opaque, fixed-size envelopes. It never sees a password (OPAQUE, RFC 9807) nor a plaintext key.
//  - An envelope holds the same bytes a vault bundle does (vault/bundle.ts encodeBundle: seed, key or MN voting keys, padded to
//    BUNDLE_LENGTH), encrypted with AES-256-GCM under a key from a passkey PRF and/or the OPAQUE export key.
//  - Password-wrapped envelopes never go on Platform (PLAN 4.2).
import type { Network } from './keys.ts';

export interface CentralLoginEndpoint {
  name: string;
  /** https base URL of an accounts service (registry entry `accounts`). */
  url: string;
}

export interface CentralEnvelope {
  /** Opaque ciphertext, fixed size. */
  ciphertext: Uint8Array;
  /** How the envelope key is derived: from a passkey PRF, from the OPAQUE export key, or both (either opens it). */
  wraps: Array<{ kind: 'passkey-prf'; credentialId: Uint8Array } | { kind: 'opaque' }>;
  version: number;
}

export interface CentralLoginProvider {
  readonly endpoint: CentralLoginEndpoint;
  readonly network: Network;
  /** OPAQUE registration (client messages only; the password never leaves the browser). Returns the export key for wrapping. */
  register(username: string, password: string): Promise<{ exportKey: Uint8Array }>;
  /** OPAQUE login; returns a session token for the service and the export key. */
  login(username: string, password: string): Promise<{ token: string; exportKey: Uint8Array }>;
  /** Passkey login against the service (WebAuthn assertion verified server-side). */
  loginWithPasskey(): Promise<{ token: string; credentialId: Uint8Array; prfOutput: Uint8Array }>;
  getEnvelope(token: string): Promise<CentralEnvelope | null>;
  putEnvelope(token: string, envelope: CentralEnvelope): Promise<void>;
  /** Optional second factor. */
  totp?: { enroll(token: string): Promise<{ otpauthUri: string }>; verify(token: string, code: string): Promise<boolean> };
  logout(token: string): Promise<void>;
}

export class CentralLoginUnavailable extends Error {
  constructor() {
    super('Central login (the accounts service) is not available yet.');
    this.name = 'CentralLoginUnavailable';
  }
}

/** Resolves a provider for a configured endpoint. No implementation ships in this phase, so this always reports unavailable. */
export function centralLoginFor(endpoint: CentralLoginEndpoint | null): CentralLoginProvider | null {
  if (!endpoint) return null;
  throw new CentralLoginUnavailable();
}
