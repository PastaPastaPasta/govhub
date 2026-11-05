// Which errors mean "the network or a node failed just now", and how to say why a check didn't finish without showing a raw
// exception as the message (DESIGN.md §6, Error: the raw text belongs under Details).
import { errText } from './format.ts';

/**
 * Errors that mean "the network or a node failed just now" rather than "this cannot work": the SDK's quorum prefetch, its WASM streaming
 * fetch, DAPI transport and timeouts. Retrying is the right answer to these, and nothing the user holds is affected.
 */
const TRANSIENT_ERROR = new RegExp(
  [
    'failed to prefetch quorums',
    'webassembly (?:compilation|instantiation) aborted:? network',
    '\\bnetwork ?error\\b',
    'http request error',
    // the browser's own fetch failure, not the SDK's "Failed to fetch identity: <any cause>" wrapper
    '\\bfailed to fetch\\b(?! \\w)',
    '\\bload failed\\b',
    // gRPC and HTTP transport trouble, with a transport word after it: the SDK also reports refused requests as "transport error"
    'transport error[^\\n]*\\b(?:connect|connection|timed out|dns|reset|refused|unreachable)',
    '\\btimed out\\b',
    '\\bdeadline exceeded\\b',
    '\\bERR_(?:NETWORK|INTERNET|CONNECTION|ABORTED|TIMED)',
    '\\btemporarily unavailable\\b',
    '\\b(?:HTTP|status)[ :]+50[234]\\b',
  ].join('|'),
  'i',
);

export const isTransientError = (e: unknown): boolean => TRANSIENT_ERROR.test(errText(e));

/** The verification worker's own words for "no node answered": the node list, the pool, a node it could not reach. */
const UNREACHED = /node list|no usable nodes|all nodes failed|node attempts failed|\bfetch failed\b|no nodes? (?:left|available)|unreachable|\btimeout\b/i;
const THROTTLED = /(?:HTTP|status)[ :]+429\b|rate.?limit|too many requests/i;

const NODES = "this browser couldn't reach the Dash network's nodes just now";
const BRIDGE = "this browser couldn't reach the governance bridge just now";
const SLOW_DOWN = 'the Dash network nodes asked this browser to slow down';

/**
 * Why a check stopped, as the end of a sentence ("The chain couldn't be checked: <this>"). Only failures of the network, a node or
 * the bridge are put in words; anything else (a proof that did not check out, a bug) keeps its own text, because it may matter.
 */
export function unfinishedReason(e: unknown): string {
  const raw = errText(e);
  if (THROTTLED.test(raw)) return SLOW_DOWN;
  if (isTransientError(raw) || UNREACHED.test(raw)) return /\bbridge\b/i.test(raw) ? BRIDGE : NODES;
  return raw;
}

/** Whether `unfinishedReason` replaced the raw text (then it is worth offering under "Details"). */
export const isNetworkReason = (e: unknown): boolean => unfinishedReason(e) !== errText(e);

/**
 * Whether a check's reason (as aggregate.ts words it) only says the network didn't answer. Such a result says nothing about the
 * proposal; a mismatch, an absent transaction or a node answer that didn't check out never reads like this.
 */
export const onlyUnreached = (reason: string | null | undefined): boolean => !!reason && [NODES, BRIDGE, SLOW_DOWN].some((t) => reason.includes(t));
