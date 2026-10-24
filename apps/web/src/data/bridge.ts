// Typed client for the bridge HTTP API (services/bridge/openapi.json): live tallies, the signed votes behind
// a tally and the MN list. Everything a bridge returns is untrusted: responses are shape-checked here, and
// the numbers are labelled "bridge-reported" until the verifier re-derives them.
import { isHex64 } from '../lib/bytes.ts';
import { parseGovParams, type GovParams } from '../lib/governance.ts';
import type { Cycle, Proposal, Tally } from './types.ts';

export interface BridgeStatus {
  network: string;
  height: number;
  bestBlockHash?: string;
  govContractId?: string;
  bridgeIdentityId?: string;
  version?: string;
}

/** A signed funding vote exactly as Core relays it. */
export interface BridgeVote {
  collateralTxid: string;
  collateralIndex: number;
  /** 1 = funding */
  signal: number;
  /** 1 yes, 2 no, 3 abstain */
  outcome: number;
  /** unix seconds, as signed */
  time: number;
  /** base64 65-byte compact signature */
  sig: string;
}

/** `GET /v1/proposals/{hash}/votes`: the counted set behind one tally. */
export interface BridgeVotes {
  govHash: string;
  /** The `?height=` that was asked for, or the live tally's height. */
  asOfHeight: number;
  /** Height of the tally this set belongs to (<= asOfHeight); the masternode list in force is the one at this height. */
  tallyHeight: number;
  /** Hash of the masternode list the tally was built from, when the bridge says. */
  mnListHash: string | null;
  /** The bridge's own claim; the app compares its recount with the published tally, not with this. */
  voteSetHash: string | null;
  votes: BridgeVote[];
  /** Only fixture bridges: whether the votes are recorded mainnet data or synthetic. */
  origin?: 'recorded' | 'synthetic';
}

export interface BridgeMasternode {
  proTxHash: string;
  collateralTxid: string;
  collateralIndex: number;
  votingAddress: string;
  /** 'regular' (weight 1) or 'evo' (weight 4) */
  type: 'regular' | 'evo';
  valid: boolean;
}

export interface BridgeMnList {
  height: number;
  /** The bridge's identifier of this list (its tallies name the list they used). */
  listHash: string;
  masternodes: BridgeMasternode[];
}

/** What the app needs from a bridge. Implemented by the HTTP client and by the fixture bridge. */
export interface Bridge {
  readonly name: string;
  status(): Promise<BridgeStatus>;
  proposals(): Promise<Proposal[]>;
  proposal(govHash: string): Promise<Proposal | null>;
  /** The counted vote set behind the tally in force at `height` (`?height=`), or behind the live tally. */
  votes(govHash: string, opts?: { height?: number }): Promise<BridgeVotes>;
  tallies(): Promise<Tally[]>;
  cycle(): Promise<Cycle | null>;
  /** Governance parameters of the bridge's Core network (`getgovernanceinfo` in `/v1/cycle`), null when not reported. */
  params(): Promise<GovParams | null>;
  /** The snapshot in force at `height` (`/v1/mnlist/{height}`), or the live one. */
  mnlist(height?: number): Promise<BridgeMnList>;
}

export class BridgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BridgeError';
  }
}

// ---- runtime shape checks -------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new BridgeError(`${what} is not an object`);
  return v;
}
const int = (o: Obj, k: string, min = 0): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new BridgeError(`bad field ${k}`);
  return v;
};
const signedInt = (o: Obj, k: string): number => int(o, k, Number.MIN_SAFE_INTEGER);
/** Like `int`, but 0 when the field is absent or null (the API sends null for "not known yet"). */
const optInt = (o: Obj, k: string, min = 0): number => (o[k] === undefined || o[k] === null ? 0 : int(o, k, min));
const str = (o: Obj, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new BridgeError(`bad field ${k}`);
  return v;
};
const hex64 = (o: Obj, k: string): string => {
  const v = o[k];
  if (!isHex64(v)) throw new BridgeError(`bad hash ${k}`);
  return v.toLowerCase();
};
const optHex64 = (o: Obj, k: string): string | null => (o[k] === undefined || o[k] === null ? null : hex64(o, k));
const optStr = (o: Obj, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
const bool = (o: Obj, k: string): boolean => {
  if (typeof o[k] !== 'boolean') throw new BridgeError(`bad field ${k}`);
  return o[k] as boolean;
};

/**
 * `Proposal` (openapi). The parsed fields (name, url, address, amount, epochs) are null when Core could not parse the object's data:
 * such a proposal cannot be shown, so the list endpoint skips it and the single-proposal one refuses it.
 */
export function parseProposal(raw: unknown): Proposal {
  const o = obj(raw, 'proposal');
  return {
    govHash: hex64(o, 'govHash'),
    parentHash: o.parentHash === undefined ? '0'.repeat(64) : hex64(o, 'parentHash'),
    revision: int(o, 'revision'),
    time: int(o, 'time'),
    dataHex: str(o, 'dataHex'),
    name: str(o, 'name'),
    url: str(o, 'url'),
    paymentAddress: str(o, 'paymentAddress'),
    paymentAmount: int(o, 'paymentAmount'),
    startEpoch: int(o, 'startEpoch'),
    endEpoch: int(o, 'endEpoch'),
    collateralTxid: hex64(o, 'collateralTxid'),
    collateralHeight: optInt(o, 'collateralHeight'),
  };
}

export function parseTally(raw: unknown): Tally {
  const o = obj(raw, 'tally');
  return {
    govHash: hex64(o, 'govHash'),
    asOfHeight: int(o, 'asOfHeight'),
    yesWeighted: int(o, 'yesWeighted'),
    noWeighted: int(o, 'noWeighted'),
    abstainWeighted: int(o, 'abstainWeighted'),
    yesCount: int(o, 'yesCount'),
    noCount: int(o, 'noCount'),
    abstainCount: int(o, 'abstainCount'),
    voteSetHash: hex64(o, 'voteSetHash'),
    rank: int(o, 'rank'),
    inNextBudget: bool(o, 'inNextBudget'),
    margin: signedInt(o, 'margin'),
  };
}

export function parseCycle(raw: unknown): Cycle {
  const o = obj(raw, 'cycle');
  return {
    superblockHeight: int(o, 'superblockHeight'),
    budget: int(o, 'budget'),
    allocated: int(o, 'allocated'),
    votingDeadlineHeight: int(o, 'votingDeadlineHeight'),
    estTime: int(o, 'estTime'),
    validWeighted: int(o, 'validWeighted'),
    paid: int(o, 'paid'),
  };
}

export function parseVote(raw: unknown): BridgeVote {
  const o = obj(raw, 'vote');
  const outcome = int(o, 'outcome');
  if (outcome > 3) throw new BridgeError('bad vote outcome');
  return { collateralTxid: hex64(o, 'collateralTxid'), collateralIndex: int(o, 'collateralIndex'), signal: int(o, 'signal'), outcome, time: signedInt(o, 'time'), sig: str(o, 'sig') };
}

export function parseMasternode(raw: unknown): BridgeMasternode {
  const o = obj(raw, 'masternode');
  const type = o.type;
  if (type !== 'regular' && type !== 'evo') throw new BridgeError('bad masternode type');
  return { proTxHash: hex64(o, 'proTxHash'), collateralTxid: hex64(o, 'collateralTxid'), collateralIndex: int(o, 'collateralIndex'), votingAddress: str(o, 'votingAddress'), type, valid: bool(o, 'valid') };
}

function list<T>(o: unknown, key: string, each: (x: unknown) => T): T[] {
  const arr = isObj(o) ? o[key] : undefined;
  if (!Array.isArray(arr)) throw new BridgeError(`expected a ${key} array`);
  return arr.map(each);
}

/**
 * `VoteSet`. The set must be for the proposal asked about and, for `?height=H`, must belong to a tally at or below H: both are
 * checked here because a mismatching answer would otherwise be recounted against the wrong tally. The spec makes `tallyHeight`
 * optional (absent in `?all=1`); both modes this client uses return it, and it is required.
 */
export function parseVotes(raw: unknown, req: { govHash: string; height?: number }): BridgeVotes {
  const o = obj(raw, 'vote set');
  const govHash = hex64(o, 'govHash');
  if (govHash !== req.govHash.toLowerCase()) throw new BridgeError('the vote set is for a different proposal');
  const tallyHeight = int(o, 'tallyHeight');
  if (req.height !== undefined && tallyHeight > req.height) throw new BridgeError(`the vote set belongs to a tally at block ${tallyHeight}, above the requested block ${req.height}`);
  return {
    govHash,
    asOfHeight: o.asOfHeight === null || o.asOfHeight === undefined ? tallyHeight : int(o, 'asOfHeight'),
    tallyHeight,
    mnListHash: optStr(o, 'mnListHash') ?? null,
    voteSetHash: optHex64(o, 'voteSetHash'),
    votes: list(o, 'votes', parseVote),
  };
}

export function parseMnList(raw: unknown): BridgeMnList {
  const o = obj(raw, 'masternode list');
  return { height: int(o, 'height'), listHash: str(o, 'listHash'), masternodes: list(o, 'masternodes', parseMasternode) };
}

// ---- HTTP client ----------------------------------------------------------------------------
export class HttpBridge implements Bridge {
  constructor(readonly name: string, readonly base: string, private readonly timeoutMs = 15000) {}

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      throw new BridgeError(`${this.name} unreachable: ${(e as Error).message}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new BridgeError(`${this.name} answered HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new BridgeError(`${this.name} returned invalid JSON`);
    }
  }

  async status(): Promise<BridgeStatus> {
    const o = await this.get('/v1/status');
    if (!isObj(o)) throw new BridgeError('bad status');
    return { network: str(o, 'network'), height: int(o, 'height'), bestBlockHash: optStr(o, 'bestBlockHash'), govContractId: optStr(o, 'govContractId'), bridgeIdentityId: optStr(o, 'bridgeIdentityId'), version: optStr(o, 'version') };
  }
  async proposals(): Promise<Proposal[]> {
    const out: Proposal[] = [];
    for (const raw of list(await this.get('/v1/proposals?state=active'), 'proposals', (x) => x)) {
      try {
        out.push(parseProposal(raw));
      } catch {
        /* unparseable proposal data: nothing to show or verify */
      }
    }
    return out;
  }
  async proposal(govHash: string): Promise<Proposal | null> {
    const o = await this.get(`/v1/proposals/${encodeURIComponent(govHash)}`);
    return o === null ? null : parseProposal(o);
  }
  async votes(govHash: string, opts: { height?: number } = {}): Promise<BridgeVotes> {
    const q = opts.height === undefined ? '' : `?height=${encodeURIComponent(String(opts.height))}`;
    const o = await this.get(`/v1/proposals/${encodeURIComponent(govHash)}/votes${q}`);
    if (o === null) throw new BridgeError(opts.height === undefined ? 'the bridge has no vote set for this proposal' : `the bridge has no vote set at or below block ${opts.height}`, 404);
    return parseVotes(o, { govHash, ...(opts.height === undefined ? {} : { height: opts.height }) });
  }
  async tallies(): Promise<Tally[]> {
    return list(await this.get('/v1/tallies'), 'tallies', parseTally);
  }
  /** `/v1/cycle` carries both the cycle and the governance parameters: one request serves both for a few seconds. */
  private cycleRes: { at: number; res: Promise<unknown> } | null = null;
  private cycleResponse(): Promise<unknown> {
    if (!this.cycleRes || Date.now() - this.cycleRes.at > 10_000) {
      const res = this.get('/v1/cycle');
      this.cycleRes = { at: Date.now(), res };
      res.catch(() => {
        if (this.cycleRes?.res === res) this.cycleRes = null;
      });
    }
    return this.cycleRes.res;
  }
  async cycle(): Promise<Cycle | null> {
    const o = await this.cycleResponse();
    return o === null ? null : parseCycle(obj(o, 'cycle response').cycle);
  }
  async params(): Promise<GovParams | null> {
    const o = await this.cycleResponse();
    return isObj(o) ? parseGovParams(o.governance) : null;
  }
  async mnlist(height?: number): Promise<BridgeMnList> {
    const o = await this.get(height === undefined ? '/v1/mnlist' : `/v1/mnlist/${encodeURIComponent(String(height))}`);
    if (o === null) throw new BridgeError(height === undefined ? 'the bridge has no masternode list' : `the bridge has no masternode list at or below block ${height}`, 404);
    return parseMnList(o);
  }
}
