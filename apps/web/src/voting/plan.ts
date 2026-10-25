// Planning and signing masternode funding votes in the browser (docs/PLAN.md §5.1, §5.2). Pure: no DOM, no network, so the
// Node live scripts use it too. Core rules respected here (Dash Core develop f35a24cfca12):
//   - nTime may be at most 1 h ahead of the receiving node's clock (vote.cpp:213): an immediate vote is timed "now";
//     a deferred vote is timed at its release time T and only broadcast from T - margin.
//   - one accepted change per hour per (masternode, proposal, signal), on the node's receive clock (object.cpp:443-456): a vote
//     within an hour of the masternode's current vote is planned for (current + 1 h + slack) and the relay holds it until then.
//   - a vote older than the current one is "obsolete" (object.cpp:421): the new nTime is always later than the current vote's.
//   - funding votes only (VOTE_SIGNAL.FUNDING); operator BLS signals are out of scope.
import { governanceVoteHash, signVote, VOTE_MAX_FUTURE_S, VOTE_SIGNAL, VOTE_UPDATE_MIN_S, voteSchemeFor, voteSignatureHash, voteSignatureString, bytesToHex, type Network, type VoteFields } from '@govhub/verify';

export type Outcome = 1 | 2 | 3;
export const OUTCOME_NAME: Record<Outcome, 'yes' | 'no' | 'abstain'> = { 1: 'yes', 2: 'no', 3: 'abstain' };

/** Slack added to Core's 1-hour rule (clock skew between us, the relay and the receiving nodes). */
export const RATE_SLACK_S = 120;
/**
 * The latest release before a proposal's voting deadline: PLAN §5.2 leaves 12 h on mainnet (one 16,616-block cycle is ~30 days).
 * Testnet cycles are 24 blocks (~1 h), so the same margin would leave no window at all; there it is 10 minutes.
 */
export const DEADLINE_MARGIN_S: Record<'mainnet' | 'testnet', number> = { mainnet: 12 * 3600, testnet: 10 * 60 };

export interface Masternode {
  proTxHash: string;
  collateralTxid: string;
  collateralIndex: number;
}

export interface CurrentVote {
  outcome: number;
  /** signed nTime */
  time: number;
}

export interface Intent {
  mn: Masternode;
  govHash: string;
  outcome: Outcome;
}

export interface PlannedVote extends Intent {
  /** the signed nTime */
  time: number;
  /** when the relay may broadcast it (== time for deferred votes, now for immediate ones unless the 1-hour rule delays it) */
  releaseAt: number;
  /** why the plan differs from what was asked (shown to the user) */
  notes: string[];
}

export type PlanResult = { ok: PlannedVote[]; skipped: Array<{ intent: Intent; reason: string }> };

export const mnId = (m: Pick<Masternode, 'collateralTxid' | 'collateralIndex'>): string => `${m.collateralTxid.toLowerCase()}-${m.collateralIndex}`;
export const currentKey = (m: Pick<Masternode, 'collateralTxid' | 'collateralIndex'>, govHash: string): string => `${mnId(m)}|${govHash.toLowerCase()}`;

/** The earliest nTime Core will accept from this masternode for this proposal, given its current vote. */
function earliestTime(now: number, cur: CurrentVote | undefined): { time: number; note?: string } {
  if (!cur) return { time: now };
  const afterRate = cur.time + VOTE_UPDATE_MIN_S + RATE_SLACK_S;
  if (afterRate > now) return { time: afterRate, note: 'This masternode voted on this proposal less than an hour ago; Core accepts one change per hour, so the relay holds the vote until then.' };
  return { time: Math.max(now, cur.time + 1) };
}

/**
 * Immediate votes: nTime = now (or the first moment Core's 1-hour rule allows). Same-outcome re-votes are skipped unless `resend`
 * (the user confirmed that re-sending only moves the timestamp).
 */
export function planImmediate(intents: readonly Intent[], current: ReadonlyMap<string, CurrentVote>, now: number, o: { resend?: boolean } = {}): PlanResult {
  const out: PlanResult = { ok: [], skipped: [] };
  for (const i of intents) {
    const cur = current.get(currentKey(i.mn, i.govHash));
    if (!o.resend && cur && cur.outcome === i.outcome && cur.time <= now + VOTE_MAX_FUTURE_S) {
      out.skipped.push({ intent: i, reason: `already voted ${OUTCOME_NAME[i.outcome]}` });
      continue;
    }
    const e = earliestTime(now, cur);
    out.ok.push({ ...i, time: e.time, releaseAt: e.time > now ? e.time - 60 : now, notes: e.note ? [e.note] : [] });
  }
  return out;
}

export interface Window {
  earliest: number;
  latest: number;
}

/** The deferred-release window: from `now + minDelayS` to the voting deadline minus the network's margin. */
export function deferredWindow(now: number, deadline: number, network: 'mainnet' | 'testnet', minDelayS = 60): Window | null {
  const latest = deadline - DEADLINE_MARGIN_S[network];
  const earliest = now + minDelayS;
  return latest > earliest ? { earliest, latest } : null;
}

/** Uniform integer in [a, b] from a 32-bit random source (crypto.getRandomValues in the app; injectable for tests). */
export function uniform(a: number, b: number, rand32: () => number): number {
  const n = b - a + 1;
  if (n <= 1) return a;
  const lim = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const v = rand32();
    if (v < lim) return a + (v % n);
  }
}

export const cryptoRand32 = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/**
 * Deferred votes (PLAN §5.2): every masternode gets its OWN independent release time Tᵢ, uniform in the window (after its 1-hour
 * rule), and the vote is signed with nTime = Tᵢ. Votes of one owner therefore do not appear together on the network.
 */
export function planDeferred(intents: readonly Intent[], current: ReadonlyMap<string, CurrentVote>, now: number, w: Window, rand32: () => number = cryptoRand32): PlanResult {
  const out: PlanResult = { ok: [], skipped: [] };
  for (const i of intents) {
    const cur = current.get(currentKey(i.mn, i.govHash));
    const from = Math.max(w.earliest, earliestTime(now, cur).time);
    if (from > w.latest) {
      out.skipped.push({ intent: i, reason: 'no time is left in the window for this masternode (Core allows one change per hour)' });
      continue;
    }
    const t = uniform(from, w.latest, rand32);
    out.ok.push({ ...i, time: t, releaseAt: t, notes: [] });
  }
  return out;
}

/** Random per-request delays (ms) so a batch of deferred votes does not reach a relay as one burst. */
export const submitDelays = (n: number, maxMs: number, rand32: () => number = cryptoRand32): number[] => Array.from({ length: n }, () => uniform(0, maxMs, rand32));

export const voteFields = (p: Pick<PlannedVote, 'mn' | 'govHash' | 'outcome' | 'time'>): VoteFields => ({
  collateralTxid: p.mn.collateralTxid.toLowerCase(),
  collateralIndex: p.mn.collateralIndex,
  govHashDisplay: p.govHash.toLowerCase(),
  signal: VOTE_SIGNAL.FUNDING,
  outcome: p.outcome,
  time: p.time,
});

export interface SignedVoteRecord {
  proTxHash: string;
  collateralTxid: string;
  collateralIndex: number;
  govHash: string;
  outcome: Outcome;
  time: number;
  releaseAt: number;
  /** base64 of the 65-byte signature (the voteraw argument) */
  sig: string;
  /** Core's vote hash (display hex): the id in `gobject getcurrentvotes` and the bridge */
  voteHash: string;
}

/** Signs with the network's scheme (mainnet/regtest/devnet: message signing; testnet: the binary vote hash, vote.cpp:176). */
export function signPlanned(p: PlannedVote, privKey: Uint8Array, compressed: boolean, network: Network): SignedVoteRecord {
  const fields = voteFields(p);
  const s = signVote({ privKey, vote: fields, network, compressed });
  return {
    proTxHash: p.mn.proTxHash,
    collateralTxid: fields.collateralTxid,
    collateralIndex: fields.collateralIndex,
    govHash: fields.govHashDisplay,
    outcome: p.outcome,
    time: p.time,
    releaseAt: p.releaseAt,
    sig: s.base64,
    voteHash: governanceVoteHash(fields),
  };
}

/**
 * Offline signing: what the voting key must sign, per network. Mainnet: the exact text for Dash Core `signmessage <address> "<text>"`,
 * DMT or a hardware wallet. Testnet: Core verifies the BINARY vote hash with no message wrapper, which `signmessage` cannot produce,
 * so only the hash is shown (for custom tooling); hardware wallets and Core cannot sign testnet votes offline.
 */
export function offlineSigningRequest(p: Pick<PlannedVote, 'mn' | 'govHash' | 'outcome' | 'time'>, network: Network): { scheme: 'message' | 'hash'; message?: string; hashHex: string; voteHash: string } {
  const f = voteFields(p);
  const scheme = voteSchemeFor(network);
  if (scheme === 'message') return { scheme, message: voteSignatureString(f), hashHex: '', voteHash: governanceVoteHash(f) };
  return { scheme, hashHex: bytesToHex(voteSignatureHash(f)), voteHash: governanceVoteHash(f) };
}

/**
 * Offline signing at the moment the user asks (not when the panel opened): the nTime is now, or the first time Core's one-change-
 * per-hour rule allows after the masternode's current vote on this proposal; `releaseAt` as for an immediate vote.
 */
export function offlineVoteTime(now: number, current: CurrentVote | undefined): { time: number; releaseAt: number; hourRule: boolean } {
  const e = earliestTime(now, current);
  return { time: e.time, releaseAt: e.time > now ? e.time - 60 : now, hourRule: e.time > now + 1 };
}

/** The Dash Core command that broadcasts a vote signed elsewhere (`voteraw`), with the signature or a placeholder. */
export function voterawCommand(p: Pick<PlannedVote, 'mn' | 'govHash' | 'outcome' | 'time'>, sigBase64 = '<signature-base64>'): string {
  const f = voteFields(p);
  return `voteraw ${f.collateralTxid} ${f.collateralIndex} ${f.govHashDisplay} funding ${OUTCOME_NAME[p.outcome]} ${f.time} ${sigBase64}`;
}
