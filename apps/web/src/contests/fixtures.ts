// Fixture contests (fixture mode, tests, screenshots): made-up names and identities, shaped like mainnet's. Times are relative to the
// snapshot's frozen clock.
import type { Contender } from './model.ts';

type FixtureOutcome = { kind: 'won'; identityId: string; agoMs: number | null } | { kind: 'locked' | 'none'; agoMs: number | null };

export interface FixtureContest {
  label: string;
  /** ms until it closes; null once decided */
  endsInMs: number | null;
  contenders: Contender[];
  abstain: number;
  lock: number;
  outcome: FixtureOutcome | null;
}

const H = 3_600_000;
const D = 24 * H;

const FIXTURE_IDS = [
  'eUJLdV1mRNVYAMdHYV3nSiwKu2EBB1jGfVKUuCDeUE2',
  '3Yos9bTgS21oDhEqc99f5Eyvq1axrvznkTLAjhiAXCat',
  '6Vod1LcUSNriFtUMBut7ZRkSkHMN2Fzv8FQPQEJETcpX',
  '2d5vGnPGhMFLntzMQyxPqMNRTWybNcJZiPoVpUtvc9FZ',
  '4jVrALDLEUctcWd7W4tAdZaNuhavUsSn4jfjs4gQdPFe',
  'D9jCWY7FotEHVnfiHbJvDGf9Lk2dpPnF63G7VL3hfzM5',
  'DwPsZSuonTf6j5J4Nw5z2pn7Kn3YVtwENkH771UESGjq',
  '3AdRwrEUPiVR6dUeNT2yqyjcykRqZQcUDfgq8ywPyKa9',
  '99tMTy297rwo3bghCK4KK9DVqUhhEM5J5FQEkJgL8vQS',
  '9arcaWEfnYQpGmn2UPYmbiZjZN64V8zqvRaqYBhHh2iu',
] as const;
const [A, B, C, E, F, G, I, J, K, L] = FIXTURE_IDS;
/** The two contenders for TheRoadNotTaken (the fixture forum gives them a discussion). */
export const ROAD_CONTENDERS = [A, B] as const;

const open = (label: string, endsInMs: number, contenders: Contender[], abstain = 0, lock = 0): FixtureContest => ({ label, endsInMs, contenders, abstain, lock, outcome: null });
const won = (label: string, agoMs: number, contenders: Contender[], abstain = 0, lock = 0): FixtureContest => ({
  label,
  endsInMs: null,
  contenders,
  abstain,
  lock,
  outcome: { kind: 'won', identityId: [...contenders].sort((a, b) => b.votes - a.votes)[0]!.identityId, agoMs },
});

export const FIXTURE_CONTESTS: FixtureContest[] = [
  open('ther0adn0ttaken', 3.2 * D, [
    { identityId: A, votes: 212, requested: 'TheRoadNotTaken' },
    { identityId: B, votes: 87, requested: 'theroadnottaken' },
  ], 12, 4),
  open('sat0sh1', 9 * H, [{ identityId: C, votes: 41, requested: 'Satoshi' }], 3, 96),
  open('ga1axy', 11.5 * D, [{ identityId: E, votes: 0, requested: 'Galaxy' }]),
  open('m00n-wa1k', 6.8 * D, [
    { identityId: F, votes: 18, requested: 'Moon-Walk' },
    { identityId: G, votes: 22, requested: 'moon-walk' },
    { identityId: I, votes: 5, requested: 'MOON-WALK' },
  ], 2, 0),
  won('a1pha', 40 * D, [{ identityId: J, votes: 301, requested: 'Alpha' }], 8, 2),
  won('dashpay', 120 * D, [
    { identityId: K, votes: 655, requested: 'DashPay' },
    { identityId: L, votes: 19, requested: 'dashpay' },
  ], 4, 30),
  { label: 'free-m0ney', endsInMs: null, contenders: [{ identityId: B, votes: 3, requested: 'Free-Money' }], abstain: 1, lock: 240, outcome: { kind: 'locked', agoMs: 75 * D } },
  won('w0r1d', 210 * D, [{ identityId: C, votes: 120, requested: 'World' }]),
];
