// Starter token issuance (README "Starter tokens"; format in packages/badge/src/starter.ts). One starter per masternode (proved with
// its VOTING key) and one per proposal (proved with its PAYMENT address), for life, blind-signed under the starter identity's key of
// the epoch. The same order of checks as the badge TokenService:
//   1. shape: request string, 65-byte signature, blinded message (nothing about any MN or proposal is touched)
//   2. request fields: network, the STARTER issuer, epoch = current or next at the cached tip, that epoch's starter key, keyId, a
//      valid unexpired starter challenge, SHA256(blindedMsg) bound, blinded message of modulus length
//   3. the global recovery budget (shared with the badge service)
//   4. authentication, one "unauthorized" answer for every failure: mn: the recovered key's hash160 is keyIDVoting of the proTxHash
//      in the CURRENT cached list; proposal: the govHash is a valid proposal (cached list) with a P2PKH payment address whose hash160
//      is the recovered key's. Both lists are cached by the housekeeping timer: nothing before authentication reaches dashd.
//   5. eligibility (only the key holder sees these): a few requests per subject per minute; the tip, read fresh, close to the cached
//      list and still issuing the epoch; mn: valid (not PoSe-banned) now and registered with the same collateral at the start of the
//      current epoch (minimum age); proposal: ended at most STARTER_PROPOSAL_GRACE_DAYS ago
//   6. atomic lifetime dedup on (kind, subject) and the MN's collateral, then sign and verify; a retry with the same epoch and
//      SHA256(blindedMsg) gets the same signature
// Why the minimum age: one ProRegTx can spend an MN's collateral and create a new one in its own outputs, i.e. a new proTxHash AND a
// new outpoint for a fee. Without an age rule one 1000-DASH collateral could re-register every block and take a starter each time;
// with it, at most one per epoch (about a month on mainnet), which is not worth the fees and the lost MN rewards.
import { epochOf, epochStart, equalBytes, idToBytes, issuingEpochsAt, parseStarterRequest, starterKeyUsable, starterRequestBinds, toHex, type BadgeNetwork, type EpochParams, type StarterRequest } from '@govhub/badge';
import { recoverMessageSigner } from '@govhub/verify';
import type { Challenges } from './challenge.ts';
import type { CoreView, MnState, ProposalState } from './core.ts';
import { b64, freshTip, IssueError, MAX_LIST_LAG, MinuteCounts, signFailure, type ActiveKey, type RecoveryBudget, type TokenInput } from './service.ts';
import type { StarterStore } from './starter-db.ts';

type Cached<T> = { height: number; list: Map<string, T> } | null;

export interface StarterServiceDeps {
  network: BadgeNetwork;
  params: EpochParams;
  /** the starter identity (base58) */
  issuerId: string;
  /** a fresh tip height (one cheap RPC, only for authenticated requests) */
  core: Pick<CoreView, 'tipHeight'>;
  /** the current MN list and the epoch-start snapshots (MnLists, refreshed by the badge EpochManager) */
  lists: { readonly now: Cached<MnState>; snapshot(height: number): Map<string, MnState> | null };
  /** the valid proposals (ProposalCache, refreshed by the StarterManager) */
  proposals: { readonly now: Cached<ProposalState> };
  store: StarterStore;
  /** its own instance: domain `starter|<net>|<starterIssuerId>` */
  challenges: Challenges;
  /** null when no starter key is ready for the epoch */
  activeKey(epoch: number): ActiveKey | null;
  nowSec(): number;
  proposalGraceDays: number;
  /** shared with the badge TokenService */
  budget: RecoveryBudget;
}

const UNAUTHORIZED = 'the signature is not from this masternode’s voting key or this proposal’s payment address';
const ALREADY = {
  mn: 'this masternode already received its starter (one per masternode, ever)',
  collateral: 'this collateral already received its starter (one per masternode, ever)',
  proposal: 'this proposal already received its starter (one per proposal)',
} as const;
/** requests per subject per wall-clock minute, after authentication (as per MN for badges) */
const PER_SUBJECT_PER_MINUTE = 6;

export class StarterService {
  readonly #d: StarterServiceDeps;
  readonly #issuerBytes: Uint8Array;
  /** per-subject request counts for the current wall-clock minute only (memory only) */
  readonly #perSubject: MinuteCounts;

  constructor(deps: StarterServiceDeps) {
    this.#d = deps;
    this.#issuerBytes = idToBytes(deps.issuerId);
    this.#perSubject = new MinuteCounts(PER_SUBJECT_PER_MINUTE);
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
    let req: StarterRequest;
    try {
      req = parseStarterRequest(input.request);
    } catch (e) {
      throw new IssueError('bad-request', `request: ${(e as Error).message}`);
    }
    // 2. request fields (cached tip: no RPC before authentication)
    if (req.net !== d.network) throw new IssueError('wrong-network', `this issuer serves ${d.network}`);
    if (!equalBytes(req.issuerId, this.#issuerBytes)) throw new IssueError('wrong-issuer', 'the request names another starter issuer');
    // read once: the timer may replace the lists while this request waits
    const mnList = req.kind === 'mn' ? d.lists.now : null;
    const proposalList = req.kind === 'proposal' ? d.proposals.now : null;
    const cached = mnList ?? proposalList;
    if (!cached) throw new IssueError('unavailable', req.kind === 'mn' ? 'the masternode list is not loaded yet' : 'the proposal list is not loaded yet');
    const [current, next] = issuingEpochsAt(d.params, cached.height);
    if (req.epoch !== current && req.epoch !== next) throw new IssueError('wrong-epoch', `starters are issued for epochs ${current} and ${next} now (height ${cached.height})`, current);
    const epoch = req.epoch;
    const key = d.activeKey(epoch);
    if (!key) throw new IssueError('unavailable', `no starter key is ready for epoch ${epoch}`);
    if (!equalBytes(req.keyId, key.keyId)) throw new IssueError('wrong-key', `the request names another key than the starter issuerKey of epoch ${epoch}`);
    // the current epoch's key only if it was published before the epoch began (starterKeyUsable: a late one would let us relabel
    // requests by time); clients then ask for the next epoch
    if (!starterKeyUsable(d.params, cached.height, epoch, key.keyCreatedAt)) throw new IssueError('wrong-key', `the starter key of the current epoch ${epoch} was published after the epoch began, so it is not used for starters: ask for epoch ${next}`);
    if (!d.challenges.check(req.nonce, d.nowSec())) throw new IssueError('bad-challenge', 'challenge invalid or expired: fetch a new one');
    if (!(await starterRequestBinds(req, blindedMsg))) throw new IssueError('bad-request', 'the request does not bind this blinded message');
    if (blindedMsg.length !== key.signer.modulusBytes) throw new IssueError('bad-request', `blindedMsg must be ${key.signer.modulusBytes} bytes`);
    // 3. the global budget for signature recoveries
    d.budget.take();
    // 4. authentication. One answer for every failure, whatever the kind.
    const subject = toHex(req.subject);
    const recovered = recoverMessageSigner(sig, input.request, d.network, { strict: true });
    let mn: MnState | undefined;
    let proposal: ProposalState | undefined;
    if (req.kind === 'mn') {
      mn = recovered ? mnList?.list.get(subject) : undefined;
      if (!recovered || !mn || !equalBytes(mn.votingKeyId, recovered.keyId)) throw new IssueError('unauthorized', UNAUTHORIZED);
    } else {
      proposal = recovered ? proposalList?.list.get(subject) : undefined;
      // a P2SH payment address cannot sign a message: paymentKeyId is null and nothing matches
      if (!recovered || !proposal?.paymentKeyId || !equalBytes(proposal.paymentKeyId, recovered.keyId)) throw new IssueError('unauthorized', UNAUTHORIZED);
    }
    // 5. eligibility
    if (!this.#perSubject.take(`${req.kind}:${subject}`)) throw new IssueError('unavailable', 'too many requests for this masternode or proposal; wait a minute');
    const tip = await freshTip(d.core);
    // a list that stopped refreshing (its RPC failing while getblockcount works) is not used
    if (tip - cached.height > MAX_LIST_LAG) throw new IssueError('unavailable', req.kind === 'mn' ? 'the masternode list is out of date' : 'the proposal list is out of date');
    const [tipCurrent, tipNext] = issuingEpochsAt(d.params, tip);
    if (epoch !== tipCurrent && epoch !== tipNext) throw new IssueError('wrong-epoch', `issuance for epoch ${epoch} is not open (height ${tip})`, tipCurrent);
    if (mn) {
      if (!mn.valid) throw new IssueError('not-eligible', 'the masternode is not valid (PoSe-banned) now');
      // S(current) once it is settled, else S(current-1) (older, so stricter); MnLists keeps both
      const c = epochOf(d.params, cached.height);
      const snap = d.lists.snapshot(epochStart(d.params, c)) ?? d.lists.snapshot(epochStart(d.params, Math.max(0, c - 1)));
      if (!snap) throw new IssueError('unavailable', 'the masternode list at the epoch start is not loaded yet');
      if (snap.get(subject)?.collateral !== mn.collateral) throw new IssueError('not-eligible', `the masternode is too new: it must have been registered with this collateral at the start of the current epoch (height ${epochStart(d.params, c)})`);
    }
    if (proposal && proposal.endEpoch < d.nowSec() - d.proposalGraceDays * 86_400) throw new IssueError('not-eligible', `the proposal ended more than ${d.proposalGraceDays} days ago`);
    // 6. lifetime dedup, sign, verify
    let out;
    try {
      out = d.store.reserve({ kind: req.kind, subject, collateral: mn ? mn.collateral : null, epoch, blindedHash: req.blindedMsgSha256 }, () => key.signer.sign(blindedMsg));
    } catch (e) {
      throw signFailure(e);
    }
    if (out.kind === 'conflict') throw new IssueError('already-issued', ALREADY[out.reason === 'collateral' ? 'collateral' : req.kind]);
    return { blindSig: out.blindSig, epoch, retry: out.retry };
  }

  /** Drops the per-subject counts once their minute is over. Called on every request and by the housekeeping tick. */
  prune(now = Date.now()): void {
    this.#perSubject.prune(now);
  }

  /** Tests only: everything the per-subject limiter holds in memory right now (the no-linkable-logs test inspects it). */
  debugSnapshot(): { minute: number; perSubject: Array<[string, number]> } {
    const s = this.#perSubject.snapshot();
    return { minute: s.minute, perSubject: s.entries };
  }
}
