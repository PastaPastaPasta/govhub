// Getting an MN badge (PLAN §8.5), as a small state machine per job, in one of three privacy modes (PrivacyMode):
//   standard  token for the CURRENT epoch, requested and posted at once: the badge shows within minutes, and the issuer could link
//             the masternode to the identity by timing (we keep no records that would let us)
//   private   token for the NEXT epoch at a random height in this epoch, badge at a random height in [S(E), S(E)+W], kept apart
//             from this browser's other Platform writes, and only if enough others took part
//   extra     as private, with the badge spread over the first half of the epoch
//
//
//   scheduled --(core height >= requestAt, in the issuance window of E)--> token --(height >= postAt)--> posted
//        \--> expired (window closed) / failed (refused, or the issuer's answer did not verify: the issuer is flagged)
//
// requestBadge(): derives the epoch E itself from Platform's proved core height, takes the issuer's key for E only from the proved
// issuerKey document (reader rules), builds the badge message for the signed-in identity, blinds it in the worker with fresh
// CSPRNG r and prefix, and picks a uniformly random request height in what is left of E's issuance window. Nothing is sent yet.
// step(): at the request height, a challenge and the token request (signed with the MN VOTING key: a pasted WIF, or a signer the
// keyring registered) go to the issuer from the worker; the answer is finalized and verified. At a uniformly random height in
// [S(E), S(E)+W] the badge document is posted with the identity's own key. One job per (issuer, epoch): an identity can show only
// one badge per issuer, and asking for more would only tell the issuer which MNs belong together.
import {
  base64ToBytes,
  BLOCK_SECONDS,
  buildTokenRequestFor,
  bytesToBase64,
  displayWindow,
  epochStart,
  epochLength,
  EPOCH_PARAMS,
  fromHex,
  idToBytes,
  mnBadgeData,
  pickPostHeight,
  pickRequestHeight,
  prepareBadge,
  privateRequestWindow,
  requestableEpoch,
  toHex,
  type BadgeNetwork,
  type EpochParams,
  type HeightRange,
  type PrivacyMode,
} from '@govhub/badge';
import type { TrustedIssuer } from './config.ts';
import type { KeyLookup } from './reader.ts';
import type { badgeWorker } from './workerClient.ts';

/** Signs a message with Dash `signmessage` semantics using the MN's voting key; returns the base64 signature. */
export type VotingSigner = (message: string) => Promise<string>;

export type JobState = 'scheduled' | 'token' | 'posted' | 'expired' | 'failed';

export interface BadgeJob {
  v: 1;
  id: string;
  net: BadgeNetwork;
  contractId: string;
  ownerId: string;
  issuer: Pick<TrustedIssuer, 'name' | 'identityId' | 'url'>;
  epoch: number;
  mode: PrivacyMode;
  /** hex SHA256(spki) and the spki (base64), from the proved issuerKey */
  keyId: string;
  spki: string;
  /** display-order hex */
  proTxHash: string;
  /** cleared once the token is finalized */
  preparedMsg?: string;
  blindedMsg?: string;
  inv?: string;
  msgPrefix: string;
  requestAt: number;
  /** 'wif': key-paste path, the key is stored encrypted with the job; 'external': a signer the keyring registers at run time */
  signer: { kind: 'wif'; wif: string } | { kind: 'external' };
  /** keep the voting key after the request, to renew every epoch */
  keepKey: boolean;
  state: JobState;
  sig?: string;
  postAt?: number;
  badgeId?: string;
  note?: string;
  /** the issuer returned something that did not verify */
  issuerFlagged?: boolean;
  attempts: number;
  /** after a failed attempt: not before this time (ms), a random 1-3 h later */
  retryAt?: number;
}

export interface ClientDeps {
  net: BadgeNetwork;
  contractId: string;
  ownerId: string;
  /** the accepted (proved, rule-checked) key of an issuer for an epoch */
  issuerKey(issuer: TrustedIssuer, epoch: number): Promise<KeyLookup>;
  worker: typeof badgeWorker;
  /** signmessage with a WIF on this network */
  signWithWif(wif: string, message: string): string;
  externalSigner(proTxHash: string): VotingSigner | undefined;
  /** creates the mnBadge document with the session's key; returns its id */
  postBadge(data: Record<string, Uint8Array | number>): Promise<string>;
  /** whether the identity already has a badge document for (issuer, epoch) */
  hasBadge(issuerId: string, epoch: number): Promise<boolean>;
  /** the issuer is (still) on the trust list and enabled */
  trusted(issuerId: string): boolean;
  /** tokensIssued from the issuer's valid issuerReport for the epoch, or null while there is none */
  reportedTokens(issuer: Pick<TrustedIssuer, 'identityId'>, epoch: number): Promise<number | null>;
  /** a badge is posted only when at least this many tokens were issued for its epoch */
  minAnonymitySet: number;
}

export class BadgeRequestError extends Error {}

const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));
const ACTIVE: readonly JobState[] = ['scheduled', 'token'];

export interface RequestOptions {
  issuer: TrustedIssuer;
  keepKey?: boolean;
  /** default 'standard' */
  mode?: PrivacyMode;
  /** tests and the live script only: request at once instead of at a random height */
  immediate?: boolean;
}

/** Where a job's request may go out: Standard during its (current) epoch, the private modes during the epoch before. */
export function requestWindow(p: EpochParams, epoch: number, mode: PrivacyMode): HeightRange {
  return mode === 'standard' ? { from: epochStart(p, epoch), to: epochStart(p, epoch + 1) - p.boundaryMarginBlocks } : privateRequestWindow(p, epoch);
}

export async function createJob(d: ClientDeps, jobs: readonly BadgeJob[], voting: string | VotingSigner, proTxHashHex: string, coreHeight: number, o: RequestOptions): Promise<BadgeJob> {
  const proTxHash = proTxHashHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(proTxHash)) throw new BadgeRequestError('The proTxHash must be 64 hex characters.');
  if (typeof voting === 'string' && !voting.trim()) throw new BadgeRequestError('Paste the MN voting key (WIF).');
  const p = EPOCH_PARAMS[d.net];
  const mode = o.mode ?? 'standard';
  let epoch = requestableEpoch(p, coreHeight, mode);
  if (epoch === null) throw new BadgeRequestError('No issuance window is open.');
  // Private modes: with little of the window left the request would go out in this same visit, so ask for the next epoch (H1).
  const w = privateRequestWindow(p, epoch);
  if (mode !== 'standard' && !o.immediate && w.to - Math.max(coreHeight, w.from) < epochLength(p) / 4) epoch++;
  if (jobs.some((j) => j.issuer.identityId === o.issuer.identityId && j.epoch === epoch && j.state !== 'expired' && j.state !== 'failed'))
    throw new BadgeRequestError(`You already have a badge request with ${o.issuer.name} for epoch ${epoch}. One badge per issuer is all an identity can show; asking with more MNs would only tell the issuer they belong together.`);
  const wif = typeof voting === 'string' ? voting.trim() : null;
  if (wif) {
    try {
      d.signWithWif(wif, 'govhub key check'); // throws on a malformed WIF or another network's key
    } catch {
      throw new BadgeRequestError(`That is not a ${d.net} private key in WIF format.`);
    }
  }
  const { key, problem } = await d.issuerKey(o.issuer, epoch);
  if (!key) throw new BadgeRequestError(`${o.issuer.name} has no valid key for epoch ${epoch} on Platform (${problem}).`);
  if (key.revokedFrom !== null) throw new BadgeRequestError(`${o.issuer.name} revoked its key for epoch ${epoch}.`);
  const prepared = prepareBadge(key.key, idToBytes(d.ownerId));
  const spki = bytesToBase64(key.key.spki);
  const preparedMsg = bytesToBase64(prepared.preparedMsg);
  const blinded = await d.worker({ kind: 'blind', spki, preparedMsg });
  // Standard: at once (the request window starts at S(E) for a job made in E's last blocks); private: a random height
  const requestAt = mode === 'standard' ? Math.max(coreHeight, epochStart(p, epoch)) : o.immediate ? coreHeight : (pickRequestHeight(p, epoch, coreHeight) ?? coreHeight);
  return {
    v: 1,
    id: randomId(),
    net: d.net,
    contractId: d.contractId,
    ownerId: d.ownerId,
    issuer: { name: o.issuer.name, identityId: o.issuer.identityId, url: o.issuer.url },
    epoch,
    mode,
    keyId: toHex(key.key.keyId),
    spki,
    proTxHash,
    preparedMsg,
    blindedMsg: blinded.blindedMsg,
    inv: blinded.inv,
    msgPrefix: bytesToBase64(prepared.msgPrefix),
    requestAt,
    signer: wif ? { kind: 'wif', wif } : { kind: 'external' },
    keepKey: o.keepKey ?? false,
    state: 'scheduled',
    attempts: 0,
  };
}

/** A failed attempt waits a random 1 to 3 hours, so one unreachable issuer does not take every quiet half hour. */
function backoff(j: BadgeJob, note: string): BadgeJob {
  return { ...j, note, retryAt: Date.now() + 3_600_000 + Math.floor(Math.random() * 7_200_000) };
}

/** Errors the issuer answers that end a job (the rest are retried while the window is open). */
const FINAL: Record<string, string> = {
  'already-issued': 'This masternode already got a token from this issuer for this epoch (another browser or an earlier request).',
  unauthorized: 'The issuer did not accept the signature: it is not this masternode’s voting key.',
  'not-eligible': 'The masternode is not eligible this epoch',
  'wrong-network': 'The issuer serves another network.',
  'wrong-issuer': 'The issuer URL belongs to another issuer identity.',
  'wrong-key': 'The issuer signs with a different key than the one it published for this epoch.',
  'bad-request': 'The issuer refused the request',
};

/** Advances one job given the current core height. Pure apart from the deps; returns the updated job. */
export async function step(d: ClientDeps, job: BadgeJob, height: number): Promise<BadgeJob> {
  const p = EPOCH_PARAMS[job.net];
  const j: BadgeJob = { ...job };
  if (j.state === 'scheduled') {
    if (height >= requestWindow(p, j.epoch, j.mode).to)
      return wipe({
        ...j,
        state: 'expired',
        note:
          j.mode === 'standard'
            ? 'The epoch ended before the request could be sent (the app was closed, or the issuer was unreachable).'
            : 'The request window closed before the request could be sent: the app was not open during a quiet half hour (no posts, comments or other requests from this browser), or the issuer was unreachable.',
      });
    if (height < j.requestAt) return j;
    if (!d.trusted(j.issuer.identityId)) return { ...j, note: `${j.issuer.name} is not on your trust list (or is turned off): the request waits.` };
    const keySource = j.signer;
    const signer: VotingSigner | undefined = keySource.kind === 'wif' ? async (m: string) => d.signWithWif(keySource.wif, m) : d.externalSigner(j.proTxHash);
    if (!signer) return { ...j, note: 'Waiting for the voting key: unlock the MN keyring.' };
    j.attempts++;
    try {
      const { nonce } = await d.worker({ kind: 'challenge', url: j.issuer.url });
      const request = await buildTokenRequestFor(
        { net: j.net, issuerId: idToBytes(j.issuer.identityId), epoch: j.epoch, keyId: fromHex(j.keyId), proTxHash: fromHex(j.proTxHash), nonce: fromHex(nonce) },
        base64ToBytes(j.blindedMsg!),
      );
      const signature = await signer(request);
      const { answer } = await d.worker({ kind: 'token', url: j.issuer.url, request, signature, blindedMsg: j.blindedMsg! });
      if (!answer.ok) {
        if (answer.error === 'wrong-epoch') {
          // an issuer whose node lags is still on an earlier epoch: try again later
          if (answer.issuingEpoch !== undefined && answer.issuingEpoch < j.epoch) return backoff(j, `The issuer is still on epoch ${answer.issuingEpoch}; trying again later.`);
          return wipe({ ...j, state: 'expired', note: `The issuer is no longer issuing for epoch ${j.epoch}.` });
        }
        const final = FINAL[answer.error];
        if (final) return wipe({ ...j, state: 'failed', note: final.endsWith('.') ? final : `${final}: ${answer.message}` });
        return backoff(j, `The issuer is not available (${answer.message}); trying again later.`);
      }
      let sig: string;
      try {
        sig = (await d.worker({ kind: 'finalize', spki: j.spki, preparedMsg: j.preparedMsg!, blindSig: answer.blindSig, inv: j.inv! })).sig;
      } catch {
        return wipe({ ...j, state: 'failed', issuerFlagged: true, note: `${j.issuer.name} answered with a signature that does not verify. The request is void; consider removing this issuer from your trust list.` });
      }
      const done = wipe({ ...j, state: 'token', sig, note: undefined });
      return { ...done, postAt: pickPostHeight(p, j.epoch, height, j.mode) };
    } catch (e) {
      return backoff(j, `Could not reach the issuer (${(e as Error).message}); trying again later.`);
    }
  }
  if (j.state === 'token') {
    if (height > displayWindow(p, j.epoch).to) return wipe({ ...j, state: 'expired', note: 'The badge was never posted and its display window is over.' });
    const postAt = j.postAt ?? pickPostHeight(p, j.epoch, height, j.mode);
    if (height < postAt) return { ...j, postAt };
    if (!d.trusted(j.issuer.identityId)) return { ...backoff(j, `${j.issuer.name} is not on your trust list (or is turned off): the badge is not posted.`), postAt };
    try {
      // a key revoked since the token was issued voids the badge for readers: do not post it (N12)
      const { key } = await d.issuerKey({ ...j.issuer, enabled: true }, j.epoch);
      if (!key || key.revokedFrom !== null) return wipe({ ...j, state: 'expired', note: `${j.issuer.name}'s key for epoch ${j.epoch} is no longer valid: the badge is not posted.` });
      // Private modes: a badge among very few stands out (review R1). Tokens for E can be issued until S(E+1), so E's own report
      // comes too late; the crowd size is read from the issuer's report for E-1 (published from S(E)). No report yet: wait for
      // it until its window has passed; an issuer without one (new, or for that epoch) is posted without the check.
      if (j.mode !== 'standard') {
        const tokens = await d.reportedTokens(j.issuer, j.epoch - 1);
        if (tokens === null && height <= epochStart(p, j.epoch) + p.graceBlocks) return { ...backoff(j, `Waiting for ${j.issuer.name}'s token count for epoch ${j.epoch - 1} before posting.`), postAt };
        if (tokens !== null && tokens < d.minAnonymitySet)
          return wipe({ ...j, state: 'expired', note: `Only ${tokens} token${tokens === 1 ? ' was' : 's were'} issued in epoch ${j.epoch - 1}: a badge among so few would stand out, so it is not posted. Next time, more masternodes may take part (or use Standard mode).` });
      }
      if (await d.hasBadge(j.issuer.identityId, j.epoch)) return wipe({ ...j, state: 'posted', note: 'Already posted.' });
      const id = await d.postBadge(mnBadgeData({ issuerId: idToBytes(j.issuer.identityId), epoch: j.epoch, keyId: fromHex(j.keyId), msgPrefix: base64ToBytes(j.msgPrefix), sig: base64ToBytes(j.sig!) }));
      return wipe({ ...j, state: 'posted', badgeId: id, note: undefined });
    } catch (e) {
      return { ...backoff(j, `Posting the badge failed (${(e as Error).message}); trying again later.`), postAt };
    }
  }
  return j;
}

/**
 * Drops what a job no longer needs: the blinding state always; the voting key, and with it the identity-to-masternode link
 * (proTxHash), once the job is done, unless the key is kept for renewal (review L8).
 */
function wipe(j: BadgeJob): BadgeJob {
  const { preparedMsg: _p, blindedMsg: _b, inv: _i, ...rest } = j;
  if (rest.keepKey && rest.signer.kind === 'wif') return rest;
  // once the token is in hand (or the job is over) nothing needs the masternode any more (N10)
  const { sig: _s, ...noSig } = rest;
  return { ...(rest.state === 'token' ? rest : noSig), signer: { kind: 'external' }, proTxHash: '' };
}

export const isActive = (j: BadgeJob): boolean => ACTIVE.includes(j.state);

/** Estimated wall-clock seconds until `height` (display only). */
export const etaSeconds = (height: number, now: number): number => Math.max(0, (height - now) * BLOCK_SECONDS);

/**
 * The renewal job for the epoch after `prev`, if the voting key is kept and that epoch's window is open at `height`.
 * Returns null when nothing is due.
 */
export async function renewal(d: ClientDeps, jobs: readonly BadgeJob[], prev: BadgeJob, height: number, issuer: TrustedIssuer): Promise<BadgeJob | null> {
  if (!prev.keepKey || prev.signer.kind !== 'wif' || !prev.proTxHash || (prev.state !== 'token' && prev.state !== 'posted')) return null;
  const p = EPOCH_PARAMS[prev.net];
  const next = prev.epoch + 1;
  const w = requestWindow(p, next, prev.mode);
  if (height < w.from || height >= w.to) return null;
  if (jobs.some((x) => x.issuer.identityId === prev.issuer.identityId && x.epoch === next)) return null;
  try {
    const job = await createJob(d, jobs, prev.signer.wif, prev.proTxHash, height, { issuer, keepKey: true, mode: prev.mode });
    return job.epoch === next ? job : null; // late in a private window createJob moves on to the epoch after
  } catch {
    return null;
  }
}
