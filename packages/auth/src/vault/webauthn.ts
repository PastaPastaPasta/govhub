// WebAuthn with the PRF extension, browser only. The passkey never signs anything for govhub: it is used only for its PRF output,
// from which the vault's HPKE recipient key is derived (bundle.ts). So the challenge is random and nothing is sent to a server.
// The user handle is identityId || vaultContractId (64 bytes, WebAuthn's maximum): a discoverable sign-in learns which identity and
// which vault the passkey belongs to, and two deployments (testnet / mainnet contracts) never share a handle.
import { concatBytes, identifierBytes, randomBytes, toBase58 } from '../bytes.ts';

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'no-prf' | 'cancelled' | 'other-vault' | 'failed',
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

const NO_PRF =
  "This passkey can't keep your key: its provider doesn't support the PRF extension. Try a passkey saved to iCloud Keychain, Google Password Manager or a recent security key, or keep signing in with your recovery phrase.";

export const userHandleFor = (identityId: string, contractId: string): Uint8Array => concatBytes(identifierBytes(identityId), identifierBytes(contractId));

export function parseUserHandle(handle: Uint8Array | null, contractId: string): { identityId: string } {
  if (!handle || handle.length !== 64) throw new PasskeyError("This passkey isn't a govhub passkey.", 'other-vault');
  if (toBase58(handle.slice(32)) !== contractId) throw new PasskeyError("This passkey isn't set up for govhub on this network.", 'other-vault');
  return { identityId: toBase58(handle.slice(0, 32)) };
}

/** What the browser says about PRF before trying. 'unknown' when it does not say (the actual output decides). */
export async function prfSupport(): Promise<'yes' | 'no' | 'unknown'> {
  const PKC = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } }).PublicKeyCredential;
  if (!PKC || !globalThis.navigator?.credentials) return 'no';
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps && 'extension:prf' in caps) return caps['extension:prf'] ? 'yes' : 'no';
  } catch {
    /* older browsers */
  }
  return 'unknown';
}

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const bytesOf = (b: ArrayBuffer | ArrayBufferView | undefined | null): Uint8Array | null =>
  !b ? null : b instanceof ArrayBuffer ? new Uint8Array(b.slice(0)) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };

function mapError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('The passkey prompt was closed.', 'cancelled');
  if (name === 'NotSupportedError' || name === 'SecurityError') return new PasskeyError('Passkeys are not available here.', 'unsupported');
  return new PasskeyError('The passkey request failed.', 'failed');
}

export interface CreatedPasskey {
  credentialId: Uint8Array;
  /** PRF output at creation, when the authenticator gives one then (many only give it on get). */
  prfOutput: Uint8Array | null;
  prfEnabled: boolean;
}

export async function createPasskey(o: { rpId: string; rpName: string; userHandle: Uint8Array; userName: string; prfInput: Uint8Array; exclude?: Uint8Array[]; signal?: AbortSignal }): Promise<CreatedPasskey> {
  if (!globalThis.navigator?.credentials?.create) throw new PasskeyError('Passkeys are not available in this browser.', 'unsupported');
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: buf(randomBytes(32)),
        rp: { id: o.rpId, name: o.rpName },
        user: { id: buf(o.userHandle), name: o.userName, displayName: o.userName },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: (o.exclude ?? []).map((id) => ({ type: 'public-key' as const, id: buf(id) })),
        extensions: { prf: { eval: { first: buf(o.prfInput) } } } as AuthenticationExtensionsClientInputs,
      },
      signal: o.signal,
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw mapError(e);
  }
  if (!cred) throw new PasskeyError('No passkey was created.', 'cancelled');
  const ext = cred.getClientExtensionResults() as PrfResults;
  return { credentialId: new Uint8Array(cred.rawId), prfOutput: bytesOf(ext.prf?.results?.first), prfEnabled: ext.prf?.enabled === true || !!ext.prf?.results?.first };
}

export interface PasskeyAssertion {
  credentialId: Uint8Array;
  userHandle: Uint8Array | null;
  prfOutput: Uint8Array;
}

/** One assertion with the PRF evaluated. `allow` restricts it to known credentials (empty = discoverable sign-in). */
export async function getPasskeyPrf(o: { rpId: string; prfInput: Uint8Array; allow?: Uint8Array[]; signal?: AbortSignal }): Promise<PasskeyAssertion> {
  if (!globalThis.navigator?.credentials?.get) throw new PasskeyError('Passkeys are not available in this browser.', 'unsupported');
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: buf(randomBytes(32)),
        rpId: o.rpId,
        userVerification: 'required',
        allowCredentials: (o.allow ?? []).map((id) => ({ type: 'public-key' as const, id: buf(id) })),
        extensions: { prf: { eval: { first: buf(o.prfInput) } } } as AuthenticationExtensionsClientInputs,
      },
      signal: o.signal,
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw mapError(e);
  }
  if (!cred) throw new PasskeyError('No passkey was chosen.', 'cancelled');
  const prf = bytesOf((cred.getClientExtensionResults() as PrfResults).prf?.results?.first);
  if (!prf || prf.length !== 32) throw new PasskeyError(NO_PRF, 'no-prf');
  const resp = cred.response as AuthenticatorAssertionResponse;
  return { credentialId: new Uint8Array(cred.rawId), userHandle: bytesOf(resp.userHandle), prfOutput: prf };
}

/** Tells the provider a passkey is useless (made but never stored in a vault entry), where the browser supports it. */
export async function forgetPasskey(rpId: string, credentialId: Uint8Array): Promise<void> {
  const PKC = (globalThis as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } }).PublicKeyCredential;
  if (!PKC?.signalUnknownCredential) return;
  let s = '';
  for (const x of credentialId) s += String.fromCharCode(x);
  try {
    await PKC.signalUnknownCredential({ rpId, credentialId: btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') });
  } catch {
    /* best effort */
  }
}

export const PRF_UNAVAILABLE_MESSAGE = NO_PRF;
