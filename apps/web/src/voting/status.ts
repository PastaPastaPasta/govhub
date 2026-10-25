// What a watched vote's state means, in plain words, and the five-step tracker shown after signing (signed in your browser ->
// accepted by a relay -> broadcast to the network -> seen by the network -> counted in the tally). Pure: the vote record and the
// clock in, words out. Times are formatted by the caller.
import { errText, formatDuration } from '../lib/format.ts';
import { mayBeAtRelay, neverLeft, type RelayInfo, type WatchedVote } from './pending.ts';
import { DEADLINE_MARGIN_S, deferredWindow, OUTCOME_NAME } from './plan.ts';
import { relayHost, RelayError, RelayNotSentError, type RelayVoteState } from './relay.ts';

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
const relayCodeText = (code: string | null | undefined): string => (code ? (RELAY_CODES[code] ?? code) : 'unknown reason');

/** The relay that knows most about the vote: the one furthest along. */
export function leadRelay(v: WatchedVote): { relay: string; info: RelayInfo; status?: string } | null {
  if (!v.refs.length) return null;
  const rank = (s?: string) => ['confirmed', 'broadcast', 'maybe-broadcast', 'sending', 'held'].indexOf(s ?? '');
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

/**
 * Who else shows the vote the first bridge reports: other configured bridges (their vote sets, checked here) and relays that say Core
 * lists it. Without either, the line says it is the bridge's word, and how to check it yourself.
 */
export function corroboration(v: WatchedVote): string {
  const relays = Object.entries(v.relayStatus ?? {}).filter(([, s]) => s === 'confirmed').map(([r]) => relayHost(r));
  const others = [...(v.alsoSeenBy ?? []).map((b) => `bridge ${b} (its vote set has it, checked here)`), ...relays.map((r) => `relay ${r} (it reports its Dash Core node lists it)`)];
  // A source run by the same operator as the bridge agrees just as easily, so the way to be sure is always named.
  return others.length
    ? ` Also seen by ${others.join(' and ')}. To be sure, check your own Dash Core node.`
    : ' That is the bridge’s word: no other bridge or relay you configured confirms it. To be sure, check your own Dash Core node.';
}

/** The relays that hold the vote or may hold it, for display ("a.org and b.org"). */
const whereHeld = (v: WatchedVote): string => [...new Set([...v.refs.map((r) => r.relay), ...(v.maybeAt ?? [])])].map(relayHost).join(' and ') || 'the relay';

export function describeVote(v: WatchedVote, now: number, fmt: TimeFmt): VoteView {
  const lead = leadRelay(v);
  const host = lead ? relayHost(lead.relay) : '';
  if (v.cancelSig && (v.status === 'queued' || v.status === 'held')) {
    const next = v.nextCancelAt && v.nextCancelAt > now ? `next try at ${fmt(v.nextCancelAt)}` : 'trying again now';
    return {
      badge: 'Cancelling',
      tone: 'bad',
      line: `Not cancelled yet: ${v.cancelError ?? `${whereHeld(v)} could not be reached`}. ${whereHeld(v)} may still hold this vote and could release it, so this browser keeps asking for the cancel while this page is open (${next}). To be sure it does not count, vote again: a new vote is timed after it and wins.`,
    };
  }
  switch (v.status) {
    case 'queued':
      if (v.maybeAt?.length && !v.restored) {
        const when = v.nextSendAt && v.nextSendAt > now ? `at ${fmt(v.nextSendAt)}` : 'now';
        return {
          badge: 'May be at the relay',
          tone: 'wait',
          line: `Tried to send it to ${whereHeld(v)}, but no answer came back${v.lastSendError ? ` (${v.lastSendError})` : ''}, so it may already be held there. Asking again ${when}: a relay keeps one copy of the same vote, and its answer says where the vote is. Cancelling takes it back at the relay too.`,
        };
      }
      if (v.restored && v.maybeAt?.length)
        return { badge: 'May be at a relay', tone: 'wait', line: `Its submission to ${v.maybeAt.map(relayHost).join(', ')} got no answer, so that relay may hold it and could still release it. This browser does not send it again. To be sure it does not count, vote again: a new vote is timed after it and wins.` };
      if (v.restored) return { badge: 'Signed elsewhere', tone: 'quiet', line: 'Signed on another device. This browser does not send it; only a relay that already holds it can.' };
      if (v.lastSendError) {
        const when = v.nextSendAt && v.nextSendAt > now ? `Trying again at ${fmt(v.nextSendAt)}.` : 'Trying again now.';
        return { badge: 'Not sent yet', tone: 'bad', line: `Not accepted by a relay yet: ${v.lastSendError}. Kept in this browser. ${when}` };
      }
      return { badge: 'Sending', tone: 'progress', line: 'Signed in this browser, sending to the relay…' };
    case 'held':
      return { badge: 'Held by relay', tone: 'wait', line: holdText(v, now, fmt) };
    case 'broadcast': {
      if (v.withdrawn) return { badge: 'May already count', tone: 'wait', line: 'Cancelled at the relay, but the relay had already handed it to the network once, so it may already count. Vote again to change it (Core allows one change per hour).' };
      const at = lead?.info.broadcastAt;
      return { badge: 'Broadcast', tone: 'progress', line: `Broadcast${host ? ` by ${host}` : ''}${at ? ` at ${fmt(at)}` : ''}, waiting for the network.` };
    }
    case 'confirmed':
      return v.countedAt
        ? { badge: 'Bridge: counted', tone: 'ok', line: `The bridge reports the network counted it: its vote set includes it, and the recount of that set matches.${corroboration(v)}` }
        : { badge: 'Bridge: on the network', tone: 'ok', line: `The bridge reports the network has it: its vote set includes it, signature checked here against your voting key.${corroboration(v)}` };
    case 'failed': {
      // refused by one relay after another may have stored it (its answer was lost): that relay could still release it
      const maybe = v.maybeAt?.length ? ` ${v.maybeAt.map(relayHost).join(' and ')} may still hold it from an earlier try whose answer was lost: cancel it to take it back there.` : '';
      return { badge: 'Failed', tone: 'bad', line: `${v.refs.length || maybe ? 'Did not reach the network' : 'Not sent'}: ${v.failReason ?? relayCodeText(lead?.info.lastError)}.${maybe}` };
    }
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
  seen: 'The bridge reports it on the network',
  counted: 'The bridge reports it counted',
};

/** The tracker. Exactly one step is active while the vote moves; a failure marks the step where it stopped. */
export function trackerSteps(v: WatchedVote, now: number, fmt: TimeFmt): Step[] {
  const lead = leadRelay(v);
  const host = lead ? relayHost(lead.relay) : 'the relay';
  const leftRelay = v.status === 'broadcast' || v.status === 'confirmed' || ['sending', 'maybe-broadcast', 'broadcast', 'confirmed'].includes(lead?.status ?? '');
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
    // the relay step stops (error) only when no relay may have the vote; one whose answer was lost may hold it
    return { ...base, state: v.status === 'queued' && v.lastSendError && neverLeft(v) ? 'error' : 'active', detail };
  });
}

export type SubmitOutcome =
  | { kind: 'retry'; text: string; afterS?: number; tryOther: boolean; maybeReceived?: boolean }
  | { kind: 'sent'; text: string }
  | { kind: 'final'; status: 'failed' | 'replaced' | 'dropped'; text: string };

/** 503s the relay writes itself before it stores anything (services/relay: full, or its Core is down): not a lost answer. */
const RELAY_BUSY = new Set(['relay-full', 'core-unavailable']);
/**
 * The relay's own refusal of this request: a 4xx with the error code it writes, or its own "full" / "Core down" 503. It answered in
 * full, and did not store the vote because of this request. (A 500, a proxy's page without a code, or no answer at all: it may have.)
 */
export const relayRefused = (e: unknown): e is RelayError & { status: number; code: string } =>
  e instanceof RelayError && e.status !== undefined && !!e.code && (e.status < 500 || RELAY_BUSY.has(e.code));

/** Plain words for a failure that may have reached the relay (anything but its own refusal). */
function lostAnswerText(e: unknown, host: string): string {
  if (e instanceof RelayError && e.status !== undefined) return `${host} answered with an error: ${e.message}`;
  const msg = errText(e);
  if (/timeout|timed out|aborted/i.test(msg)) return `${host} did not answer in time`;
  const transport = /^relay \S+ unreachable: (.*)$/s.exec(msg);
  if (transport) return `the connection to ${host} failed before its answer arrived: ${transport[1]}`;
  return `${host} gave an answer this page could not use: ${msg}`;
}

/**
 * What a failed POST /v1/votes means for the vote. Only the relay's own refusal (a 4xx with the error code it writes) or a request
 * that was never made proves the relay did not store it. Anything else (a connection reset or refused, a timeout, a 5xx, an answer
 * that could not be read) may have reached it after it stored the vote: `maybeReceived`, so the vote is taken back there before it
 * is discarded or replaced (withdraw.ts). Those, rate limits and a full or Core-less relay are retried (on another relay when there
 * is one); a relay saying Core already has this vote counts as sent; refusals are final, in plain words.
 */
export function classifySubmitError(e: unknown, relay: string): SubmitOutcome {
  const host = relayHost(relay);
  if (e instanceof RelayNotSentError) return { kind: 'retry', text: `${host}: ${e.message}`, tryOther: true };
  if (!relayRefused(e)) {
    const after = e instanceof RelayError && e.retryAfterS ? { afterS: e.retryAfterS } : {};
    return { kind: 'retry', text: lostAnswerText(e, host), ...after, tryOther: true, maybeReceived: true };
  }
  const code = e.code;
  if (e.status === 429 || RELAY_BUSY.has(code)) {
    return { kind: 'retry', text: `${host}: ${e.message}`, ...(e.retryAfterS ? { afterS: e.retryAfterS } : {}), tryOther: true };
  }
  if (code === 'already-current') return { kind: 'sent', text: 'Core already has this vote' };
  if (code === 'newer-vote-in-core') return { kind: 'final', status: 'replaced', text: 'Core already has a vote of this masternode with the same or a later time' };
  if (code === 'later-vote-held') return { kind: 'final', status: 'failed', text: `${host} already holds a later-timed vote of this masternode on this proposal (cast from another device?); cancel that one, then vote again` };
  // one relay's Core or masternode list lags (a brand-new proposal or masternode): another relay, or this one later, may accept it
  if (code === 'unknown-proposal' || code === 'unknown-mn') return { kind: 'retry', text: `${host}: ${e.message}`, tryOther: true };
  return { kind: 'final', status: 'failed', text: `${host} refused it: ${e.message}` };
}

/** The cancel button's words for a vote, or null when it cannot be cancelled from here. */
export function cancelAction(v: WatchedVote): string | null {
  if (v.cancelSig && (v.status === 'queued' || v.status === 'held')) return 'Try cancelling again';
  if (mayBeAtRelay(v)) return 'Cancel this vote';
  if (v.status !== 'queued' || v.restored) return null;
  return neverLeft(v) ? 'Discard' : 'Cancel this vote';
}

/** Whether a failed POST /v1/votes may have left the vote at the relay (its answer was lost). */
export const maybeReceived = (e: unknown, relay: string): boolean => {
  const c = classifySubmitError(e, relay);
  return c.kind === 'retry' && !!c.maybeReceived;
};

/** "Vote No with 2 masternodes" */
export function voteButtonText(outcome: 1 | 2 | 3 | 0, count: number, deferred: boolean): string {
  if (!outcome) return 'Choose Yes, No or Abstain';
  const what = OUTCOME_NAME[outcome][0]!.toUpperCase() + OUTCOME_NAME[outcome].slice(1);
  return `${deferred ? 'Schedule' : 'Vote'} ${what} with ${count} masternode${count === 1 ? '' : 's'}`;
}

/** Whether a relay ever handed this vote to Core (it may count even if a relay holds or cancelled it now). */
export function everLeft(v: Pick<WatchedVote, 'status' | 'relayStatus' | 'relayInfo'>): boolean {
  const relays = new Set([...Object.keys(v.relayInfo ?? {}), ...Object.keys(v.relayStatus ?? {})]);
  if (!relays.size) return v.status === 'broadcast'; // e.g. a relay answered "Core already has it"
  return [...relays].some((r) => {
    const i = v.relayInfo?.[r];
    if (i?.maybeSent != null) return i.maybeSent; // the relay knows (an explicit false wins)
    const s = v.relayStatus?.[r];
    return !!i?.broadcastAt || i?.lastError === 'not-visible' || s === 'sending' || s === 'maybe-broadcast' || s === 'broadcast' || s === 'confirmed';
  });
}

/** Applies what a relay said about a vote to our record (refs, per-relay status and details, and the vote's own status). */
export function applyRelayState(v: WatchedVote, relay: string, st: RelayVoteState): WatchedVote {
  const refs = v.refs.some((r) => r.relay === relay && r.id === st.id) ? v.refs : [...v.refs.filter((r) => r.relay !== relay), { relay, id: st.id }];
  const relayStatus = { ...v.relayStatus, [relay]: st.status };
  const relayInfo = {
    ...v.relayInfo,
    [relay]: { releaseAt: st.releaseAt, nextAttemptAt: st.nextAttemptAt, holdReason: st.holdReason, lastError: st.lastError, broadcastAt: st.broadcastAt, sameAsCurrent: st.sameAsCurrent, maybeSent: st.maybeSent },
  };
  const next: WatchedVote = { ...v, refs, relayStatus, relayInfo };
  // the bridge decides confirmed / replaced; relays only move a vote along or end it
  if (v.status === 'confirmed' || v.status === 'replaced' || v.status === 'cancelled' || v.withdrawn) return next;
  const all = Object.values(relayStatus);
  // a cancel still has to reach a relay that may hold the vote from a lost answer (maybeAt): the answers of the others do not end it
  if (v.cancelSig && v.maybeAt?.length && all.every((x) => x === 'cancelled' || x === 'failed' || x === 'superseded')) return { ...next, status: 'queued' };
  // A vote a relay may have handed to Core (`maybeSent`; on relays without that field: broadcastAt, or a broadcast moved back to
  // `held` as not-visible) is never "Cancelled", "Failed" or "Replaced" because it is final at the relay now: it may already count.
  if (all.every((x) => x === 'cancelled' || x === 'failed' || x === 'superseded') && everLeft({ ...v, relayInfo })) return { ...next, status: 'broadcast', withdrawn: true };
  // maybe-broadcast: the relay may already have put it in Core, so it is treated as sent (it cannot be cancelled)
  if (all.some((x) => x === 'broadcast' || x === 'confirmed' || x === 'sending' || x === 'maybe-broadcast')) return { ...next, status: 'broadcast', lastSendError: undefined };
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

/**
 * Where "Vote now" sends (D-070): ONE relay at a time, the others only take over when it fails. `health` is the last check per relay
 * (missing: not checked yet).
 */
export function relaySummary(relays: readonly string[], health: Readonly<Record<string, { ok: boolean } | undefined>>): { text: string; warn: boolean } {
  if (!relays.length) return { text: 'No relay is configured (Settings).', warn: true };
  const up = relays.filter((r) => health[r]?.ok);
  const down = relays.filter((r) => health[r] && !health[r]!.ok);
  const first = up[0] ?? relays.find((r) => !health[r]) ?? relays[0]!;
  const backups = relays.length - 1;
  const via = `through ${relayHost(first)}${backups ? ` (${backups === 1 ? 'another relay takes over' : `${backups} others take over`} if it fails)` : ''}`;
  if (down.length === relays.length) return { text: `Signed in your browser and sent ${via}. No relay answered its last check, so sending may wait until one does.`, warn: true };
  return { text: `Signed in your browser and sent ${via}.`, warn: false };
}

/** How long until "Vote now" shows up (D-071): the bridge's vote set refreshes once per block. */
export const VOTE_NOW_DELAY_TEXT = 'The network usually shows it within a few minutes (the vote list refreshes with each block, about 2.5 minutes apart).';
