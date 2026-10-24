// Fixture mode: the 28 real mainnet proposals from packages/verify (Core at height 2,560,391),
// shaped exactly like `gov` documents, plus a cycle and tallies derived the way the bridge will
// derive them. The clock is frozen at the snapshot time so every page renders deterministically.
import { parseProposalData } from '@govhub/verify';
import { DUFFS_PER_DASH } from '../lib/format.ts';
import { GOV_PARAMS, absoluteYes, fundingThreshold, rankProposals, selectBudget } from '../lib/governance.ts';
import { BridgeError, type Bridge, type BridgeMnList, type BridgeStatus, type BridgeVotes } from './bridge.ts';
import { fixtureMasternodes, fixtureMnCount, fixtureSignedVotes, fixtureVoteSetHash } from './fixtureVotes.ts';
import { loadRecordedBridge, type RecordedBridge } from './recordedBridge.ts';
import type { Cycle, Proposal, Tally } from './types.ts';

interface RawFixture {
  fetchedAt: number;
  blockHeight: number;
  proposals: Array<{ hash: string; collateralHash: string; creationTime: number; dataHex: string; yes: number; no: number; abstain: number; confirmations: number }>;
}

/**
 * Mainnet facts at the snapshot (getgovernanceinfo / getsuperblockbudget on 2026-10-23):
 * next superblock 2,575,480, budget 6,828.2637816 DASH, funding threshold 332, so the weighted
 * valid MN count is in 3,320..3,329 (3,320 is used).
 */
const NEXT_SUPERBLOCK = 2_575_480;
const BUDGET_DUFFS = 682_826_378_160;
const VALID_WEIGHTED = 3_320;

export interface FixtureSnapshot {
  now: number;
  height: number;
  proposals: Proposal[];
  tallies: Map<string, Tally>;
  cycle: Cycle;
  /** Real signed votes and masternodes recorded from a mainnet bridge, for the proposals they cover. The rest use synthetic voters. */
  recorded: RecordedBridge;
}

let snapshot: Promise<FixtureSnapshot> | null = null;

export function loadFixtures(): Promise<FixtureSnapshot> {
  snapshot ??= Promise.all([import('../../../../packages/verify/test/fixtures/mainnet-proposals.json'), loadRecordedBridge()]).then(([m, rec]) => buildSnapshot(m.default as unknown as RawFixture, rec));
  return snapshot;
}

export function buildSnapshot(raw: RawFixture, recorded: RecordedBridge): FixtureSnapshot {
  const params = GOV_PARAMS.mainnet;
  const now = raw.fetchedAt;
  const height = raw.blockHeight;
  const proposals: Proposal[] = raw.proposals.map((r) => {
    const f = parseProposalData(r.dataHex).fields;
    if (!f) throw new Error(`fixture proposal ${r.hash} does not parse`);
    return {
      govHash: r.hash,
      parentHash: '0'.repeat(64),
      revision: 1,
      time: r.creationTime,
      dataHex: r.dataHex,
      name: f.name,
      url: f.url,
      paymentAddress: f.paymentAddress,
      paymentAmount: Math.round(f.paymentAmount * DUFFS_PER_DASH),
      startEpoch: f.startEpoch,
      endEpoch: f.endEpoch,
      collateralTxid: r.collateralHash,
      collateralHeight: height - r.confirmations + 1,
      createdAt: (r.creationTime + 3600) * 1000,
    };
  });

  const estTime = Math.round(now + (NEXT_SUPERBLOCK - height) * params.blockSeconds);
  const threshold = fundingThreshold(VALID_WEIGHTED, params);
  const byHash = new Map(raw.proposals.map((r) => [r.hash, r]));
  const entries = proposals.map((p) => {
    const r = byHash.get(p.govHash)!;
    return { govHash: p.govHash, absYes: r.yes - r.no, amount: p.paymentAmount, startEpoch: p.startEpoch, endEpoch: p.endEpoch };
  });
  const sel = selectBudget(entries, BUDGET_DUFFS, threshold, estTime);
  const rankOf = new Map(rankProposals(entries).map((e, i) => [e.govHash, i + 1]));

  const tallies = new Map<string, Tally>();
  for (const p of proposals) {
    const r = byHash.get(p.govHash)!;
    // Where real votes were recorded, the MN counts and voteSetHash are theirs (evonodes weigh 4, so counts differ from weighted).
    // Elsewhere the voters are synthetic regular MNs (weight 1), so MN counts equal weighted counts.
    const rec = recorded.proposals.get(p.govHash);
    const t: Tally = {
      govHash: p.govHash,
      asOfHeight: rec ? recorded.height : height,
      yesWeighted: r.yes,
      noWeighted: r.no,
      abstainWeighted: r.abstain,
      yesCount: rec?.tally.yesCount ?? r.yes,
      noCount: rec?.tally.noCount ?? r.no,
      abstainCount: rec?.tally.abstainCount ?? r.abstain,
      voteSetHash: rec?.tally.voteSetHash ?? fixtureVoteSetHash({ yes: r.yes, no: r.no, abstain: r.abstain }, p.time),
      rank: rankOf.get(p.govHash)!,
      inNextBudget: sel.funded.has(p.govHash),
      margin: 0,
    };
    t.margin = absoluteYes(t) - threshold;
    tallies.set(p.govHash, t);
  }

  const cycle: Cycle = {
    superblockHeight: NEXT_SUPERBLOCK,
    budget: BUDGET_DUFFS,
    allocated: sel.allocated,
    votingDeadlineHeight: NEXT_SUPERBLOCK - params.maturityWindow,
    estTime,
    validWeighted: VALID_WEIGHTED,
    paid: 0,
  };
  return { now, height, proposals, tallies, cycle, recorded };
}

/** A bridge that answers from the snapshot, including synthetic signed votes and MN list. */
export class FixtureBridge implements Bridge {
  readonly name = 'fixture bridge';
  private snap = loadFixtures();

  async status(): Promise<BridgeStatus> {
    const s = await this.snap;
    return { network: 'mainnet', height: s.height };
  }
  async proposals(): Promise<Proposal[]> {
    return (await this.snap).proposals;
  }
  async proposal(govHash: string): Promise<Proposal | null> {
    return (await this.snap).proposals.find((p) => p.govHash === govHash) ?? null;
  }
  async votes(govHash: string, opts: { height?: number } = {}): Promise<BridgeVotes> {
    const s = await this.snap;
    const p = s.proposals.find((x) => x.govHash === govHash);
    const t = s.tallies.get(govHash);
    const none = { govHash, asOfHeight: s.height, tallyHeight: s.height, mnListHash: null, voteSetHash: null, votes: [] };
    if (!p || !t) return none;
    // Like the real API: the set behind the tally in force at `height`; nothing recorded below the tally's own height.
    if (opts.height !== undefined && opts.height < t.asOfHeight) throw new BridgeError(`the bridge has no vote set at or below block ${opts.height}`, 404);
    const asOfHeight = opts.height ?? t.asOfHeight;
    const rec = s.recorded.proposals.get(govHash);
    if (rec) return { govHash, asOfHeight, tallyHeight: t.asOfHeight, mnListHash: s.recorded.listHash, voteSetHash: t.voteSetHash, votes: rec.votes, origin: 'recorded' };
    const counts = { yes: t.yesCount, no: t.noCount, abstain: t.abstainCount };
    return { govHash, asOfHeight, tallyHeight: t.asOfHeight, mnListHash: null, voteSetHash: t.voteSetHash, votes: fixtureSignedVotes(govHash, counts, p.time), origin: 'synthetic' };
  }
  async tallies(): Promise<Tally[]> {
    return [...(await this.snap).tallies.values()];
  }
  async cycle(): Promise<Cycle | null> {
    return (await this.snap).cycle;
  }
  async mnlist(height?: number): Promise<BridgeMnList> {
    const s = await this.snap;
    // The recorded snapshot serves the recorded proposals' height; every other height gets the synthetic voters' list.
    if (height !== undefined && height >= s.recorded.height) return { height: s.recorded.height, listHash: s.recorded.listHash, masternodes: s.recorded.masternodes };
    const max = Math.max(0, ...[...s.tallies.values()].filter((t) => !s.recorded.proposals.has(t.govHash)).map((t) => fixtureMnCount({ yes: t.yesCount, no: t.noCount, abstain: t.abstainCount })));
    return { height: s.height, listHash: 'fixture-synthetic', masternodes: fixtureMasternodes(max) };
  }
}
