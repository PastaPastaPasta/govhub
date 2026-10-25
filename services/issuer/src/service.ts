// Token issuance (PLAN §8.4). One request = one MN, authenticated by a Dash signmessage signature from the MN's VOTING key over
// the canonical token request. Order of checks:
//   1. shape: request string, 65-byte signature, blinded message (no MN state is touched)
//   2. request fields: network, issuer, epoch = the one being issued (S(E-1) <= tip < S(E)), keyId = this epoch's key, a valid
//      unexpired challenge, SHA256(blindedMsg) bound, blinded message of modulus length and 1 < m < n
//   3. authentication: the recovered key's hash160 equals keyIDVoting of the proTxHash in the CURRENT list. Every failure here is
//      the same "unauthorized" answer, so the endpoint does not tell a stranger anything about an MN. The lists are cached by the
//      housekeeping timer (MnLists): nothing before authentication reaches dashd.
//   4. eligibility (only the key holder sees these answers): at most a few requests per MN per minute; the tip, read fresh, still
//      in E-1's window; valid now; in the list and valid at S(E-1) with the same collateral
//   5. atomic dedup on (proTxHash, epoch) and (collateral, epoch); a retry with the same SHA256(blindedMsg) gets the same signature
//   6. OpenSSL raw RSA signature, verified before it is returned
import { base64ToBytes, buildTokenRequest, epochStart, equalBytes, idToBytes, issuingEpochsAt, parseTokenRequest, requestBindsBlindedMsg, toHex, type BadgeNetwork, type EpochParams, type TokenRequest } from '@govhub/badge';
import { recoverMessageSigner } from '@govhub/verify';
import type { Challenges } from './challenge.ts';
import type { CoreView, MnLists } from './core.ts';
import { storeWindowFrom, type TokenStore } from './db.ts';
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

/** Blocks the cached list may trail the fresh tip before it is refused (the timer refreshes it every ISSUER_TICK_S). */
const MAX_LIST_LAG = 5;

export class IssueError extends Error {
  readonly code: IssueErrorCode;
  readonly status: number;
  /** wrong-epoch: the epoch the issuer is issuing for (a client whose epoch is ahead knows the issuer lags and retries) */
  readonly issuingEpoch?: number;
  constructor(code: IssueErrorCode, message: string, issuingEpoch?: number) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.name = 'IssueError';
    if (issuingEpoch !== undefined) this.issuingEpoch = issuingEpoch;
  }
}

/** The key the server may sign with right now: for the epoch being issued, matching its proved issuerKey document. */
export interface ActiveKey {
  epoch: number;
  keyId: Uint8Array;
  signer: BlindSigner;
  /** the issuerKey document's $createdAtCoreBlockHeight (Platform's core height): no token for the epoch exists before it */
  keyCreatedAt: number;
}

export interface TokenServiceDeps {
  network: BadgeNetwork;
  params: EpochParams;
  issuerId: string;
  /** a fresh tip height (one cheap RPC, only for authenticated requests) */
  core: Pick<CoreView, 'tipHeight'>;
  lists: Pick<MnLists, 'now' | 'snapshot'>;
  store: TokenStore;
  challenges: Challenges;
  /** null when no key is ready (missing file, issuerKey not on Platform, too many staged keys) */
  activeKey(epoch: number): ActiveKey | null;
  nowSec(): number;
  /** requests per MN per minute (after authentication); default 6 */
  perMnPerMinute?: number;
  /**
   * Requests per second allowed past the cheap checks (shape, epoch, key, challenge HMAC, blinded-message hash), i.e. into signature
   * recovery; default 2000 (a recovery costs about 0.1 ms). Junk that fails the cheap checks does not consume it (N6); well-formed
   * floods are for the edge's per-IP limit.
   */
  maxRecoveriesPerSec?: number;
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
  /**
   * Per-MN request counts for the current wall-clock minute only (memory only). The whole map is dropped as soon as the minute
   * changes (on every call and on the housekeeping tick), so the issuer never holds which masternodes asked, or when, beyond the
   * current minute.
   */
  #perMn = new Map<string, number>();
  #minute = -1;
  #second = 0;
  #inSecond = 0;

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
    this.prune();
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
    // 2. request fields (cached tip: no RPC before authentication)
    if (req.net !== d.network) throw new IssueError('wrong-network', `this issuer serves ${d.network}`);
    if (!equalBytes(req.issuerId, this.#issuerBytes)) throw new IssueError('wrong-issuer', 'the request names another issuer');
    const now = d.lists.now;
    if (!now) throw new IssueError('unavailable', 'the masternode list is not loaded yet');
    // tokens for the current epoch (Standard mode) and the next one (private modes)
    const [current, next] = issuingEpochsAt(d.params, now.height);
    if (req.epoch !== current && req.epoch !== next) throw new IssueError('wrong-epoch', `tokens are issued for epochs ${current} and ${next} now (height ${now.height})`, current);
    const epoch = req.epoch;
    const key = d.activeKey(epoch);
    if (!key) throw new IssueError('unavailable', `no signing key is ready for epoch ${epoch}`);
    if (!equalBytes(req.keyId, key.keyId)) throw new IssueError('wrong-key', `the request names another key than the issuerKey of epoch ${epoch}`);
    if (!d.challenges.check(req.nonce, d.nowSec())) throw new IssueError('bad-challenge', 'challenge invalid or expired: fetch a new one');
    if (!(await requestBindsBlindedMsg(req, blindedMsg))) throw new IssueError('bad-request', 'the request does not bind this blinded message');
    if (blindedMsg.length !== key.signer.modulusBytes) throw new IssueError('bad-request', `blindedMsg must be ${key.signer.modulusBytes} bytes`);
    // 3. authentication (the voting key in the current list). One answer for every failure.
    this.#budget();
    const proTxHash = toHex(req.proTxHash);
    const recovered = recoverMessageSigner(sig, buildTokenRequest(req), d.network, { strict: true });
    const mnNow = recovered ? now.list.get(proTxHash) : undefined;
    if (!recovered || !mnNow || !equalBytes(mnNow.votingKeyId, recovered.keyId)) throw new IssueError('unauthorized', 'the signature is not from this masternode’s voting key');
    // 4. eligibility
    this.#limit(proTxHash);
    const tip = await this.#tip();
    // a list that stopped refreshing (protx list failing while getblockcount works) is not used (N9)
    if (tip - now.height > MAX_LIST_LAG) throw new IssueError('unavailable', 'the masternode list is out of date');
    const [tipCurrent, tipNext] = issuingEpochsAt(d.params, tip);
    if (epoch !== tipCurrent && epoch !== tipNext) throw new IssueError('wrong-epoch', `issuance for epoch ${epoch} is not open (height ${tip})`, tipCurrent);
    if (!mnNow.valid) throw new IssueError('not-eligible', 'the masternode is not valid (PoSe-banned) now');
    const snapHeight = epochStart(d.params, epoch - 1);
    const windowFrom = storeWindowFrom(d.params, epoch, key.keyCreatedAt);
    const snapList = d.lists.snapshot(snapHeight);
    if (!snapList) throw new IssueError('unavailable', `the masternode list at the snapshot height ${snapHeight} is not loaded yet`);
    const snap = snapList.get(proTxHash);
    if (!snap) throw new IssueError('not-eligible', `the masternode was not registered at the snapshot height ${snapHeight}`);
    if (!snap.valid) throw new IssueError('not-eligible', `the masternode was not valid at the snapshot height ${snapHeight}`);
    if (snap.collateral !== mnNow.collateral) throw new IssueError('not-eligible', 'the collateral changed since the snapshot height');
    // 5 + 6. dedup, sign, verify
    let out;
    try {
      out = d.store.reserve({ epoch, windowFrom, proTxHash, collateral: mnNow.collateral, blindedHash: req.blindedMsgSha256 }, () => key.signer.sign(blindedMsg));
    } catch (e) {
      if (e instanceof SignerError && (e.code === 'bad-length' || e.code === 'out-of-range')) throw new IssueError('bad-request', e.message);
      throw new IssueError('unavailable', 'signing failed');
    }
    if (out.kind === 'closed') throw new IssueError('wrong-epoch', `issuance for epoch ${epoch} has closed`, epoch + 1);
    if (out.kind === 'store-too-new') throw new IssueError('unavailable', `this issuer's token store started after epoch ${epoch}'s window opened and its key was published; it issues again from the next epoch`);
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

  /** The global budget for signature recoveries (a CPU backstop). */
  #budget(): void {
    const s = Math.floor(Date.now() / 1000);
    if (s !== this.#second) {
      this.#second = s;
      this.#inSecond = 0;
    }
    if (++this.#inSecond > (this.#d.maxRecoveriesPerSec ?? 2000)) throw new IssueError('unavailable', 'busy, retry later');
  }

  /** Drops the per-MN counts once their minute is over. Called on every request and by the housekeeping tick. */
  prune(now = Date.now()): void {
    const minute = Math.floor(now / 60_000);
    if (minute === this.#minute) return;
    this.#minute = minute;
    this.#perMn = new Map();
  }

  /**
   * Tests only: everything the rate limiter holds in memory right now. The issuer's no-linkable-logs test inspects it; nothing
   * in the service reads it.
   */
  debugSnapshot(): { minute: number; perMn: Array<[string, number]> } {
    return { minute: this.#minute, perMn: [...this.#perMn] };
  }

  /**
   * A few requests per MN per wall-clock minute, counted only after authentication (memory only, nothing about the requester).
   * A fixed window: up to twice the limit can pass around a minute boundary, which is fine for a backstop.
   */
  #limit(proTxHash: string): void {
    this.prune();
    const max = this.#d.perMnPerMinute ?? 6;
    const n = this.#perMn.get(proTxHash) ?? 0;
    if (n >= max) throw new IssueError('unavailable', 'too many requests for this masternode; wait a minute');
    this.#perMn.set(proTxHash, n + 1);
  }
}
