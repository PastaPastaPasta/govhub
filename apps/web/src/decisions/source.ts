// Masternode poll reads. Live: evo-sdk's proof-verifying decision proposal queries on the profile's Platform network (the same SDK as
// every other read). Fixtures: a small fixed set, for tests and screenshots.
//
// Whether a network has masternode polls at all is read, never assumed: the decision proposals contract exists from protocol
// version 15, so a proved read of it says yes (it is there) or no (a proof that it is absent). Until then the pages wait, and they
// read it again every few minutes: mainnet lights up by itself when it moves to version 15. (`sdk.version()` cannot tell: the SDK
// starts at 14 on every network and only moves up once a verified answer says the network is newer.)
import { mapLimit } from '@govhub/forum';
import { CREDITS_PER_DUFF, errText } from '../lib/format.ts';
import type { Registry } from '../config/registry.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import { loadFixtures } from '../data/fixtures.ts';
import { getSdk } from '../data/platform.ts';
import type { CoreNetwork } from '../data/types.ts';
import { openVotePolls, TtlCache } from '../contests/source.ts';
import { resourceChoice, signMasternodeVote, type Choice, type VoteToSign } from '../contests/vote.ts';
import { FIXTURE_POLLS, FIXTURE_TOTAL_POWER, type FixturePoll } from './fixtures.ts';
import { CHOICE_FUND_DUFFS, DECISIONS_CONTRACT_ID, requiredPower, totalVotingPower, type ChoicePoll, type ChoiceState, type Poll, type PollChoice, type PollKind, type YesNoPoll, type YesNoState } from './model.ts';

type EvoModule = typeof import('@dashevo/evo-sdk');

export interface PollPage {
  polls: Poll[];
  /** pass as `after` for the next page; null at the end */
  next: string | null;
}

/** One version of a poll's text, oldest first (Platform keeps every version). */
export interface Revision {
  revision: number;
  /** ms */
  at: number;
  title: string;
  description?: string;
  url: string | null;
}

/** Signs one vote on a poll (keys in JS, see contests/vote.ts signMasternodeVote). */
export type PollSigner = (mod: EvoModule, v: VoteToSign & { choice: Choice }) => Uint8Array;

export interface DecisionSource {
  readonly network: CoreNetwork;
  /** False in fixture mode: nothing is sent. */
  readonly live: boolean;
  /** Whether this network has masternode polls (protocol version 15): a proved read of the contract. */
  available(): Promise<boolean>;
  /** Yes/no polls still open, closing soonest first. */
  openYesNo(): Promise<YesNoPoll[]>;
  /** Multiple choice polls whose vote is open: poll id → when it closes (ms). `fresh`: not from the minute-long cache. */
  openChoices(fresh?: boolean): Promise<Map<string, number>>;
  /** One page of every poll of a kind, newest first. */
  page(kind: PollKind, after?: string): Promise<PollPage>;
  /** An identity's polls, both kinds, newest first. */
  byOwner(ownerId: string): Promise<Poll[]>;
  /** A poll by id, of either kind; null when there is none. */
  get(id: string): Promise<Poll | null>;
  /** What entering a choice now costs (the contest's fund to join), in duffs. */
  choiceFund(id: string): Promise<number>;
  /** A yes/no poll's state (cached for a minute); null when Platform has none. */
  yesNoState(id: string): Promise<YesNoState | null>;
  /** The vote among a multiple choice poll's choices (cached for a minute). */
  choiceState(id: string): Promise<ChoiceState>;
  /** Drops a poll's cached state, so the next read is fresh. */
  forget(id: string): void;
  /** Every version of the poll's text, oldest first. */
  history(poll: Poll): Promise<Revision[]>;
  /** Each masternode's current answer (by proTxHash): a choice, null for none. Proved reads. */
  votesOf(kind: PollKind, id: string, proTxHashes: readonly string[]): Promise<Map<string, Choice | null>>;
  /** The network's masternode voting power from the current masternode list (DAPI, agreed by several nodes); null where unknown. */
  totalPower(): Promise<number | null>;
  /** Reads what signing a vote on this poll needs (its poll id), then signs without awaiting. */
  signer(kind: PollKind, id: string): Promise<PollSigner>;
}

const TTL_MS = 60_000;
/** How long "not yet" is believed before the contract is read again. */
const UNAVAILABLE_TTL_MS = 5 * 60_000;
const PAGE = 50;
const MAX_PAGES = 10;
const HISTORY_PAGE = 10;
const HISTORY_MAX_PAGES = 10;

const num = (v: unknown): number | null => {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const idStr = (v: unknown): string | null => (typeof v === 'string' ? v : v && typeof (v as { toString?: unknown }).toString === 'function' ? String(v) : null);

type Json = Record<string, unknown>;
const jsonOf = (d: unknown): Json | null => (d && typeof (d as { toJSON?: unknown }).toJSON === 'function' ? ((d as { toJSON(): Json }).toJSON() ?? null) : null);

/** A `proposal` document as a yes/no poll; null when it lacks a field Platform requires (never from a proved read). */
export function toYesNo(j: Json | null): YesNoPoll | null {
  if (!j) return null;
  const id = str(j.$id);
  const ownerId = str(j.$ownerId);
  const title = str(j.title);
  const description = typeof j.description === 'string' ? j.description : null;
  const passPercent = num(j.passPercent);
  const minimumTurnoutPercent = num(j.minimumTurnoutPercent);
  const endDate = num(j.endDate);
  const createdAt = num(j.$createdAt);
  if (!id || !ownerId || !title || description === null || passPercent === null || minimumTurnoutPercent === null || endDate === null || createdAt === null) return null;
  return { kind: 'yn', id, ownerId, title, description, url: str(j.url), passPercent, minimumTurnoutPercent, endDate, createdAt, updatedAt: num(j.$updatedAt) ?? createdAt, revision: num(j.$revision) ?? 1 };
}

/** A `multipleChoiceProposal` document as a multiple choice poll. */
export function toChoicePoll(j: Json | null): ChoicePoll | null {
  if (!j) return null;
  const id = str(j.$id);
  const ownerId = str(j.$ownerId);
  const title = str(j.title);
  const createdAt = num(j.$createdAt);
  if (!id || !ownerId || !title || createdAt === null || typeof j.open !== 'boolean') return null;
  const dId = str(j.descriptionId);
  const dContract = str(j.descriptionContractId);
  const dType = str(j.descriptionDocumentType);
  return {
    kind: 'mc',
    id,
    ownerId,
    title,
    url: str(j.url),
    description: dId && dContract && dType ? { id: dId, contractId: dContract, documentType: dType } : null,
    open: j.open,
    createdAt,
    updatedAt: num(j.$updatedAt) ?? createdAt,
    revision: num(j.$revision) ?? 1,
  };
}

const blockMs = (b: unknown): number | null => num((b as { timeMs?: unknown } | null | undefined)?.timeMs);

interface RawYesNoState {
  status: string;
  result?: { passed: boolean; yesVotingPower: number; noVotingPower: number; abstainVotingPower: number; requiredVotingPower: number; finalizationBlock?: unknown };
  yesVotingPower?: number;
  noVotingPower?: number;
  abstainVotingPower?: number;
}

export function toYesNoState(raw: RawYesNoState): YesNoState {
  const r = raw.result;
  if (raw.status === 'finished' && r)
    return {
      status: 'finished',
      tally: { yes: num(r.yesVotingPower) ?? 0, no: num(r.noVotingPower) ?? 0, abstain: num(r.abstainVotingPower) ?? 0 },
      result: { passed: r.passed === true, required: num(r.requiredVotingPower) ?? 0, at: blockMs(r.finalizationBlock) },
    };
  return { status: 'open', tally: { yes: num(raw.yesVotingPower) ?? 0, no: num(raw.noVotingPower) ?? 0, abstain: num(raw.abstainVotingPower) ?? 0 }, result: null };
}

function finishChoiceState(choices: PollChoice[], abstain: number, none: number, result: ChoiceState['result']): ChoiceState {
  choices.sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  return { choices, abstain, none, total: choices.reduce((s, c) => s + c.votes, 0) + abstain + none, result };
}

/** A masternode's answer as the SDK gives it, as a vote choice. */
function yesNoChoice(v: { choice?: unknown } | undefined): Choice | null {
  const c = v?.choice;
  return c === 'yes' || c === 'no' || c === 'abstain' ? { kind: c } : null;
}
function multipleChoice(v: unknown): Choice | null {
  if (v === 'abstain') return { kind: 'abstain' };
  if (v === 'noneOfTheChoices') return { kind: 'lock' };
  const id = idStr((v as { choiceId?: unknown } | null | undefined)?.choiceId);
  return id ? { kind: 'contender', identityId: id } : null;
}

/** The SDK's own vote for a yes/no poll, named by its poll id. */
function yesNoVote(mod: EvoModule, pollId: string, c: Choice): InstanceType<EvoModule['Vote']> {
  if (c.kind !== 'yes' && c.kind !== 'no' && c.kind !== 'abstain') throw new Error('A yes/no poll takes yes, no or abstain.');
  return mod.Vote.fromJSON({ $type: 'yesNoVote', $formatVersion: '0', votePollId: pollId, voteChoice: c.kind });
}

/**
 * A Platform node not yet serving the decision proposals contract (behind on protocol 15; about one in five on testnet now, and
 * on mainnet while nodes catch up after activation) refuses a poll query with "contract not found", and the SDK does not ask
 * another node. Such a read is asked again: each request goes to another node.
 */
const LAGGING_NODE = /contract not found/i;
export async function onAnyNode<T>(read: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (i >= tries || !LAGGING_NODE.test(errText(e))) throw e;
    }
  }
}

// one cache per source scope, so a profile switch never shows another network's polls
const caches = new Map<string, { avail: TtlCache<boolean>; yn: TtlCache<YesNoState | null>; mc: TtlCache<ChoiceState>; polls: TtlCache<Poll | null>; pollIds: Map<string, Promise<string>>; power: TtlCache<number | null> }>();

export function liveDecisions(r: Registry): DecisionSource {
  const scope = `decisions:${r.platformNetwork}:${JSON.stringify(r.platform)}`;
  let c = caches.get(scope);
  if (!c) caches.set(scope, (c = { avail: new TtlCache(UNAVAILABLE_TTL_MS), yn: new TtlCache(TTL_MS), mc: new TtlCache(TTL_MS), polls: new TtlCache(TTL_MS), pollIds: new Map(), power: new TtlCache(5 * 60_000) }));
  const cache = c;
  const sdk = () => getSdk(r);
  let yes = false;

  async function pages<T>(read: (after?: string) => Promise<Map<string, unknown>>, map: (d: unknown) => T | null): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const m = await read(after);
      for (const d of m.values()) {
        const x = map(d);
        if (x) out.push(x);
      }
      if (m.size < 100) break;
      after = [...m.keys()].at(-1);
    }
    return out;
  }

  const readPoll = async (id: string): Promise<Poll | null> => {
    const s = await sdk();
    const [yn, mc] = await Promise.all([onAnyNode(() => s.decisionProposals.get(id)), onAnyNode(() => s.decisionProposals.multipleChoice.get(id))]);
    return toYesNo(jsonOf(yn)) ?? toChoicePoll(jsonOf(mc));
  };

  const pollId = (id: string): Promise<string> => {
    let p = cache.pollIds.get(id);
    if (!p) {
      p = sdk().then(async (s) => (await onAnyNode(() => s.decisionProposals.pollId(id))).toString());
      cache.pollIds.set(id, p);
      p.catch(() => cache.pollIds.delete(id));
    }
    return p;
  };

  return {
    network: r.platformNetwork,
    live: true,
    available() {
      // once it is there it stays: only "not yet" is read again
      if (yes) return Promise.resolve(true);
      return cache.avail.get('contract', async () => {
        const has = !!(await (await sdk()).contracts.fetch(DECISIONS_CONTRACT_ID));
        if (has) yes = true;
        return has;
      });
    },
    openYesNo: () =>
      sdk().then((s) =>
        pages(
          (after) => onAnyNode(() => s.decisionProposals.byEndDate({ endDateFrom: Date.now(), limit: 100, ...(after ? { startAfter: after } : {}) })),
          (d) => toYesNo(jsonOf(d)),
        ),
      ),
    async openChoices(fresh) {
      const out = new Map<string, number>();
      for (const { poll: p, endsAt } of await openVotePolls(r, fresh)) {
        if (p.contractId !== DECISIONS_CONTRACT_ID || p.documentTypeName !== 'choice') continue;
        const id = idStr(p.indexValues?.[0]);
        if (id) out.set(id, endsAt);
      }
      return out;
    },
    async page(kind, after) {
      const s = await sdk();
      const q = { limit: PAGE, ...(after ? { startAfter: after } : {}) };
      const m = await onAnyNode(() => (kind === 'yn' ? s.decisionProposals.byCreatedAt(q) : s.decisionProposals.multipleChoice.byCreatedAt(q)));
      const polls: Poll[] = [];
      for (const d of m.values()) {
        const p = kind === 'yn' ? toYesNo(jsonOf(d)) : toChoicePoll(jsonOf(d));
        if (p) polls.push(p);
      }
      return { polls, next: m.size < PAGE ? null : ([...m.keys()].at(-1) ?? null) };
    },
    async byOwner(ownerId) {
      const s = await sdk();
      const [yn, mc] = await Promise.all([
        pages((after) => onAnyNode(() => s.decisionProposals.byOwner({ ownerId, limit: 100, ...(after ? { startAfter: after } : {}) })), (d) => toYesNo(jsonOf(d))),
        pages((after) => onAnyNode(() => s.decisionProposals.multipleChoice.byOwner({ ownerId, limit: 100, ...(after ? { startAfter: after } : {}) })), (d) => toChoicePoll(jsonOf(d))),
      ]);
      return [...yn, ...mc].sort((a, b) => b.createdAt - a.createdAt);
    },
    // a poll not found is not kept: a node that lags behind its create may answer that for a moment
    get: (id) =>
      cache.polls.get(id, () => readPoll(id)).then((p) => {
        if (!p) cache.polls.delete(id);
        return p;
      }),
    async choiceFund(id) {
      const s = await sdk();
      return Number((await onAnyNode(() => s.decisionProposals.multipleChoice.choiceFund(id))) / BigInt(CREDITS_PER_DUFF));
    },
    yesNoState: (id) =>
      cache.yn.get(id, async () => {
        const s = await sdk();
        const st = await onAnyNode(() => s.decisionProposals.pollState(id));
        return st ? toYesNoState(st as unknown as RawYesNoState) : null;
      }),
    choiceState: (id) =>
      cache.mc.get(id, async () => {
        const s = await sdk();
        const v = await onAnyNode(() => s.decisionProposals.multipleChoice.voteState(id));
        const keptId = v.result ? idStr(v.result.keptChoiceId) : null;
        // once the vote ended only the kept choice's text is still in state
        const kept = keptId ? jsonOf(await onAnyNode(() => s.decisionProposals.multipleChoice.keptChoice(id)).catch(() => undefined)) : null;
        const choices: PollChoice[] = [];
        for (const [cid, entry] of v.choices) {
          const j = jsonOf(entry.choice) ?? (cid === keptId ? kept : null);
          choices.push({
            id: cid,
            votes: num(entry.voteTally) ?? 0,
            ...(str(j?.title) ? { title: str(j?.title)! } : {}),
            ...(typeof j?.description === 'string' ? { description: j.description } : {}),
            ...(str(j?.$ownerId) ? { ownerId: str(j?.$ownerId)! } : {}),
          });
        }
        return finishChoiceState(choices, num(v.abstainVoteTally) ?? 0, num(v.noneOfTheChoicesVoteTally) ?? 0, v.result ? { keptId, at: blockMs(v.result.finalizationBlock) } : null);
      }),
    forget(id) {
      cache.yn.delete(id);
      cache.mc.delete(id);
    },
    async history(poll) {
      if (poll.revision <= 1) return [];
      const s = await sdk();
      const out: Revision[] = [];
      let after: { timeMs: bigint; revision: bigint } | undefined;
      for (let i = 0; i < HISTORY_MAX_PAGES; i++) {
        const res = await onAnyNode(() => s.documents.history({
          dataContractId: DECISIONS_CONTRACT_ID,
          documentTypeName: poll.kind === 'yn' ? 'proposal' : 'multipleChoiceProposal',
          documentId: poll.id,
          limit: HISTORY_PAGE,
          ...(after ? { startAfter: after } : {}),
        }));
        for (const e of res.entries) {
          const j = jsonOf(e.document);
          const title = str(j?.title);
          if (!title) continue;
          out.push({ revision: num(e.revision) ?? 0, at: num(e.timeMs) ?? 0, title, ...(typeof j?.description === 'string' ? { description: j.description } : {}), url: str(j?.url) });
        }
        const last = res.entries.at(-1);
        if (res.entries.length < HISTORY_PAGE || !last) break;
        after = { timeMs: BigInt(last.timeMs), revision: BigInt(last.revision) };
      }
      return out.sort((a, b) => a.revision - b.revision);
    },
    async votesOf(kind, id, proTxHashes) {
      const s = await sdk();
      const out = new Map<string, Choice | null>();
      await mapLimit([...proTxHashes], 4, async (pro) => {
        const v = kind === 'yn' ? yesNoChoice(await onAnyNode(() => s.decisionProposals.masternodeVote(pro, id))) : multipleChoice(await onAnyNode(() => s.decisionProposals.multipleChoice.masternodeVote(pro, id)));
        out.set(pro, v);
      });
      return out;
    },
    totalPower: () =>
      cache.power.get('sml', async () => {
        // the masternode list comes from Core: only a profile whose Core network is the polls' network has the right one
        if (r.coreNetwork !== r.platformNetwork) return null;
        const sml = await createWebDapi(dapiConfig(r)).getSml();
        return totalVotingPower(sml.masternodes);
      }),
    async signer(kind, id) {
      if (kind === 'yn') {
        const pid = await pollId(id);
        return (mod, v) => signMasternodeVote(mod, v, yesNoVote(mod, pid, v.choice));
      }
      // the contest is keyed by the proposal's id as an identifier value: the SDK builds it (a string would name another poll)
      const w = await (await sdk()).getWasmSdkConnected();
      return (mod, v) => signMasternodeVote(mod, v, new mod.Vote(w.getMultipleChoiceProposalVotePoll(id), resourceChoice(mod, v.choice)));
    },
  };
}

// ---- fixtures ----------------------------------------------------------------------------------

const fixtureNow = async () => (await loadFixtures()).now * 1000;

function fixturePoll(f: FixturePoll, now: number): Poll {
  const createdAt = now + f.createdInMs;
  if (f.kind === 'yn') return { kind: 'yn', id: f.id, ownerId: f.ownerId, title: f.title, description: f.description, url: f.url, passPercent: f.passPercent, minimumTurnoutPercent: f.minimumTurnoutPercent, endDate: now + f.endsInMs, createdAt, updatedAt: createdAt, revision: 1 };
  return { kind: 'mc', id: f.id, ownerId: f.ownerId, title: f.title, url: f.url, description: null, open: f.open, createdAt, updatedAt: createdAt, revision: 1 };
}

/** Fixtures: times are relative to the snapshot's frozen clock. */
export function fixtureDecisions(): DecisionSource {
  const all = async () => {
    const now = await fixtureNow();
    return FIXTURE_POLLS.map((f) => ({ f, p: fixturePoll(f, now), now })).sort((a, b) => b.p.createdAt - a.p.createdAt);
  };
  const find = async (id: string) => (await all()).find((x) => x.f.id === id);
  return {
    network: 'mainnet',
    live: false,
    available: async () => true,
    async openYesNo() {
      return (await all())
        .flatMap((x) => (x.f.kind === 'yn' && x.f.endsInMs > 0 && x.p.kind === 'yn' ? [x.p] : []))
        .sort((a, b) => a.endDate - b.endDate);
    },
    async openChoices() {
      const now = await fixtureNow();
      return new Map(FIXTURE_POLLS.flatMap((f) => (f.kind === 'mc' && f.endsInMs !== null && f.endsInMs > 0 ? [[f.id, now + f.endsInMs] as [string, number]] : [])));
    },
    async page(kind) {
      return { polls: (await all()).map((x) => x.p).filter((p) => p.kind === kind), next: null };
    },
    async byOwner(ownerId) {
      return (await all()).map((x) => x.p).filter((p) => p.ownerId === ownerId);
    },
    get: async (id) => (await find(id))?.p ?? null,
    choiceFund: async () => CHOICE_FUND_DUFFS,
    async yesNoState(id) {
      const x = await find(id);
      if (!x || x.f.kind !== 'yn') return null;
      const f = x.f;
      return f.endsInMs > 0
        ? { status: 'open', tally: f.tally, result: null }
        : { status: 'finished', tally: f.tally, result: { passed: f.passed ?? false, required: requiredPower(FIXTURE_TOTAL_POWER, f.minimumTurnoutPercent), at: x.now + f.endsInMs } };
    },
    async choiceState(id) {
      const x = await find(id);
      if (!x || x.f.kind !== 'mc') return finishChoiceState([], 0, 0, null);
      const f = x.f;
      const ended = f.endsInMs !== null && f.endsInMs <= 0;
      const choices = f.choices.map((c) => (ended && c.id !== f.keptId ? { id: c.id, votes: c.votes } : { ...c }));
      return finishChoiceState(choices, f.abstain, f.none, ended ? { keptId: f.keptId ?? null, at: x.now + f.endsInMs! } : null);
    },
    forget: () => {},
    history: async () => [],
    async votesOf(_kind, _id, proTxHashes) {
      return new Map(proTxHashes.map((p) => [p, null]));
    },
    totalPower: async () => FIXTURE_TOTAL_POWER,
    signer: async () => () => new Uint8Array(),
  };
}
