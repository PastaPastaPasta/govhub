// Getting a free starter credit (starter-spec "Flow"): one per masternode (signed with its VOTING key) or per proposal (signed by its
// PAYMENT address), paid by the faucet to the new account's one-time funding address. Pure apart from the deps (tests use fakes).
//
//   1. the key: for each epoch of starterRequestEpochs(EPOCH_PARAMS[platform net], Platform's core height), the PROVED issuerKey of
//      the pinned starter identity that passes acceptIssuerKey and has no revocation; the first one wins. Never a key the issuer or
//      the faucet serves (a key of its own for one user would tag that user's token).
//   2. prepareStarter(key, {net, issuerId, epoch, pubKeyHash}) and blind it in the worker; a challenge from the issuer; the request
//      text (buildStarterRequestFor) binds SHA256(blindedMsg).
//   3. signed with Dash signmessage: the voting key here (the keyring's or a pasted WIF), or the proposal owner in Dash Core (pasted
//      back and checked here against the payment address before it is sent).
//   4. the issuer's blind signature is finalized in the worker (which verifies it) and checked once more against the message.
//   5. redeem: the faucet gets {network, epoch, address, msgPrefix, sig}, nothing about the masternode or proposal.
import { addressOf, hash160, registrationFundingPath, wipe, type Network, type SeedWallet } from '@govhub/auth';
import {
  base64ToBytes, BLOCK_SECONDS, buildStarterRequestFor, bytesToBase64, epochStart, EPOCH_PARAMS, fromHex, idToBytes, importIssuerKey, isStarterKind, prepareStarter, randomBelow, starterKeyUsable, starterRequestEpochs, toHex,
  verifyStarterToken,
  type IssuerKey, type StarterKind,
} from '@govhub/badge';
import { decodeAddress, decodeWif, signMessage, verifyMessage } from '@govhub/verify';
import { issuerErrorText } from '../badge/client.ts';
import type { FaucetAnswer, IssuerAnswer } from '../badge/protocol.ts';
import type { BadgeReader, KeyLookup } from '../badge/reader.ts';
import type { badgeWorker } from '../badge/workerClient.ts';
import type { StarterIssuer } from './config.ts';

export interface StarterDeps {
  network: Network;
  issuer: StarterIssuer;
  faucetUrl: string;
  /** Platform's core chain-locked height, from a proved read */
  coreHeight(): Promise<number>;
  /** the accepted (proved, rule-checked) issuerKey of the starter identity for an epoch */
  issuerKey(epoch: number): Promise<KeyLookup>;
  worker: typeof badgeWorker;
}

/** The deps over a badge reader (proved issuerKey + revocation of the starter identity, reader rules) and the badge worker. */
export function starterDepsFromReader(reader: Pick<BadgeReader, 'coreHeight' | 'key'>, o: { network: Network; issuer: StarterIssuer; faucetUrl: string; worker: StarterDeps['worker'] }): StarterDeps {
  const asTrusted = { name: 'starter', ...o.issuer, enabled: true };
  return { ...o, coreHeight: () => reader.coreHeight(), issuerKey: (epoch) => reader.key(asTrusted, epoch) };
}

export type StarterErrorCode =
  | 'input' | 'no-key' | 'unreachable' | 'expired' | 'already-issued' | 'unauthorized' | 'not-eligible' | 'issuer' | 'bad-answer' | 'bad-signature' | 'faucet' | 'faucet-busy'
  /** issuance for the request's epoch has closed: it can never be resent */
  | 'closed'
  /** the faucet refused this token (its key, or the signature): final only once the token is past its redeem window */
  | 'faucet-rejected';

export class StarterError extends Error {
  constructor(
    message: string,
    readonly code: StarterErrorCode,
    /** trying the same thing again later can work */
    readonly retry = false,
    /** the prepared request (its epoch or key) no longer applies: the next attempt starts over with a new blinding */
    readonly stale = false,
  ) {
    super(message);
    this.name = 'StarterError';
  }
}

/** Text for any error the starter shows. */
export const starterErrorText = (e: unknown, fallback: (e: unknown) => string): string => (e instanceof StarterError ? e.message : fallback(e));

/** "host could not be reached ..." for the faucet as for the issuer. */
const reachText = (url: string, e: unknown, who: 'issuer' | 'faucet') => issuerErrorText(url, e).replace('the issuer may be down', `the ${who} may be down`);

/** A finalized, verified starter token: what is kept (encrypted) until the faucet has paid and the identity exists. */
export interface StarterToken {
  network: Network;
  epoch: number;
  /** base64, 32 bytes */
  msgPrefix: string;
  /** base64 */
  sig: string;
  /** estimated ms (display only): the faucet accepts the token until S(epoch + 2) (starterRedeemEpochs); tokenExpired() decides */
  validUntil: number;
}

/** The new account's one-time funding key (DIP-13 registration path): its hash160 and P2PKH address. The private key is wiped. */
export function fundingTarget(wallet: SeedWallet, identityIndex: number): { pubKeyHash: Uint8Array; address: string } {
  const k = wallet.derive(registrationFundingPath(wallet.network, identityIndex));
  try {
    return { pubKeyHash: hash160(k.publicKey), address: addressOf(k.publicKey, wallet.network) };
  } finally {
    wipe(k.privateKey);
  }
}

/** The starter key for the first epoch the client asks for that has a valid, unrevoked key on Platform. */
export async function findStarterKey(d: StarterDeps): Promise<{ key: IssuerKey; epoch: number; height: number }> {
  const height = await d.coreHeight();
  const epochs = starterRequestEpochs(EPOCH_PARAMS[d.network], height);
  const problems: string[] = [];
  for (const epoch of epochs) {
    const { key, problem } = await d.issuerKey(epoch);
    if (!key) problems.push(`epoch ${epoch}: ${problem ?? 'no valid key'}`);
    else if (key.revokedFrom !== null) problems.push(`epoch ${epoch}: the issuer revoked its key`);
    // a current-epoch key published after the epoch began is skipped (starterKeyUsable): the label must depend on the height only
    else if (!starterKeyUsable(EPOCH_PARAMS[d.network], height, epoch, key.keyCreatedAt)) problems.push(`epoch ${epoch}: its key was published after the epoch began`);
    else return { key: key.key, epoch, height };
  }
  throw new StarterError(`The starter issuer has no valid key on Dash Platform right now (${problems.join('; ')}). Try again later, or pay with DASH.`, 'no-key', true);
}

/**
 * A token request waiting for its signature, or whose answer has not come back yet. Kept (encrypted, store.ts) from just before it is
 * sent until the token is saved: the issuer records the masternode or proposal before it answers, and only a resend of the SAME
 * blinded message gets the signature again, so a reload or crash after the issuer committed must not lose it.
 */
export interface PendingStarter {
  kind: StarterKind;
  /** proTxHash or govHash, lowercase display hex */
  subject: string;
  epoch: number;
  height: number;
  key: IssuerKey;
  pubKeyHash: Uint8Array;
  preparedMsg: string;
  blindedMsg: string;
  inv: string;
  msgPrefix: Uint8Array;
  /** the exact text to sign */
  request: string;
  /** ms: the issuer's challenge expires then */
  expiresAt: number;
}

/** PendingStarter as JSON (bytes as base64 or hex; the key as its SPKI, re-imported and re-checked on load). */
export interface StoredPending {
  v: 1;
  kind: StarterKind;
  subject: string;
  epoch: number;
  height: number;
  spki: string;
  pubKeyHash: string;
  preparedMsg: string;
  blindedMsg: string;
  inv: string;
  msgPrefix: string;
  request: string;
  expiresAt: number;
}

export const toStoredPending = (p: PendingStarter): StoredPending => ({
  v: 1, kind: p.kind, subject: p.subject, epoch: p.epoch, height: p.height, spki: bytesToBase64(p.key.spki), pubKeyHash: toHex(p.pubKeyHash), preparedMsg: p.preparedMsg,
  blindedMsg: p.blindedMsg, inv: p.inv, msgPrefix: bytesToBase64(p.msgPrefix), request: p.request, expiresAt: p.expiresAt,
});

/** Throws on anything malformed (the caller treats that as "nothing stored"). */
export async function fromStoredPending(s: StoredPending): Promise<PendingStarter> {
  if (s?.v !== 1 || !isStarterKind(s.kind) || !isLowerHex64(s.subject) || !Number.isInteger(s.epoch) || typeof s.request !== 'string') throw new Error('unknown pending starter');
  // the same rules as when it was made (canonical RSA-2048/3072); finalize verifies the answer against it again
  const key = await importIssuerKey(base64ToBytes(s.spki));
  return {
    kind: s.kind, subject: s.subject, epoch: s.epoch, height: s.height, key, pubKeyHash: fromHex(s.pubKeyHash), preparedMsg: s.preparedMsg, blindedMsg: s.blindedMsg, inv: s.inv,
    msgPrefix: base64ToBytes(s.msgPrefix), request: s.request, expiresAt: s.expiresAt,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
/** 64 LOWERCASE hex characters (a proTxHash or govHash as the request carries it; lib/bytes.ts isHex64 also takes uppercase). */
export const isLowerHex64 = (s: string): boolean => HEX64.test(s);
const DEFAULT_CHALLENGE_TTL_S = 1800;

/** Finds the key, blinds the token message, asks the issuer for a challenge and builds the request to sign. */
export async function prepareStarterRequest(d: StarterDeps, o: { kind: StarterKind; subject: string; pubKeyHash: Uint8Array }): Promise<PendingStarter> {
  const subject = o.subject.trim().toLowerCase();
  if (!isLowerHex64(subject)) throw new StarterError(o.kind === 'mn' ? 'The proTxHash must be 64 hex characters.' : 'The proposal hash must be 64 hex characters.', 'input');
  const { key, epoch, height } = await findStarterKey(d);
  const issuerId = idToBytes(d.issuer.identityId);
  const prepared = prepareStarter(key, { net: d.network, issuerId, epoch, pubKeyHash: o.pubKeyHash });
  const preparedMsg = bytesToBase64(prepared.preparedMsg);
  const blinded = await d.worker({ kind: 'blind', spki: bytesToBase64(key.spki), preparedMsg });
  const base = { kind: o.kind, subject, epoch, height, key, pubKeyHash: o.pubKeyHash, preparedMsg, blindedMsg: blinded.blindedMsg, inv: blinded.inv, msgPrefix: prepared.msgPrefix };
  return { ...base, ...(await challengeFor(d, base)) };
}

/**
 * A new challenge (and request text) for the SAME blinded message. The issuer signs a repeat of (subject, epoch, blindedMsg) again
 * instead of answering already-issued, so an answer lost on the way (a timeout, a dropped connection) is recovered this way, while a
 * new blinding would find the starter used.
 */
export async function renewChallenge(d: StarterDeps, p: PendingStarter): Promise<PendingStarter> {
  return { ...p, ...(await challengeFor(d, p)) };
}

async function challengeFor(d: StarterDeps, p: Omit<PendingStarter, 'request' | 'expiresAt'>): Promise<Pick<PendingStarter, 'request' | 'expiresAt'>> {
  let challenge;
  try {
    challenge = await d.worker({ kind: 'challenge', url: d.issuer.url, api: 'starter' });
  } catch (e) {
    if (/HTTP 404/.test(String((e as Error)?.message))) throw new StarterError('The issuer does not offer starters right now.', 'issuer');
    throw new StarterError(`Could not get a message to sign: ${reachText(d.issuer.url, e, 'issuer')}.`, 'unreachable', true);
  }
  const request = await buildStarterRequestFor(
    { net: d.network, issuerId: idToBytes(d.issuer.identityId), epoch: p.epoch, keyId: p.key.keyId, kind: p.kind, subject: fromHex(p.subject), nonce: fromHex(challenge.nonce) },
    base64ToBytes(p.blindedMsg),
  );
  // display only: the issuer decides (this browser's clock may be off)
  const expiresAt = (challenge.expiresAt ?? Math.floor(Date.now() / 1000) + DEFAULT_CHALLENGE_TTL_S) * 1000;
  return { request, expiresAt };
}

// ---- signatures --------------------------------------------------------------------------------------------------------------

/** signmessage with a voting key (the keyring's copy; the caller wipes it). */
export const signWithKey = (request: string, key: { privateKey: Uint8Array; compressed: boolean }): string => signMessage(key.privateKey, request, { compressed: key.compressed });

function decodeVotingWif(wif: string, network: Network): { privKey: Uint8Array; compressed: boolean } {
  try {
    return decodeWif(wif.trim(), network);
  } catch {
    throw new StarterError(`That is not a ${network} private key in WIF format.`, 'input');
  }
}

/** Throws unless `wif` is a private key of `network` (checked before anything is sent). */
export function checkWif(wif: string, network: Network): void {
  wipe(decodeVotingWif(wif, network).privKey);
}

/** signmessage with a pasted WIF of `network` (the compressed flag comes from the WIF); the decoded key is wiped. */
export function signWithWif(request: string, wif: string, network: Network): string {
  const { privKey, compressed } = decodeVotingWif(wif, network);
  try {
    return signMessage(privKey, request, { compressed });
  } finally {
    wipe(privKey);
  }
}

/** Why a proposal's payment address cannot sign the request, or null. */
export function paymentAddressProblem(address: string, network: Network): string | null {
  const d = decodeAddress(address.trim(), network);
  if (!d) return `${address || 'This'} is not a ${network} address.`;
  if (d.type !== 'p2pkh') return 'This payment address is a P2SH (multisig or script) address: it cannot sign messages, so this proposal cannot get a starter.';
  return null;
}

/** Local `verifymessage`: the pasted signature is from the payment address, over exactly this request. */
export function checkProposalSignature(address: string, signature: string, request: string, network: Network): boolean {
  try {
    return verifyMessage(address.trim(), signature.trim(), request, network);
  } catch {
    return false;
  }
}

// ---- token -------------------------------------------------------------------------------------------------------------------

const expiredError = () => new StarterError('The message to sign has expired (the issuer accepts it for a limited time only) or was already used. Get a new message and sign that one.', 'expired');

const ISSUER_ERRORS: Record<string, (kind: StarterKind, a: Extract<IssuerAnswer, { ok: false }>) => StarterError> = {
  'already-issued': () =>
    new StarterError(
      'You already used your starter. Each masternode gets one starter ever (its collateral too, also after a new registration), and each proposal one. To create another account, pay with a little DASH instead.',
      'already-issued',
    ),
  unauthorized: (kind) =>
    new StarterError(kind === 'mn' ? 'The issuer did not accept the signature: that key is not this masternode’s current voting key.' : 'The issuer did not accept the signature: it is not from this proposal’s payment address.', 'unauthorized'),
  'not-eligible': (kind, a) =>
    new StarterError(
      kind === 'mn'
        ? `This masternode cannot get a starter (it must be registered and not PoSe-banned on the issuer’s node): ${a.message}`
        : `This proposal cannot get a starter (it must be a valid proposal, current or recently ended, on the issuer’s node): ${a.message}`,
      'not-eligible',
    ),
  'bad-challenge': expiredError,
  'wrong-epoch': (_k, a) => new StarterError(`The issuer is not issuing for this epoch right now${a.issuingEpoch !== undefined ? ` (it is on epoch ${a.issuingEpoch})` : ''}. Try again in a few minutes.`, 'issuer', true, true),
  'wrong-key': () => new StarterError('The issuer signs with a different key than the one it published on Platform for this epoch. Nothing was sent to the faucet; try again later.', 'issuer', true, true),
  'wrong-network': () => new StarterError('The starter issuer serves another network.', 'issuer', false, true),
  'wrong-issuer': () => new StarterError('The starter issuer URL belongs to another issuer identity.', 'issuer', false, true),
  'bad-request': (_k, a) => new StarterError(`The issuer refused the request: ${a.message}`, 'issuer'),
  unavailable: () => new StarterError('The starter issuer is busy or not ready. Try again in a moment.', 'issuer', true),
};

/** What to tell the user when an earlier request can no longer be completed because issuance for its epoch has closed. */
export const closedRequestText = (kind: StarterKind): string =>
  `An earlier starter request for this account can no longer be completed: the issuer has stopped issuing for its period. If that request reached the issuer, this ${kind === 'mn' ? 'masternode' : 'proposal'} is recorded as having used its starter and asking again will say so; if it never arrived, a new request works. Otherwise, pay with a little DASH.`;

/** Issuance for the request's epoch has closed (Platform's proved height is at or past S(epoch + 1)): nothing can resend it. */
export async function requestClosed(d: Pick<StarterDeps, 'coreHeight' | 'network'>, p: Pick<PendingStarter, 'epoch'>): Promise<boolean> {
  return (await d.coreHeight()) >= epochStart(EPOCH_PARAMS[d.network], p.epoch + 1);
}

function issuerAnswerError(kind: StarterKind, a: Extract<IssuerAnswer, { ok: false }>, epoch?: number): StarterError {
  // the issuer has moved past this request's epoch: final for this blinding (a lagging issuer, on an earlier epoch, is retried)
  if (a.error === 'wrong-epoch' && epoch !== undefined && a.issuingEpoch !== undefined && a.issuingEpoch > epoch) return new StarterError(closedRequestText(kind), 'closed', false, true);
  const f = ISSUER_ERRORS[a.error];
  if (f) return f(kind, a);
  if (a.status === 404) return new StarterError('The issuer does not offer starters right now.', 'issuer');
  return new StarterError(`The issuer could not answer (${a.message}). Try again later.`, 'issuer', a.status >= 500 || a.status === 429);
}

// Kept retryable with the SAME blinded message: the issuer signs it again deterministically, so a garbled answer on the way (or a
// tampered connection) does not cost the starter the issuer has already recorded.
const BAD_ANSWER = 'The issuer answered with something that is not a valid signature for your token, so it cannot be used. This is the issuer’s fault (or the connection was tampered with), not yours. Try again later (the same request is sent again), or pay with DASH.';

/** Sends the signed request; finalizes and verifies the answer. */
export async function submitStarterRequest(d: StarterDeps, p: PendingStarter, signature: string): Promise<StarterToken> {
  let answer: IssuerAnswer;
  try {
    ({ answer } = await d.worker({ kind: 'token', url: d.issuer.url, request: p.request, signature: signature.trim(), blindedMsg: p.blindedMsg, api: 'starter' }));
  } catch (e) {
    throw new StarterError(`Could not reach the starter issuer: ${reachText(d.issuer.url, e, 'issuer')}.`, 'unreachable', true);
  }
  if (!answer.ok) throw issuerAnswerError(p.kind, answer, p.epoch);
  let sig: string;
  try {
    // finalize verifies the signature: a failure means the issuer answered garbage
    sig = (await d.worker({ kind: 'finalize', spki: bytesToBase64(p.key.spki), preparedMsg: p.preparedMsg, blindSig: answer.blindSig, inv: p.inv })).sig;
  } catch {
    throw new StarterError(BAD_ANSWER, 'bad-answer', true);
  }
  const ok = await verifyStarterToken(p.key, { net: d.network, issuerId: idToBytes(d.issuer.identityId), epoch: p.epoch, pubKeyHash: p.pubKeyHash }, p.msgPrefix, base64ToBytes(sig));
  if (!ok) throw new StarterError(BAD_ANSWER, 'bad-answer', true);
  const blocksLeft = Math.max(0, epochStart(EPOCH_PARAMS[d.network], p.epoch + 2) - p.height);
  return { network: d.network, epoch: p.epoch, msgPrefix: bytesToBase64(p.msgPrefix), sig, validUntil: Date.now() + blocksLeft * BLOCK_SECONDS * 1000 };
}

/** A proposal's request: refused here unless the pasted signature verifies for the payment address. */
export async function submitProposalStarter(d: StarterDeps, p: PendingStarter, paymentAddress: string, signature: string): Promise<StarterToken> {
  if (p.kind !== 'proposal') throw new StarterError('not a proposal request', 'input');
  if (!checkProposalSignature(paymentAddress, signature, p.request, d.network)) throw new StarterError(`This signature does not verify for ${paymentAddress} and this exact message.`, 'bad-signature');
  return submitStarterRequest(d, p, signature);
}

/**
 * A masternode's request end to end: prepare (or, given the `pending` request of an attempt whose answer never came, renew its
 * challenge), sign with the voting key, submit. `onPending` receives the request before it is sent, so a retry can reuse it.
 */
export async function requestMnStarter(
  d: StarterDeps,
  o: { proTxHash: string; pubKeyHash: Uint8Array; sign(request: string): string | Promise<string>; pending?: PendingStarter | null; onPending?(p: PendingStarter): void | Promise<void> },
): Promise<StarterToken> {
  const subject = o.proTxHash.trim().toLowerCase();
  const p = o.pending && o.pending.kind === 'mn' && o.pending.subject === subject ? await renewChallenge(d, o.pending) : await prepareStarterRequest(d, { kind: 'mn', subject, pubKeyHash: o.pubKeyHash });
  await o.onPending?.(p); // kept (encrypted) before it is sent
  return submitStarterRequest(d, p, await o.sign(p.request));
}

// ---- redeem ------------------------------------------------------------------------------------------------------------------

export interface Redeemed {
  txid: string;
  amountSats: number;
  /** the faucet had paid this token before (same txid): nothing is paid twice */
  replay: boolean;
}

function faucetAnswerError(a: Extract<FaucetAnswer, { ok: false }>): StarterError {
  if (a.status === 429 || a.code === 'budget') {
    const mins = a.retryAfter && a.retryAfter > 0 ? Math.max(1, Math.ceil(a.retryAfter / 60)) : null;
    return new StarterError(`The faucet has given out all the starters it can for now. Try again ${mins ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : 'later'}; your token stays valid for a while.`, 'faucet-busy', true);
  }
  if (a.status === 503 || a.code === 'unavailable') return new StarterError('The faucet cannot pay right now (it may be low on funds or unable to reach the network). Try again later; your token stays valid for a while.', 'faucet-busy', true);
  if (a.code === 'disabled' || a.status === 404) return new StarterError('The faucet does not pay starters on this network right now.', 'faucet');
  if (a.code === 'unknown-key') return new StarterError('The faucet does not accept this token’s key right now. Try again in a few minutes; the token is kept until it expires. If it keeps failing, pay with DASH instead.', 'faucet-rejected', true);
  if (a.code === 'invalid-token') return new StarterError('The faucet did not accept this token for this account. Try again later (the token is kept until it expires), or pay with DASH instead.', 'faucet-rejected', true);
  if (a.status >= 500) return new StarterError(`The faucet could not answer (${a.message}). Try again later.`, 'faucet-busy', true);
  return new StarterError(`The faucet refused the starter: ${a.message}`, 'faucet');
}

/** Asks the faucet to pay the starter to `address` (the new account's one-time funding address). A replay is a success. */
export async function redeemStarter(d: StarterDeps, token: StarterToken, address: string): Promise<Redeemed> {
  if (token.network !== d.network) throw new StarterError(`This starter token is for ${token.network}, not ${d.network}.`, 'input');
  let answer: FaucetAnswer;
  try {
    ({ answer } = await d.worker({ kind: 'starterRedeem', url: d.faucetUrl, body: { network: d.network, epoch: token.epoch, address, msgPrefix: token.msgPrefix, sig: token.sig } }));
  } catch (e) {
    throw new StarterError(`Could not reach the faucet: ${reachText(d.faucetUrl, e, 'faucet')}.`, 'unreachable', true);
  }
  if (!answer.ok) throw faucetAnswerError(answer);
  if (answer.address && answer.address !== address) throw new StarterError('The faucet reports paying another address. Nothing here uses that payment; try again or pay with DASH.', 'faucet');
  return { txid: answer.txid, amountSats: answer.amountSats, replay: answer.replay };
}

/**
 * Whether the faucet can never accept `token` again: Platform's PROVED core height is at or past S(epoch + 2) (the faucet redeems
 * epochs e-1..e+1 at height h, starterRedeemEpochs). The wall-clock `validUntil` is an estimate for display and is never enough to
 * give up a starter. Throws when the height cannot be read (the caller then keeps the token).
 */
export async function tokenExpired(d: Pick<StarterDeps, 'coreHeight'>, token: Pick<StarterToken, 'network' | 'epoch'>): Promise<boolean> {
  return (await d.coreHeight()) >= epochStart(EPOCH_PARAMS[token.network], token.epoch + 2);
}

// ---- timing ------------------------------------------------------------------------------------------------------------------

export const REDEEM_LATER_MIN_MS = 15 * 60_000;
export const REDEEM_LATER_MAX_MS = 6 * 3_600_000;

/** "Redeem later": a uniformly random delay (CSPRNG) between 15 minutes and 6 hours. */
export const pickRedeemDelayMs = (): number => REDEEM_LATER_MIN_MS + randomBelow(REDEEM_LATER_MAX_MS - REDEEM_LATER_MIN_MS + 1);
