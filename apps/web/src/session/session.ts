// The signed-in identity, as the social features need it. This is deliberately the whole contract between the
// forum UI and whatever signs: real sign-ins (seed, pasted key, passkey; central login later) from @govhub/auth through
// authSession.ts, and the fixture-mode sample identities through fixture.ts.
import type { DocumentOp, DocumentResult } from '@govhub/forum';

export type { DocumentOp, DocumentResult };

export interface Session {
  /** The identity documents are written as (base58). */
  readonly identityId: string;
  /** Short human label of how this session signs ("recovery phrase, key 2 (HIGH)", "fixture identity", ...), shown next to the identity. */
  readonly label: string;
  /** Current credit balance (1 DASH = 1e11 credits), read fresh from Platform on every call. */
  balance(): Promise<bigint>;
  /**
   * Signs one document transition (create, replace or delete; see DocumentOp in @govhub/forum for the value
   * encodings) with a key the identity may use for documents, broadcasts it, and resolves once Platform accepted it.
   * Rejects with an Error whose message is fit to show the user.
   */
  signAndBroadcastDocument(op: DocumentOp): Promise<DocumentResult>;
  /** Forget the keys. Called on sign-out. */
  close(): void;
}
