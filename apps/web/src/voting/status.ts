// What a watched vote's state means, in plain words, and the five-step tracker shown after signing (signed in your browser ->
// accepted by a relay -> broadcast to the network -> seen by the network -> counted in the tally). Pure: the vote record and the
// clock in, words out. Times are formatted by the caller.
import { formatDuration } from '../lib/format.ts';
import type { RelayInfo, WatchedVote } from './pending.ts';
import { DEADLINE_MARGIN_S, deferredWindow, OUTCOME_NAME } from './plan.ts';
import { relayHost, RelayError, type RelayVoteState } from './relay.ts';

export type Tone = 'wait' | 'progress' | 'ok' | 'bad' | 'quiet';
export type TimeFmt = (unixS: number) => string;

/** A relay's short error codes (services/relay README) in plain words. */
const RELAY_CODES: Record<string, string> = {
  obsolete: 'Core already has a newer vote from this masternode',
  'mn-gone': 'the masternode is no longer registered',
  'mn-banned': 'the masternode is PoSe-banned, and banned masternodes cannot vote',
  'mn-not-valid': 'Core does not list this masternode as valid',
  'bad-signature': 'Core could not verify the signature',
  'unknown-proposal': 'Core does not know this proposal',
  'core-error': "the relay's Dash Core node keeps answering with errors",
  unconfirmed: 'Core accepted it, but it never showed up in its vote list',
  'too-often': 'Core allows one vote change per hour per masternode',
  'hour-rule': 'Core allows one vote change per hour per masternode',
  'future-limit': 'Core refuses votes timed more than an hour ahead',
  'not-visible': 'it was not visible on the network yet, so the relay sends it again',
};
export const relayCodeText = (code: string | null | undefined): string => (code ? (RELAY_CODES[code] ?? code) : 'unknown reason');

/** The relay that knows most about the vote: the one furthest along. */
export function leadRelay(v: WatchedVote): { relay: string; info: RelayInfo; status?: string } | null {
  if (!v.refs.length) return null;
  const rank = (s?: string) => ['confirmed', 'broadcast', 'sending', 'held'].indexOf(s ?? '');
  const order = (s?: string) => (rank(s) < 0 ? 99 : rank(s));
  const best = [...v.refs].sort((a, b) => order(v.relayStatus?.[a.relay]) - order(v.relayStatus?.[b.relay]))[0]!;
  return { relay: best.relay, info: v.relayInfo?.[best.relay] ?? {}, ...(v.relayStatus?.[best.relay] ? { status: v.relayStatus[best.relay] } : {}) };
}

/** Why a relay holds the vote and until when, in one sentence. */
export function holdText(v: WatchedVote, now: number, fmt: TimeFmt): string {
  const lead = leadRelay(v);
  const host = lead ? relayHost(lead.relay) : 'the relay';
  const info = lead?.info ?? {};
  const at = Math.max(info.nextAttemptAt ?? 0, info.releaseAt ?? v.releaseAt);
  let s: string;
  const reason = v.hourRule && (info.holdReason === 'release-time' || !info.holdReason) ? 'one-change-per-hour' : info.holdReason;
  switch (reason) {
    case 'one-change-per-hour':
      s = `Core allows one vote change per hour per masternode; ${host} sends this at ${fmt(at)}.`;
      break;
    case 'core-time-limit':
      s = `Core refuses votes timed more than an hour ahead; ${host} sends this at ${fmt(at)}.`;
      break;
    case 'retrying':
      s = `${host} is retrying after an error (${relayCodeText(info.lastError)}); next try at ${fmt(at)}.`;
      break;
    default:
      s = at > now + 30 ? `Held by ${host} until ${fmt(at)}.` : `Accepted by ${host}, going out now.`;
  }
  if (info.sameAsCurrent) s += ' It repeats the masternode’s current vote, so it only updates the timestamp.';
  return s;
}

export interface VoteView {
  /** short badge text */
  badge: string;
  tone: Tone;
  /** one plain sentence: what is happening, what happens next */
  line: string;
}

export function describeVote(v: WatchedVote, now: number, fmt: TimeFmt): VoteView {
  const lead = leadRelay(v);
  const host = lead ? relayHost(lead.relay) : '';
  switch (v.status) {
    case 'queued':
      if (v.restored) return { badge: 'Signed elsewhere', tone: 'quiet', line: 'Signed on another device. This browser does not send it; only a relay that already holds it can.' };
      if (v.lastSendError) {
        const when = v.nextSendAt && v.nextSendAt > now ? `Trying again at ${fmt(v.nextSendAt)}.` : 'Trying again now.';
        return { badge: 'Not sent yet', tone: 'bad', line: `Not accepted by a relay yet: ${v.lastSendError}. Kept in this browser. ${when}` };
      }
      return { badge: 'Sending', tone: 'progress', line: 'Signed in this browser, sending to the relay…' };
    case 'held':
      return { badge: 'Held by relay', tone: 'wait', line: holdText(v, now, fmt) };
    case 'broadcast': {
      const at = lead?.info.broadcastAt;
      return { badge: 'Broadcast', tone: 'progress', line: `Broadcast${host ? ` by ${host}` : ''}${at ? ` at ${fmt(at)}` : ''}, waiting for the network.` };
    }
    case 'confirmed':
      return v.countedAt
        ? { badge: 'Counted', tone: 'ok', line: 'Counted by the network: the tally’s vote set includes it, and the recount matches.' }
        : { badge: 'On the network', tone: 'ok', line: 'Seen by the network: the bridge’s vote set has it, signature checked against your voting key.' };
    case 'failed':
      return { badge: 'Failed', tone: 'bad', line: `${v.refs.length ? 'Did not reach the network' : 'Not sent'}: ${v.failReason ?? relayCodeText(lead?.info.lastError)}.` };
    case 'replaced':
      return { badge: 'Replaced', tone: 'quiet', line: v.replacedBy ? 'Replaced by your newer vote, which is now the one that counts.' : 'Replaced by a newer vote of this masternode that was not cast in this browser.' };
    case 'dropped':
      return { badge: 'Not sent', tone: 'quiet', line: 'Never sent: you replaced it with a newer vote before it left this browser.' };
    case 'cancelled':
      return { badge: 'Cancelled', tone: 'quiet', line: 'Cancelled at every relay that held it.' };
  }
}

export type StepKey = 'signed' | 'relay' | 'broadcast' | 'seen' | 'counted';
export type StepState = 'done' | 'active' | 'todo' | 'error';
export interface Step {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
}

const LABELS: Record<StepKey, string> = {
  signed: 'Signed in your browser',
  relay: 'Accepted by relay',
  broadcast: 'Broadcast to the network',
  seen: 'Seen by the network',
  counted: 'Counted in the tally',
};

/** The tracker. Exactly one step is active while the vote moves; a failure marks the step where it stopped. */
export function trackerSteps(v: WatchedVote, now: number, fmt: TimeFmt): Step[] {
  const lead = leadRelay(v);
  const host = lead ? relayHost(lead.relay) : 'the relay';
  const leftRelay = v.status === 'broadcast' || v.status === 'confirmed' || ['sending', 'broadcast', 'confirmed'].includes(lead?.status ?? '');
  const reached = (k: StepKey): boolean => {
    switch (k) {
      case 'signed':
        return true;
      case 'relay':
        return v.refs.length > 0 || v.status === 'broadcast' || v.status === 'confirmed';
      case 'broadcast':
        return leftRelay;
      case 'seen':
        return v.status === 'confirmed';
      case 'counted':
        return !!v.countedAt;
    }
  };
  const keys: StepKey[] = ['signed', 'relay', 'broadcast', 'seen', 'counted'];
  const firstOpen = keys.find((k) => !reached(k));
  const stopped = v.status === 'failed' || v.status === 'cancelled' || v.status === 'dropped' || v.status === 'replaced';
  return keys.map((key): Step => {
    const base = { key, label: LABELS[key] };
    if (reached(key)) {
      const detail =
        key === 'signed' && v.signedAt
          ? fmt(v.signedAt)
          : key === 'relay' && lead
            ? host
            : key === 'broadcast' && lead?.info.broadcastAt
              ? fmt(lead.info.broadcastAt)
              : key === 'seen' && v.seenAt
                ? `${fmt(v.seenAt)}, signature verified`
                : key === 'counted' && v.countedAt
                  ? fmt(v.countedAt)
                  : undefined;
      return { ...base, state: 'done', ...(detail ? { detail } : {}) };
    }
    if (key !== firstOpen) return { ...base, state: 'todo' };
    if (stopped) return { ...base, state: 'error', detail: describeVote(v, now, fmt).line };
    const detail =
      key === 'relay'
        ? describeVote(v, now, fmt).line
        : key === 'broadcast'
          ? holdText(v, now, fmt)
          : key === 'seen'
            ? 'Waiting for the bridge’s vote set to show it…'
            : 'Recounting the tally’s vote set…';
    return { ...base, state: v.status === 'queued' && v.lastSendError ? 'error' : 'active', detail };
  });
}

export type SubmitOutcome =
  | { kind: 'retry'; text: string; afterS?: number; tryOther: boolean; maybeReceived?: boolean }
  | { kind: 'sent'; text: string }
  | { kind: 'final'; status: 'failed' | 'replaced' | 'dropped'; text: string };

/**
 * What a failed POST /v1/votes means for the vote. Transport errors, rate limits and a full or Core-less relay are retried (on
 * another relay when there is one); a relay saying Core already has this vote counts as sent; refusals are final, in plain words.
 */
export function classifySubmitError(e: unknown, relay: string): SubmitOutcome {
  const host = relayHost(relay);
  if (!(e instanceof RelayError) || e.status === undefined) {
    const msg = e instanceof Error ? e.message : String(e);
    // a request that timed out may have reached the relay; a refused connection or a failed DNS lookup did not
    const maybeReceived = /timeout|timed out|aborted/i.test(msg);
    return { kind: 'retry', text: maybeReceived ? `${host} did not answer in time` : /unreachable/.test(msg) ? `${host} is unreachable` : msg, tryOther: true, ...(maybeReceived ? { maybeReceived } : {}) };
  }
  const code = e.code ?? '';
  if (e.status === 429 || e.status >= 500 || code === 'relay-full' || code === 'core-unavailable') {
    return { kind: 'retry', text: `${host}: ${e.message}`, ...(e.retryAfterS ? { afterS: e.retryAfterS } : {}), tryOther: true };
  }
  if (code === 'already-current') return { kind: 'sent', text: 'Core already has this vote' };
  if (code === 'newer-vote-in-core') return { kind: 'final', status: 'replaced', text: 'Core already has a vote of this masternode with the same or a later time' };
  if (code === 'later-vote-held') return { kind: 'final', status: 'failed', text: `${host} already holds a later-timed vote of this masternode on this proposal (cast from another device?); cancel that one, then vote again` };
  // one relay's Core or masternode list lags (a brand-new proposal or masternode): another relay, or this one later, may accept it
  if (code === 'unknown-proposal' || code === 'unknown-mn') return { kind: 'retry', text: `${host}: ${e.message}`, tryOther: true };
  return { kind: 'final', status: 'failed', text: `${host} refused it: ${e.message}` };
}

/** "Vote No with 2 masternodes" */
export function voteButtonText(outcome: 1 | 2 | 3 | 0, count: number, deferred: boolean): string {
  if (!outcome) return 'Choose Yes, No or Abstain';
  const what = OUTCOME_NAME[outcome][0]!.toUpperCase() + OUTCOME_NAME[outcome].slice(1);
  return `${deferred ? 'Schedule' : 'Vote'} ${what} with ${count} masternode${count === 1 ? '' : 's'}`;
}

/** Applies what a relay said about a vote to our record (refs, per-relay status and details, and the vote's own status). */
export function applyRelayState(v: WatchedVote, relay: string, st: RelayVoteState): WatchedVote {
  const refs = v.refs.some((r) => r.relay === relay && r.id === st.id) ? v.refs : [...v.refs.filter((r) => r.relay !== relay), { relay, id: st.id }];
  const relayStatus = { ...v.relayStatus, [relay]: st.status };
  const relayInfo = {
    ...v.relayInfo,
    [relay]: { releaseAt: st.releaseAt, nextAttemptAt: st.nextAttemptAt, holdReason: st.holdReason, lastError: st.lastError, broadcastAt: st.broadcastAt, sameAsCurrent: st.sameAsCurrent },
  };
  const next: WatchedVote = { ...v, refs, relayStatus, relayInfo };
  // the bridge decides confirmed / replaced; relays only move a vote along or end it
  if (v.status === 'confirmed' || v.status === 'replaced' || v.status === 'cancelled') return next;
  const all = Object.values(relayStatus);
  if (all.some((x) => x === 'broadcast' || x === 'confirmed' || x === 'sending')) return { ...next, status: 'broadcast', lastSendError: undefined };
  if (all.some((x) => x === 'held')) return { ...next, status: 'held', lastSendError: undefined };
  if (all.every((x) => x === 'cancelled')) return { ...next, status: 'cancelled' };
  if (all.every((x) => x === 'failed' || x === 'superseded' || x === 'cancelled')) {
    return all.includes('superseded') ? { ...next, status: 'replaced', replacedBy: v.replacedBy ?? '' } : { ...next, status: 'failed', failReason: relayCodeText(st.lastError) };
  }
  return next;
}


/** Why spreading votes over time is not possible right now, in plain words (null: it is). */
export function deferredUnavailable(deadline: number | null, now: number, network: 'mainnet' | 'testnet'): string | null {
  if (!deadline) return 'The voting deadline is not known yet, so votes cannot be spread out.';
  if (deferredWindow(now, deadline, network)) return null;
  const hourly = network === 'testnet' ? '; testnet superblocks are hourly' : '';
  if (deadline <= now) return `Voting for this superblock has closed, so there is no time to spread votes out${hourly}.`;
  return `Voting closes in ${formatDuration(deadline - now)}, too soon to spread votes out (the last ${formatDuration(DEADLINE_MARGIN_S[network])} are kept free)${hourly}.`;
}

