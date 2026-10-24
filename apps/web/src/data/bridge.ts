// Typed client for the bridge HTTP API (PLAN §1, §2): live tallies, raw signed votes and the MN
// list. Everything a bridge returns is untrusted: responses are shape-checked here, and the
// numbers are labelled "bridge-reported" until the verifier re-derives them.
import { isHex64 } from '../lib/bytes.ts';
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

export interface BridgeVotes {
  govHash: string;
  asOfHeight: number;
  votes: BridgeVote[];
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
  masternodes: BridgeMasternode[];
}

/** What the app needs from a bridge. Implemented by the HTTP client and by the fixture bridge. */
export interface Bridge {
  readonly name: string;
  status(): Promise<BridgeStatus>;
  proposals(): Promise<Proposal[]>;
  proposal(govHash: string): Promise<Proposal | null>;
  votes(govHash: string): Promise<BridgeVotes>;
  tallies(): Promise<Tally[]>;
  cycle(): Promise<Cycle | null>;
  mnlist(): Promise<BridgeMnList>;
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
/** `o[key]` when it is an object (a `{ proposal: {...} }` envelope), else `o` itself. */
const unwrap = (o: unknown, key: string): unknown => (isObj(o) && isObj(o[key]) ? o[key] : o);
const int = (o: Obj, k: string, min = 0): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new BridgeError(`bad field ${k}`);
  return v;
};
const signedInt = (o: Obj, k: string): number => int(o, k, Number.MIN_SAFE_INTEGER);
/** Like `int`, but 0 when the field is absent. */
const optInt = (o: Obj, k: string, min = 0): number => (o[k] === undefined ? 0 : int(o, k, min));
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
const optStr = (o: Obj, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);

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
    voteSetHash: o.voteSetHash === undefined ? '' : hex64(o, 'voteSetHash'),
    rank: optInt(o, 'rank'),
    inNextBudget: o.inNextBudget === true,
    margin: optInt(o, 'margin', Number.MIN_SAFE_INTEGER),
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
    paid: optInt(o, 'paid'),
  };
}

const OUTCOMES: Record<string, number> = { yes: 1, no: 2, abstain: 3 };

export function parseVote(raw: unknown): BridgeVote {
  const o = obj(raw, 'vote');
  const outcome = typeof o.outcome === 'string' ? OUTCOMES[o.outcome] : o.outcome;
  if (typeof outcome !== 'number' || ![0, 1, 2, 3].includes(outcome)) throw new BridgeError('bad vote outcome');
  const signal = o.signal === undefined || o.signal === 'funding' ? 1 : o.signal;
  if (typeof signal !== 'number') throw new BridgeError('bad vote signal');
  return { collateralTxid: hex64(o, 'collateralTxid'), collateralIndex: int(o, 'collateralIndex'), signal, outcome, time: signedInt(o, 'time'), sig: str(o, 'sig') };
}

export function parseMasternode(raw: unknown): BridgeMasternode {
  const o = obj(raw, 'masternode');
  const t = o.type;
  const type = t === 'evo' || t === 'Evo' || t === 'HighPerformance' || t === 1 ? 'evo' : 'regular';
  return { proTxHash: hex64(o, 'proTxHash'), collateralTxid: hex64(o, 'collateralTxid'), collateralIndex: int(o, 'collateralIndex'), votingAddress: str(o, 'votingAddress'), type, valid: o.valid !== false };
}

const list = <T>(o: unknown, key: string, each: (x: unknown) => T): T[] => {
  const arr = Array.isArray(o) ? o : isObj(o) ? o[key] : undefined;
  if (!Array.isArray(arr)) throw new BridgeError(`expected a ${key} array`);
  return arr.map(each);
};

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
    return list(await this.get('/v1/proposals'), 'proposals', parseProposal);
  }
  async proposal(govHash: string): Promise<Proposal | null> {
    const o = await this.get(`/v1/proposals/${encodeURIComponent(govHash)}`);
    return o === null ? null : parseProposal(unwrap(o, 'proposal'));
  }
  async votes(govHash: string): Promise<BridgeVotes> {
    const o = await this.get(`/v1/proposals/${encodeURIComponent(govHash)}/votes`);
    if (!isObj(o)) throw new BridgeError('no votes for this proposal');
    return { govHash: o.govHash === undefined ? govHash : hex64(o, 'govHash'), asOfHeight: optInt(o, 'asOfHeight'), votes: list(o, 'votes', parseVote) };
  }
  async tallies(): Promise<Tally[]> {
    return list(await this.get('/v1/tallies'), 'tallies', parseTally);
  }
  async cycle(): Promise<Cycle | null> {
    const o = await this.get('/v1/cycle');
    return o === null ? null : parseCycle(unwrap(o, 'cycle'));
  }
  async mnlist(): Promise<BridgeMnList> {
    const o = await this.get('/v1/mnlist');
    return { height: isObj(o) && typeof o.height === 'number' ? o.height : 0, masternodes: list(o, 'masternodes', parseMasternode) };
  }
}
