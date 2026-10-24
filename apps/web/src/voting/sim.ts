// Fixture mode's pretend network for masternode voting: a demo keyring signs real votes with the synthetic masternodes' keys, two
// pretend relays hold and "broadcast" them, and a bridge wrapper over the fixture bridge shows them in its vote set. Nothing leaves
// the tab. It drives the same provider code as live mode, so the tracker, the celebration and the error states can be seen and tested.
//
// `?votesim=` picks a scenario: `auto` (default; each stage ~1.5 s), `manual` (stages move only on window.__voteSim.advance()),
// `down` (both relays unreachable until window.__voteSim.up()), `hour` (the relay holds the vote for Core's one-change-per-hour rule).
import { countVotes, normalizeMnId, p2pkhAddress, hash160 } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { Bridge, BridgeMnList, BridgeVote, BridgeVotes } from '../data/bridge.ts';
import { FixtureBridge } from '../data/fixtures.ts';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import type { SignedVoteRecord } from './plan.ts';
import { RelayError, type RelayHealth, type RelayVoteState, type RelayVoteStatus } from './relay.ts';

export type SimScenario = 'auto' | 'manual' | 'down' | 'hour';
export const SIM_RELAYS = ['https://relay-one.example', 'https://relay-two.example'];

export interface RelayPort {
  submit(v: SignedVoteRecord, network: 'mainnet' | 'testnet'): Promise<RelayVoteState>;
  status(id: string): Promise<RelayVoteState | null>;
  cancel(id: string, sig: string): Promise<RelayVoteStatus>;
  health(network: 'mainnet' | 'testnet'): Promise<RelayHealth>;
}

/** The demo keyring: key A votes for synthetic masternodes 0 and 2, key B for masternode 1 (shown as an evonode). */
export const DEMO_KEYS = [
  { index: 0, label: 'Demo key A' },
  { index: 1, label: 'Demo key B' },
];
const demoAddress = (i: number) => p2pkhAddress(hash160(secp256k1.getPublicKey(fixtureMnKey(i), true)), 'mainnet');

interface SimVote {
  id: string;
  relay: string;
  v: SignedVoteRecord;
  status: RelayVoteStatus;
  acceptedAt: number;
  /** manual mode: stages advanced so far (0 held, 1 broadcast, 2 seen) */
  stage: number;
  holdUntil: number | null;
  broadcastAt: number | null;
}

const nowS = () => Math.floor(Date.now() / 1000);
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

export class VoteSim {
  readonly scenario: SimScenario;
  readonly stepMs: number;
  private votes = new Map<string, SimVote>();
  private down: boolean;
  private readonly base = new FixtureBridge();
  private baseVotes = new Map<string, Promise<BridgeVotes>>();
  readonly bridge: Bridge;

  constructor(scenario: SimScenario, stepMs = 1500) {
    this.scenario = scenario;
    this.stepMs = stepMs;
    this.down = scenario === 'down';
    const base = this.base;
    this.bridge = {
      name: 'fixture bridge',
      status: () => base.status(),
      proposals: () => base.proposals(),
      proposal: (h) => base.proposal(h),
      tallies: () => base.tallies(),
      cycle: () => base.cycle(),
      params: () => base.params(),
      mnlist: () => this.mnlist(),
      votes: (h) => this.bridgeVotes(h),
    };
  }

  /** Test and demo controls (fixture mode only): window.__voteSim. */
  controls() {
    return {
      advance: () => {
        for (const s of this.votes.values()) if (s.status === 'held' || s.status === 'broadcast') s.stage += 1;
      },
      up: () => void (this.down = false),
      down: () => void (this.down = true),
      votes: () => [...this.votes.values()].map((s) => ({ id: s.id, relay: s.relay, status: this.state(s).status })),
    };
  }

  private async mnlist(): Promise<BridgeMnList> {
    const l = await this.base.mnlist();
    const a = demoAddress(0);
    return { ...l, masternodes: l.masternodes.map((m, i) => (i === 1 ? { ...m, type: 'evo' as const } : i === 2 ? { ...m, votingAddress: a } : m)) };
  }

  /** Advances a vote by the clock (auto) or by advance() calls (manual). */
  private state(s: SimVote): SimVote {
    if (s.status !== 'held' && s.status !== 'broadcast') return s;
    const t = nowS();
    if (this.scenario === 'manual') {
      if (s.stage >= 1 && s.status === 'held') Object.assign(s, { status: 'broadcast', broadcastAt: t });
      if (s.stage >= 2 && s.status === 'broadcast') s.status = 'confirmed';
      return s;
    }
    const due = Math.max(s.v.releaseAt, s.holdUntil ?? 0);
    const step = this.stepMs / 1000;
    if (s.status === 'held' && t >= due && Date.now() / 1000 >= s.acceptedAt + step) Object.assign(s, { status: 'broadcast', broadcastAt: Math.max(t, Math.ceil(s.acceptedAt + step)) });
    if (s.status === 'broadcast' && s.broadcastAt !== null && Date.now() / 1000 >= s.broadcastAt + 2 * step) s.status = 'confirmed';
    return s;
  }

  private view(s: SimVote): RelayVoteState {
    const x = this.state(s);
    const held = x.status === 'held';
    return {
      id: x.id,
      voteHash: x.v.voteHash,
      status: x.status,
      releaseAt: x.v.releaseAt,
      broadcastAt: x.broadcastAt,
      confirmedAt: x.status === 'confirmed' ? x.broadcastAt : null,
      lastError: held && x.holdUntil ? 'hour-rule' : null,
      nextAttemptAt: held ? Math.max(x.v.releaseAt, x.holdUntil ?? 0) : null,
      holdReason: held ? (x.holdUntil ? 'one-change-per-hour' : 'release-time') : null,
      sameAsCurrent: false,
    };
  }

  relay(url: string): RelayPort {
    const unreachable = () => new RelayError(`relay ${url} unreachable: Load failed`);
    return {
      submit: async (v) => {
        await new Promise((r) => setTimeout(r, 250));
        if (this.down) throw unreachable();
        const known = [...this.votes.values()].find((s) => s.v.voteHash === v.voteHash && s.relay === url);
        if (known) return this.view(known);
        const s: SimVote = { id: hex(16), relay: url, v, status: 'held', acceptedAt: Date.now() / 1000, stage: 0, holdUntil: this.scenario === 'hour' ? nowS() + 1800 : null, broadcastAt: null };
        this.votes.set(s.id, s);
        return this.view(s);
      },
      status: async (id) => {
        if (this.down) throw unreachable();
        const s = this.votes.get(id);
        return s && s.relay === url ? this.view(s) : null;
      },
      cancel: async (id) => {
        if (this.down) throw unreachable();
        const s = this.votes.get(id);
        if (!s) throw new RelayError('unknown vote id', 404, 'unknown-id');
        if (this.state(s).status !== 'held') throw new RelayError(`the vote is ${s.status}`, 409, 'not-held', s.status);
        s.status = 'cancelled';
        return 'cancelled';
      },
      health: async () => (this.down ? { ok: false, error: `relay ${url} unreachable: Load failed`, checkedAt: Date.now() } : { ok: true, network: 'mainnet', coreReachable: true, held: [...this.votes.values()].filter((s) => s.relay === url && this.state(s).status === 'held').length, checkedAt: Date.now() }),
    };
  }

  /** The fixture bridge's vote set with the votes this sim has "broadcast", recounted (voteSetHash) with the sim's list. */
  private async bridgeVotes(govHash: string): Promise<BridgeVotes> {
    let p = this.baseVotes.get(govHash);
    if (!p) this.baseVotes.set(govHash, (p = this.base.votes(govHash)));
    const vs = await p;
    const seen = [...this.votes.values()].map((s) => this.state(s)).filter((s) => s.status === 'confirmed' && s.v.govHash === govHash);
    if (!seen.length) return vs;
    const byMn = new Map<string, BridgeVote>(vs.votes.map((v) => [normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`), v]));
    for (const s of seen) {
      const k = normalizeMnId(`${s.v.collateralTxid}-${s.v.collateralIndex}`);
      if ((byMn.get(k)?.time ?? -1) < s.v.time) byMn.set(k, { collateralTxid: s.v.collateralTxid, collateralIndex: s.v.collateralIndex, signal: 1, outcome: s.v.outcome, time: s.v.time, sig: s.v.sig });
    }
    const votes = [...byMn.values()];
    const list = await this.mnlist();
    const weights = new Map(list.masternodes.map((m) => [normalizeMnId(`${m.collateralTxid}-${m.collateralIndex}`), m.type === 'evo' ? 4 : 1]));
    const t = countVotes(
      votes.map((v) => ({ mn: normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`), outcome: v.outcome, time: v.time })),
      weights,
    );
    return { ...vs, votes, voteSetHash: t.voteSetHash, mnListHash: list.listHash };
  }
}

/** Reads `?votesim=` once per tab (kept in sessionStorage like `?fixtures=`). */
export function simScenario(search: string, session: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.sessionStorage): SimScenario {
  const p = new URLSearchParams(search).get('votesim');
  const ok = (x: string | null): x is SimScenario => x === 'auto' || x === 'manual' || x === 'down' || x === 'hour';
  if (ok(p)) session?.setItem('govhub.votesim', p);
  const s = session?.getItem('govhub.votesim') ?? null;
  return ok(s) ? s : 'auto';
}
