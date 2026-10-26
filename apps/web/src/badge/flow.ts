// The MN badge as part of "Add your masternodes" (MasternodesPage) and the keyring card: whether the issuer can issue now or from
// which block, this identity's badge status, and one request from a keyring key. Uses the badge client's own machinery
// (checkKeyAvailability, requestBadge, the scheduler): nothing here talks to the issuer.
import { useEffect, useState } from 'react';
import { clientPostingWindow, displayWindow, EPOCH_PARAMS, epochOf, epochStart, type EpochParams, type PrivacyMode } from '@govhub/badge';
import { encodeWif } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { assertUsableKey, type OwnedMasternode } from '../voting/masternodes.ts';
import { checkKeyAvailability, etaSeconds, isActive, isHeld, lapseHeight, nearLapse, type BadgeJob, type KeyAvailability } from './client.ts';
import { COOLDOWN_MS } from './visit.ts';
import { useNow } from '../ui/vote/common.tsx';
import type { TrustedIssuer } from './config.ts';
import { useBadgeCtx, useBadges } from './context.tsx';

/** "6 hours", "45 minutes", "3 days" (estimates: the caller says "about"). */
export function inTime(s: number): string {
  const h = s / 3600;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h >= 1) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  const m = Math.max(1, Math.round(s / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** "block 1,579,392 (in about 6 hours)" */
export function eta(height: number, now: number | null): string {
  if (now === null) return `block ${formatInt(height)}`;
  if (height <= now) return `block ${formatInt(height)} (now)`;
  return `block ${formatInt(height)} (in about ${inTime(etaSeconds(height, now))})`;
}

/** A wall-clock time (ms) as "14:05"; the callers add how far away it is. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The job only moves while the app is open and the same identity is signed in with the same key (D-081, D-616). */
export const ADVANCES_WHEN = 'A badge request moves on only while govhub is open in this browser and you are signed in as this identity with the same sign-in key.';

/**
 * The issuer's first key epoch has no earlier token count, so the client posts a private badge for it without the crowd check:
 * says so for a private-mode request for `epoch` (empty otherwise).
 */
export function noCrowdText(av: KeyAvailability, issuerName: string, epoch: number): string {
  return av.firstKeyEpoch === epoch
    ? `Epoch ${epoch} is ${issuerName}’s first, so there is no earlier token count to check the crowd against: a Private badge for it is posted without that check and may stand out among few others.`
    : '';
}

/** The key pre-check in words (D-044): which modes work now, and from when Standard does. */
export function availabilityText(av: KeyAvailability, issuerName: string, p: EpochParams): string | null {
  const std = av.modes.find((m) => m.mode === 'standard');
  const priv = av.modes.find((m) => m.mode === 'private');
  const noCrowd = priv?.ok ? noCrowdText(av, issuerName, priv.epoch) : '';
  if (std?.ok && priv?.ok) return noCrowd || null;
  const first = av.firstKeyEpoch;
  const firstText =
    first === null
      ? `${issuerName} has published no key for the next few epochs.`
      : `${issuerName}’s first key is for epoch ${first}, which starts at ${eta(epochStart(p, first), av.height)}.`;
  if (std && !std.ok && priv?.ok) return `Standard is not available yet: ${issuerName} has no key for the current epoch, ${std.epoch} (${std.problem}). ${firstText} Private works now: it asks for a token for epoch ${priv.epoch}, and the badge appears early in that epoch.${noCrowd && ` ${noCrowd}`}`;
  if (std?.ok && priv && !priv.ok) return `Private is not available yet: ${issuerName} has no key for epoch ${priv.epoch} (${priv.problem}). Standard works now.`;
  return `No badge can be requested from ${issuerName} right now: it has no key for epoch ${std?.epoch ?? '?'} or ${priv?.epoch ?? '?'}. ${firstText}`;
}

/**
 * Whether a request in `mode` can be made, and for which epoch:
 *   now      the issuer has a key for the epoch the mode asks for now
 *   later    it has none yet, but its first key (within reach) is for a later epoch: the request is scheduled for that one, and
 *            the badge can appear from `from`, that epoch's first block
 *   blocked  nothing can be scheduled in this mode (no key within reach, or only for an earlier epoch than the mode asks for)
 */
type Readiness = { kind: 'now'; epoch: number } | { kind: 'later'; epoch: number; from: number } | { kind: 'blocked'; noKeys: boolean };

export function readiness(av: KeyAvailability, mode: PrivacyMode, p: EpochParams): Readiness {
  const m = av.modes.find((x) => x.mode === mode);
  if (m?.ok) return { kind: 'now', epoch: m.epoch };
  const first = av.firstKeyEpoch;
  if (m && first !== null && first > m.epoch) return { kind: 'later', epoch: first, from: epochStart(p, first) };
  return { kind: 'blocked', noKeys: first === null };
}

/** The first block a pending badge can be fetched or appear at: a Standard request's height, else Private's posting window. */
function badgeFrom(j: BadgeJob, p: EpochParams): number {
  if (j.state === 'token') return j.postAt ?? clientPostingWindow(p, j.epoch).from;
  return j.mode === 'standard' ? j.requestAt : clientPostingWindow(p, j.epoch).from;
}

/**
 * This identity's badge with one issuer:
 *   shown    readers show it (proved read), or this browser posted one whose display window is still open
 *   held     a Standard token is in this browser, waiting for the next post or reaction (or Register now); `lapseAt` is its
 *            last block, `lapsing` when that is near (lapseNudgeBlocks)
 *   pending  a request in this browser is scheduled, or a Private token waits for its height
 *   none     neither; `last` is the newest finished job (failed or expired), to say why
 */
type BadgeStatus =
  | { kind: 'shown'; issuer: string; until: number | null }
  | { kind: 'held'; job: BadgeJob; lapseAt: number; lapsing: boolean }
  | { kind: 'pending'; job: BadgeJob; from: number }
  | { kind: 'none'; last?: BadgeJob };

function badgeStatus(jobs: readonly BadgeJob[], shownBy: readonly string[], height: number | null, issuer: Pick<TrustedIssuer, 'identityId' | 'name'> | undefined, p: EpochParams): BadgeStatus {
  const mine = issuer ? jobs.filter((j) => j.issuer.identityId === issuer.identityId) : [];
  const posted = mine.filter((j) => j.state === 'posted' && (height === null || height <= displayWindow(p, j.epoch).to)).sort((a, b) => b.epoch - a.epoch)[0];
  if (posted) return { kind: 'shown', issuer: posted.issuer.name, until: displayWindow(p, posted.epoch).to };
  if (shownBy.length) return { kind: 'shown', issuer: issuer && shownBy.includes(issuer.name) ? issuer.name : shownBy[0]!, until: null };
  // the newest held token (an older one is superseded once saved)
  const held = mine.filter(isHeld).sort((a, b) => b.epoch - a.epoch)[0];
  if (held) {
    return { kind: 'held', job: held, lapseAt: lapseHeight(p, held.epoch), lapsing: nearLapse(p, held.epoch, height) };
  }
  const active = mine.filter(isActive).sort((a, b) => a.epoch - b.epoch)[0];
  if (active) return { kind: 'pending', job: active, from: badgeFrom(active, p) };
  const last = mine.filter((j) => j.state === 'failed' || j.state === 'expired').sort((a, b) => b.epoch - a.epoch)[0];
  return last ? { kind: 'none', last } : { kind: 'none' };
}

/** The honest note next to Register now (PLAN §8.10). */
export const registerNowNote = (issuerName: string): string =>
  `Posting now lets ${issuerName}’s issuer match your masternode to this account by timing. Waiting until you next post or react hides that better; the longer the gap, the better.`;

/**
 * ms until a scheduled job's request may go (0: now, give or take the first-tick delay of a visit): the quiet half hour after this
 * browser's last write or request, plus the job's own random extra (visit.ts).
 */
export const fetchWaitMs = (j: BadgeJob, quietSince: number, now = Date.now()): number => Math.max(0, quietSince + COOLDOWN_MS + (j.quietExtraMs ?? 0) - now);

/** "We'll fetch your badge in about 50 minutes, at a random time, so the request is harder to match to your account." */
export const fetchWaitText = (waitMs: number): string =>
  `We’ll fetch your badge in about ${inTime(waitMs / 1000)}, at a random time, so the request is harder to match to your account.`;

/** The held token's nudge; `postWaitMs`: the cooldown left after its request (a write before then does not carry it). */
export function heldText(postWaitMs: number): string {
  const after = postWaitMs > 0 ? ` after about ${clockTime(Date.now() + postWaitMs)}` : '';
  return `Your MN badge is ready. It will appear the next time you post or react${after}. The longer you wait, the harder it is for anyone to match it to your masternode.`;
}

/** A Register now call as the error text its UI shows, or null when it posted (what RegisterNow's `onRegister` resolves with). */
export const registerNowResult = (posting: Promise<void>): Promise<string | null> => posting.then(() => null, (e: unknown) => errText(e));

/** Only in this browser: a write from another device does not carry it. */
export const HELD_HERE = 'It’s kept in this browser only: posting from another device won’t publish it.';

/** "3 days": how long until a held token lapses at block `lapseAt`. */
export const lapseIn = (lapseAt: number, height: number | null): string => (height === null ? 'a few days' : inTime(etaSeconds(lapseAt, height)));

/** "Your badge will lapse in 3 days unless registered." */
export const lapseText = (lapseAt: number, height: number | null): string => `Your badge will lapse in ${lapseIn(lapseAt, height)} unless registered.`;

/** The masternode a badge is asked with: one only (more would tell the issuer they belong together), a valid one, list-confirmed first. */
export function pickBadgeMn(owned: readonly OwnedMasternode[], keyIndex?: number): OwnedMasternode | undefined {
  const usable = owned.filter((m) => m.valid && (keyIndex === undefined || m.keyIndex === keyIndex));
  return usable.find((m) => m.provenance.key === 'sml') ?? usable[0];
}

/** A copy of a keyring key as WIF for the badge job (which stores it encrypted until the request is sent, then deletes it). */
export function badgeWif(key: { privateKey: Uint8Array; compressed: boolean } | undefined, network: 'mainnet' | 'testnet'): string {
  if (!key) throw new Error('That voting key is no longer in the keyring.');
  assertUsableKey(key.privateKey);
  return encodeWif(key.privateKey, key.compressed, network);
}

type Availability = { state: 'checking' } | { state: 'error'; message: string } | { state: 'ready'; av: KeyAvailability };

/** The issuer's keys per mode, from proved issuerKey reads only (nothing goes to the issuer); checked again when the epoch changes. */
export function useKeyAvailability(issuer: TrustedIssuer | undefined): (Availability & { retry(): void }) | null {
  const { registry } = useApp();
  const { session } = useForum();
  const { reader, coreHeight } = useBadgeCtx();
  const net = registry.platformNetwork;
  const epochNow = coreHeight === null ? null : epochOf(EPOCH_PARAMS[net], coreHeight);
  const [tries, setTries] = useState(0);
  const [avail, setAvail] = useState<{ issuerId: string; a: Availability } | null>(null);
  useEffect(() => {
    if (!reader || !session || !issuer) return setAvail(null);
    let live = true;
    setAvail({ issuerId: issuer.identityId, a: { state: 'checking' } });
    (async () => {
      const height = await reader.coreHeight();
      const av = await checkKeyAvailability((i, e) => reader.key(i, e), issuer, net, height);
      if (live) setAvail({ issuerId: issuer.identityId, a: { state: 'ready', av } });
    })().catch((e) => live && setAvail({ issuerId: issuer.identityId, a: { state: 'error', message: errText(e) } }));
    return () => {
      live = false;
    };
  }, [reader, session, issuer, net, epochNow, tries]);
  const a = avail?.issuerId === issuer?.identityId ? (avail?.a ?? null) : null;
  return a && { ...a, retry: () => setTries((n) => n + 1) };
}

export interface MnBadge {
  /** badges work here: live data, the contract deployed, a trusted issuer, signed in */
  usable: boolean;
  /** why not, when not */
  unusableText: string | null;
  issuer: TrustedIssuer | undefined;
  p: EpochParams;
  height: number | null;
  availability: ReturnType<typeof useKeyAvailability>;
  ready: Readiness | null;
  /** the issuer's keys are checked and a request can be made now or scheduled for its first key's epoch */
  canRequest: boolean;
  status: BadgeStatus;
  privacy: PrivacyMode;
  setPrivacy(m: PrivacyMode): void;
  /** schedules the request in the chosen mode, for the issuer's first key's epoch when it has none for now */
  request(wif: string, proTxHash: string): Promise<BadgeJob>;
  /** Cancel a pending request (D-604): deletes it and the voting key stored with it; `cancelled` says what happened */
  cancel(job: BadgeJob): Promise<void>;
  /** what the last cancel did, until the next request */
  cancelled: string | null;
  retry(job: BadgeJob): void;
  /** Register now: posts a held token at once; resolves with an error text, or null */
  registerNow(job: BadgeJob): Promise<string | null>;
  /** ms until this scheduled job's request may go out (0: now) */
  fetchWait(job: BadgeJob): number;
  /** ms left of the cooldown after the last request: a held badge goes with a write only after it */
  postWait: number;
}

export function useMnBadge(): MnBadge {
  const { registry, mode } = useApp();
  const { session } = useForum();
  const ctx = useBadgeCtx();
  const net = registry.platformNetwork;
  const p = EPOCH_PARAMS[net];
  const issuer = ctx.trust.find((t) => t.enabled);
  const availability = useKeyAvailability(issuer);
  const me = session?.identityId;
  const { byOwner } = useBadges(me ? [me] : []);
  const height = ctx.coreHeight ?? (availability?.state === 'ready' ? availability.av.height : null);
  let unusableText: string | null = null;
  if (mode !== 'live' || !ctx.contractId || !ctx.reader) unusableText = 'MN badges need live data on a network where the badge contract is deployed (testnet for now).';
  else if (!session) unusableText = 'Sign in to get an MN badge.';
  else if (!issuer) unusableText = 'Your list of badge issuers has none turned on (Settings).';
  const ready = availability?.state === 'ready' ? readiness(availability.av, ctx.privacy, p) : null;
  const [cancelled, setCancelled] = useState<string | null>(null);
  const now = useNow(30_000); // the "fetching in ~N min" countdown
  return {
    usable: unusableText === null,
    unusableText,
    issuer,
    p,
    height,
    availability,
    ready,
    canRequest: ready !== null && ready.kind !== 'blocked',
    status: badgeStatus(ctx.jobs, (me && byOwner.get(me)) || [], height, issuer, p),
    privacy: ctx.privacy,
    setPrivacy: ctx.setPrivacy,
    request: (wif, proTxHash) => {
      setCancelled(null);
      return ctx.requestBadge(wif, proTxHash, { ...(issuer ? { issuer } : {}), keepKey: false, mode: ctx.privacy, ...(ready?.kind === 'later' ? { epoch: ready.epoch } : {}) });
    },
    cancel: async (job) => {
      try {
        await ctx.removeJob(job.id);
      } catch (e) {
        return setCancelled(`Not cancelled: ${errText(e)}`);
      }
      setCancelled(
        job.state === 'token'
          ? `Cancelled: the badge for epoch ${job.epoch} is not posted, and its token is deleted from this browser. The issuer already counted this masternode for that epoch, so it can ask again only from the next epoch.`
          : `Cancelled: the request for epoch ${job.epoch} and the voting key stored with it are deleted from this browser.`,
      );
    },
    cancelled,
    retry: (job) => ctx.retryJob(job.id),
    registerNow: (job) => registerNowResult(ctx.registerNow(job.id)),
    fetchWait: (job) => fetchWaitMs(job, ctx.quietSince, now),
    postWait: ctx.postWait,
  };
}
