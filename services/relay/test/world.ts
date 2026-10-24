// Test world: an in-memory fake Dash Core, a fake clock, masternodes with real secp256k1 voting keys, and the relay wired to them.
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Hono } from 'hono';
import {
  bytesToHex,
  governanceVoteHash,
  hash160,
  p2pkhAddress,
  relayCancelMessage,
  signMessage,
  signVote,
  VOTE_OUTCOME_NAMES,
  VOTE_SIGNAL_NAMES,
  type Network,
  type VoteFields,
} from '@govhub/verify';
import { createApp } from '../src/api/server.ts';
import { Broadcaster } from '../src/broadcaster.ts';
import { loadConfig, type RelayConfig } from '../src/config.ts';
import { CoreRpcError, type CoreClient } from '../src/core/rpc.ts';
import { openDb, Store, type VoteRow } from '../src/db.ts';
import { Relay } from '../src/relay.ts';

export const T0 = 1_800_000_000;

export class FakeClock {
  t: number;
  constructor(t = T0) {
    this.t = t;
  }
  now = (): number => this.t;
  advance(s: number): void {
    this.t += s;
  }
}

interface FakeMn {
  txid: string;
  n: number;
  votingAddress: string;
  banned: boolean;
}

interface FakeVote {
  hash: string;
  gov?: string;
  time: number;
  outcome: number;
  signal: number;
  txid: string;
  n: number;
  /** Core's receive time (GOVERNANCE_UPDATE_MIN is measured on it) */
  lastUpdate: number;
}

const rpcErr = (method: string, code: number, msg: string) => new CoreRpcError(method, code, msg);

/** Enough of dashd for the relay: protx list, gobject get/getcurrentvotes/submit, voteraw, getrawtransaction, getblockcount. */
export class FakeCore implements CoreClient {
  height = 1_234_567;
  mns = new Map<string, FakeMn>();
  gobjects = new Map<string, { ObjectType: number }>();
  votes = new Map<string, FakeVote>();
  rawTxs = new Map<string, { hex: string; confirmations: number }>();
  calls: Array<{ method: string; params: unknown[] }> = [];
  /** every call fails with a transport error */
  down = false;
  /** errors thrown by the next voteraw calls, in order (before Core's own rules apply) */
  voterawErrors: unknown[] = [];
  /** voteraw answers "Voted successfully" but the vote is lost */
  blackhole = false;
  /** every `gobject getcurrentvotes` fails with this (a JSON-RPC error or a transport error) */
  currentVotesError: unknown = null;
  /** awaited inside voteraw before it answers (lets a test act while a vote is `sending`) */
  voterawGate: Promise<void> | null = null;
  submitError: unknown = null;
  submitResult: unknown = null;
  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  count(method: string, sub?: string): number {
    return this.calls.filter((c) => c.method === method && (sub === undefined || c.params[0] === sub)).length;
  }

  addMn(m: FakeMn): void {
    this.mns.set(`${m.txid}-${m.n}`, m);
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (this.down) throw new Error('fetch failed: ECONNREFUSED');
    return this.handle(method, params) as T;
  }

  private handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'getblockcount':
        return this.height;
      case 'protx':
        return [...this.mns.values()].map((m) => ({
          proTxHash: bytesToHex(randomBytes(32)),
          collateralHash: m.txid,
          collateralIndex: m.n,
          state: { PoSeBanHeight: m.banned ? 1000 : -1, votingAddress: m.votingAddress },
        }));
      case 'getrawtransaction': {
        const tx = this.rawTxs.get(String(params[0]));
        if (!tx) throw rpcErr(method, -5, 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.');
        return { txid: params[0], hex: tx.hex, confirmations: tx.confirmations };
      }
      case 'voteraw':
        return this.voteraw(params);
      case 'gobject':
        return this.gobject(params);
    }
    throw rpcErr(method, -32601, 'Method not found');
  }

  private gobject(params: unknown[]): unknown {
    const sub = params[0];
    if (sub === 'get') {
      const o = this.gobjects.get(String(params[1]));
      if (!o) throw rpcErr('gobject', -8, 'Unknown governance object');
      return { ObjectType: o.ObjectType, Hash: params[1] };
    }
    if (sub === 'getcurrentvotes') {
      if (!this.gobjects.has(String(params[1]))) throw rpcErr('gobject', -8, 'Unknown governance-hash');
      if (typeof params[3] !== 'string') throw rpcErr('gobject', -3, 'JSON value is not a string as expected'); // Core's vout is a STR
      const out: Record<string, string> = {};
      if (this.currentVotesError) throw this.currentVotesError;
      for (const v of this.votes.values()) {
        if ((v.gov !== undefined && v.gov !== params[1]) || v.txid !== params[2] || String(v.n) !== params[3]) continue;
        out[v.hash] = `${v.txid}-${v.n}:${v.time}:${VOTE_OUTCOME_NAMES[v.outcome]}:${VOTE_SIGNAL_NAMES[v.signal]}:1`;
      }
      return out;
    }
    if (sub === 'submit') {
      if (this.submitError) throw this.submitError;
      return this.submitResult;
    }
    throw rpcErr('gobject', -8, 'Must be a valid command');
  }

  /** Puts a vote straight into Core's current votes (as if a peer relayed it), without voteraw's rules. */
  addCurrentVote(m: { txid: string; n: number }, gov: string, outcome: 'yes' | 'no' | 'abstain', time: number): string {
    const o = VOTE_OUTCOME_NAMES.indexOf(outcome);
    const hash = governanceVoteHash({ collateralTxid: m.txid, collateralIndex: m.n, govHashDisplay: gov, signal: 1, outcome: o, time });
    this.votes.set(`${m.txid}-${m.n}|${gov}|1`, { hash, gov, time, outcome: o, signal: 1, txid: m.txid, n: m.n, lastUpdate: this.clock.now() });
    return hash;
  }

  private voteraw(p: unknown[]): string | Promise<string> {
    if (this.voterawGate) {
      const gate = this.voterawGate;
      return gate.then(() => this.voterawNow(p));
    }
    return this.voterawNow(p);
  }

  private voterawNow(p: unknown[]): string {
    const [txid, n, gov, signalName, outcomeName, time, sig] = p as [string, number, string, string, string, number, string];
    const err = this.voterawErrors.shift();
    if (err) throw err;
    if (!this.gobjects.has(gov)) throw rpcErr('voteraw', -8, 'Governance object not found');
    if (typeof sig !== 'string') throw rpcErr('voteraw', -8, 'Malformed base64 encoding');
    const mn = this.mns.get(`${txid}-${n}`);
    if (!mn || mn.banned) throw rpcErr('voteraw', -32603, `Failure to find masternode in list : ${txid}-${n}`);
    const now = this.clock.now();
    if (time > now + 3600) throw rpcErr('voteraw', -32603, 'Failure to verify vote.');
    const signal = VOTE_SIGNAL_NAMES.indexOf(signalName as 'funding');
    const outcome = VOTE_OUTCOME_NAMES.indexOf(outcomeName as 'yes');
    const key = `${txid}-${n}|${gov}|${signal}`;
    const cur = this.votes.get(key);
    const hash = governanceVoteHash({ collateralTxid: txid, collateralIndex: n, govHashDisplay: gov, signal, outcome, time });
    // governance.cpp ProcessVote: a vote hash Core already has returns false with an empty exception message
    if (cur && cur.hash === hash) throw rpcErr('voteraw', -32603, 'Error voting : ');
    if (cur && time < cur.time) throw rpcErr('voteraw', -32603, 'Error voting : CGovernanceObject::ProcessVote -- Obsolete vote');
    if (cur && cur.lastUpdate > now - 3600) {
      throw rpcErr('voteraw', -32603, `Error voting : CGovernanceObject::ProcessVote -- Masternode voting too often, MN outpoint = ${txid}-${n}, governance object hash = ${gov}`);
    }
    if (!this.blackhole) {
      this.votes.set(key, { hash, gov, time, outcome, signal, txid, n, lastUpdate: now });
    }
    return 'Voted successfully';
  }
}

export interface Mn {
  priv: Uint8Array;
  txid: string;
  n: number;
  keyId: Uint8Array;
  address: string;
}

export interface VoteOpts {
  time?: number;
  outcome?: 'yes' | 'no' | 'abstain';
  govHash?: string;
  releaseAt?: number;
  /** sign for this network's scheme instead of the relay's */
  signAs?: Network;
  signWith?: Uint8Array;
  extra?: Record<string, unknown>;
}

export class World {
  readonly network: Network;
  readonly cfg: RelayConfig;
  readonly clock = new FakeClock();
  readonly core = new FakeCore(this.clock);
  readonly store: Store;
  readonly relay: Relay;
  readonly app: Hono;
  readonly broadcaster: Broadcaster;

  constructor(network: Network, env: Record<string, string> = {}, dbPath = ':memory:') {
    this.network = network;
    this.cfg = loadConfig({ CORE_NETWORK: network, HTTP_HOST: '127.0.0.1', ...env });
    this.store = new Store(openDb(dbPath));
    this.relay = new Relay(this.cfg, this.store, this.core, this.clock.now);
    this.app = createApp(this.relay);
    this.broadcaster = new Broadcaster({ cfg: this.cfg, store: this.store, core: this.core, mns: this.relay.mns, clock: this.clock.now });
  }

  /** A registered masternode with a fresh voting key. */
  mn(opts: { banned?: boolean } = {}): Mn {
    const priv = randomBytes(32);
    const keyId = hash160(secp256k1.getPublicKey(priv, true));
    const m: Mn = { priv, txid: bytesToHex(randomBytes(32)), n: 0, keyId, address: p2pkhAddress(keyId, this.network) };
    this.core.addMn({ txid: m.txid, n: m.n, votingAddress: m.address, banned: opts.banned ?? false });
    return m;
  }

  /** A governance object known to Core (a proposal unless `type` says otherwise). */
  proposal(type = 1): string {
    const hash = bytesToHex(randomBytes(32));
    this.core.gobjects.set(hash, { ObjectType: type });
    return hash;
  }

  voteFields(m: Mn, gov: string, outcome: 'yes' | 'no' | 'abstain', time: number): VoteFields {
    return { collateralTxid: m.txid, collateralIndex: m.n, govHashDisplay: gov, signal: 1, outcome: VOTE_OUTCOME_NAMES.indexOf(outcome), time };
  }

  /** The JSON body of POST /v1/votes for a correctly signed funding vote. */
  voteBody(m: Mn, o: VoteOpts & { govHash: string }): Record<string, unknown> {
    const time = o.time ?? this.clock.t;
    const outcome = o.outcome ?? 'yes';
    const fields = this.voteFields(m, o.govHash, outcome, time);
    const signed = signVote({ privKey: o.signWith ?? m.priv, vote: fields, network: o.signAs ?? this.network });
    return {
      network: this.network,
      collateralTxid: m.txid,
      collateralIndex: m.n,
      govHash: o.govHash,
      signal: 'funding',
      outcome,
      time,
      sig: signed.base64,
      ...(o.releaseAt !== undefined ? { releaseAt: o.releaseAt } : {}),
      ...o.extra,
    };
  }

  voteHashOf(m: Mn, gov: string, outcome: 'yes' | 'no' | 'abstain', time: number): string {
    return governanceVoteHash(this.voteFields(m, gov, outcome, time));
  }

  cancelBody(m: Mn, id: string, voteHash: string, opts: { signWith?: Uint8Array; net?: Network } = {}): Record<string, unknown> {
    return { id, sig: signMessage(opts.signWith ?? m.priv, relayCancelMessage(opts.net ?? this.network, voteHash)) };
  }

  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const r = await this.app.request(path, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } });
    return { status: r.status, headers: r.headers, body: (await r.json()) as any };
  }

  async get(path: string) {
    const r = await this.app.request(path);
    return { status: r.status, headers: r.headers, body: (await r.json()) as any };
  }

  /** Submits a vote and returns the 202 receipt (fails the test on anything else). */
  async submit(m: Mn, o: VoteOpts & { govHash: string }) {
    const r = await this.post('/v1/votes', this.voteBody(m, o));
    if (r.status !== 202) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string; voteHash: string; status: string; releaseAt: number };
  }

  row(id: string): VoteRow {
    return this.store.get(id)!;
  }
}
