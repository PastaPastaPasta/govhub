// Token issuance (PLAN §8.4). One request = one MN, authenticated by a Dash signmessage signature from the MN's VOTING key over
// the canonical token request. Order of checks:
//   1. shape: request string, 65-byte signature, blinded message (no MN state is touched)
//   2. request fields: network, issuer, epoch = the one being issued (S(E-1) <= tip < S(E)), keyId = this epoch's key, a valid
//      unexpired challenge, SHA256(blindedMsg) bound, blinded message of modulus length and 1 < m < n
//   3. authentication: the recovered key's hash160 equals keyIDVoting of the proTxHash in the CURRENT list. Every failure here is
//      the same "unauthorized" answer, so the endpoint does not tell a stranger anything about an MN.
//   4. eligibility (only the key holder sees these answers): valid now; in the list and valid at S(E-1) with the same collateral
//   5. atomic dedup on (proTxHash, epoch) and (collateral, epoch); a retry with the same SHA256(blindedMsg) gets the same signature
//   6. OpenSSL raw RSA signature, verified before it is returned
import { base64ToBytes, buildTokenRequest, equalBytes, idToBytes, issuanceWindow, issuingEpochAt, parseTokenRequest, sha256, toHex, type BadgeNetwork, type EpochParams, type TokenRequest } from '@govhub/badge';
import { recoverMessageSigner } from '@govhub/verify';
import type { Challenges } from './challenge.ts';
import type { CoreView } from './core.ts';
import type { TokenStore } from './db.ts';
import { SignerError, type BlindSigner } from './signer.ts';

export type IssueErrorCode =
  | 'bad-request'
  | 'wrong-network'
  | 'wrong-issuer'
  | 'wrong-epoch'
  | 'wrong-key'
  | 'bad-challenge'
  | 'unauthorized'
  | 'not-eligible'
  | 'already-issued'
  | 'unavailable';

const STATUS: Record<IssueErrorCode, number> = {
  'bad-request': 400,
  'wrong-network': 400,
  'wrong-issuer': 400,
  'wrong-epoch': 409,
  'wrong-key': 409,
  'bad-challenge': 401,
  unauthorized: 403,
  'not-eligible': 403,
  'already-issued': 409,
  unavailable: 503,
};

export class IssueError extends Error {
  readonly code: IssueErrorCode;
  readonly status: number;
  constructor(code: IssueErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.name = 'IssueError';
  }
}

/** The key the server may sign with right now: for the epoch being issued, matching its proved issuerKey document. */
export interface ActiveKey {
  epoch: number;
  keyId: Uint8Array;
  signer: BlindSigner;
}

export interface TokenServiceDeps {
  network: BadgeNetwork;
  params: EpochParams;
  issuerId: string;
  core: CoreView;
  store: TokenStore;
  challenges: Challenges;
  /** null when no key is ready (missing file, issuerKey not on Platform, too many staged keys) */
  activeKey(epoch: number): ActiveKey | null;
  nowSec(): number;
}

export interface TokenInput {
  request: unknown;
  signature: unknown;
  blindedMsg: unknown;
}

function b64(v: unknown, what: string, max: number): Uint8Array {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new IssueError('bad-request', `${what} must be base64`);
  try {
    return base64ToBytes(v);
  } catch {
    throw new IssueError('bad-request', `${what} must be base64`);
  }
}

export class TokenService {
  readonly #d: TokenServiceDeps;
  readonly #issuerBytes: Uint8Array;

  constructor(deps: TokenServiceDeps) {
    this.#d = deps;
    this.#issuerBytes = idToBytes(deps.issuerId);
  }

  challenge(): { nonce: string; expiresAt: number } {
    const c = this.#d.challenges.issue(this.#d.nowSec());
    return { nonce: toHex(c.nonce), expiresAt: c.expiresAt };
  }

  async issue(input: TokenInput): Promise<{ blindSig: Uint8Array; epoch: number; retry: boolean }> {
    const d = this.#d;
    // 1. shape
    if (typeof input.request !== 'string') throw new IssueError('bad-request', 'request must be a string');
    const sig = b64(input.signature, 'signature', 100);
    if (sig.length !== 65) throw new IssueError('bad-request', 'signature must be 65 bytes');
    const blindedMsg = b64(input.blindedMsg, 'blindedMsg', 700);
    let req: TokenRequest;
    try {
      req = parseTokenRequest(input.request);
    } catch (e) {
      throw new IssueError('bad-request', `request: ${(e as Error).message}`);
    }
    // 2. request fields
    if (req.net !== d.network) throw new IssueError('wrong-network', `this issuer serves ${d.network}`);
    if (!equalBytes(req.issuerId, this.#issuerBytes)) throw new IssueError('wrong-issuer', 'the request names another issuer');
    const tip = await this.#tip();
    const epoch = issuingEpochAt(d.params, tip);
    if (req.epoch !== epoch) throw new IssueError('wrong-epoch', `tokens are issued for epoch ${epoch} now (height ${tip})`);
    const key = d.activeKey(epoch);
    if (!key) throw new IssueError('unavailable', `no signing key is ready for epoch ${epoch}`);
    if (!equalBytes(req.keyId, key.keyId)) throw new IssueError('wrong-key', `the request names another key than the issuerKey of epoch ${epoch}`);
    if (!d.challenges.check(req.nonce, d.nowSec())) throw new IssueError('bad-challenge', 'challenge invalid or expired: fetch a new one');
    if (!equalBytes(req.blindedMsgSha256, await sha256(blindedMsg))) throw new IssueError('bad-request', 'the request does not bind this blinded message');
    if (blindedMsg.length !== key.signer.modulusBytes) throw new IssueError('bad-request', `blindedMsg must be ${key.signer.modulusBytes} bytes`);
    // 3. authentication (the voting key in the current list). One answer for every failure.
    const proTxHash = toHex(req.proTxHash);
    const recovered = recoverMessageSigner(sig, buildTokenRequest(req), d.network, { strict: true });
    const now = recovered ? await this.#mn(proTxHash, 'tip') : null;
    if (!recovered || !now || !equalBytes(now.votingKeyId, recovered.keyId)) throw new IssueError('unauthorized', 'the signature is not from this masternode’s voting key');
    // 4. eligibility
    if (!now.valid) throw new IssueError('not-eligible', 'the masternode is not valid (PoSe-banned) now');
    const snapHeight = issuanceWindow(d.params, epoch).from;
    const snap = await this.#mn(proTxHash, snapHeight);
    if (!snap) throw new IssueError('not-eligible', `the masternode was not registered at the snapshot height ${snapHeight}`);
    if (!snap.valid) throw new IssueError('not-eligible', `the masternode was not valid at the snapshot height ${snapHeight}`);
    if (snap.collateral !== now.collateral) throw new IssueError('not-eligible', 'the collateral changed since the snapshot height');
    // 5 + 6. dedup, sign, verify
    let out;
    try {
      out = d.store.reserve({ epoch, proTxHash, collateral: now.collateral, blindedHash: req.blindedMsgSha256 }, () => key.signer.sign(blindedMsg));
    } catch (e) {
      if (e instanceof SignerError && (e.code === 'bad-length' || e.code === 'out-of-range')) throw new IssueError('bad-request', e.message);
      throw new IssueError('unavailable', 'signing failed');
    }
    if (out.kind === 'closed') throw new IssueError('wrong-epoch', `issuance for epoch ${epoch} has closed`);
    if (out.kind === 'conflict')
      throw new IssueError('already-issued', out.reason === 'mn' ? 'this masternode already obtained a token from this issuer for this epoch' : 'this collateral already obtained a token from this issuer for this epoch');
    return { blindSig: out.blindSig, epoch, retry: out.retry };
  }

  async #tip(): Promise<number> {
    try {
      return await this.#d.core.tipHeight();
    } catch {
      throw new IssueError('unavailable', 'Core is not reachable');
    }
  }
  async #mn(proTxHash: string, h: number | 'tip') {
    try {
      return await this.#d.core.mnAt(proTxHash, h);
    } catch {
      throw new IssueError('unavailable', 'Core is not reachable');
    }
  }
}
