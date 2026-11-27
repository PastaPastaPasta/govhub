// Fixture masternode polls (fixture mode, tests, screenshots): made-up questions and identities, shaped like testnet's. Times are
// relative to the snapshot's frozen clock.
import type { PollChoice, YesNoTally } from './model.ts';

const H = 3_600_000;
const D = 24 * H;

/** The network's voting power the fixtures assume (about mainnet's: some 2,300 masternodes and 500 evonodes). */
export const FIXTURE_TOTAL_POWER = 4312;

export type FixturePoll =
  | {
      kind: 'yn';
      id: string;
      ownerId: string;
      title: string;
      description: string;
      url: string | null;
      passPercent: number;
      minimumTurnoutPercent: number;
      /** ms from the snapshot's clock (negative: in the past) */
      createdInMs: number;
      endsInMs: number;
      tally: YesNoTally;
      passed?: boolean;
    }
  | {
      kind: 'mc';
      id: string;
      ownerId: string;
      title: string;
      url: string | null;
      open: boolean;
      createdInMs: number;
      /** null: no choice yet, so no vote */
      endsInMs: number | null;
      choices: PollChoice[];
      abstain: number;
      none: number;
      keptId?: string;
    };

const A = 'eUJLdV1mRNVYAMdHYV3nSiwKu2EBB1jGfVKUuCDeUE2';
const B = '3Yos9bTgS21oDhEqc99f5Eyvq1axrvznkTLAjhiAXCat';
const C = '6Vod1LcUSNriFtUMBut7ZRkSkHMN2Fzv8FQPQEJETcpX';

export const FIXTURE_POLLS: readonly FixturePoll[] = [
  {
    kind: 'yn',
    id: 'Bx4sgMPNXuZxZwnHa42sT7NKvzZsMpywSX9zDiYp69bK',
    ownerId: A,
    title: 'Should the next core release ship with the new fee schedule turned on?',
    description: 'Yes: the release turns the new fee schedule on at activation.\nNo: it ships turned off, for a later release to decide.',
    url: 'https://www.dash.org/forum/',
    passPercent: 60,
    minimumTurnoutPercent: 10,
    createdInMs: -3 * D,
    endsInMs: 11 * D,
    tally: { yes: 512, no: 196, abstain: 40 },
  },
  {
    kind: 'yn',
    id: 'EtVXH6bwz4ChrkAzo6VoQsUdGruLYkVuL2iPB4em91vW',
    ownerId: B,
    title: 'Fund a second independent audit of the mobile wallets?',
    description: 'Yes means masternode owners support a second audit next quarter. No means one audit a year is enough.',
    url: null,
    passPercent: 50,
    minimumTurnoutPercent: 20,
    createdInMs: -9 * D,
    endsInMs: 20 * H,
    tally: { yes: 301, no: 244, abstain: 12 },
  },
  {
    kind: 'mc',
    id: '6Gne8CbK4x4cYz1nzpk7hpXS5PuCELMeURkeEfrJjbtj',
    ownerId: C,
    title: 'Which city should host the next Dash conference?',
    url: 'https://www.dash.org/forum/',
    open: true,
    createdInMs: -2 * D,
    endsInMs: 12 * D,
    choices: [
      { id: '6RsvEUzoUgbvuZz9j3QiyDSSwYUqezYd1SXu8gqm53PY', title: 'Lisbon', description: 'Late spring, near the old town.', ownerId: C, votes: 388 },
      { id: '8zDEGNE9Pn18Tpd2ArxjjpXEcNwaVZsYjwNx5YA1yny9', title: 'Buenos Aires', ownerId: A, votes: 351 },
      { id: 'BWbhw2HW6hwCbHy95HjAGZiThEyC84QHqbqXuypjvCaf', title: 'Online only', description: 'No travel: talks streamed and kept online.', ownerId: B, votes: 97 },
    ],
    abstain: 21,
    none: 64,
  },
  {
    kind: 'yn',
    id: 'FGbXMd71LqMoGudmv9cnLEXvBkdymJMLfeEtz92faqcR',
    ownerId: A,
    title: 'Keep the testnet faucet limit at 5 DASH a day?',
    description: 'Yes keeps it. No asks the faucet operators to lower it to 1 DASH.',
    url: null,
    passPercent: 66,
    minimumTurnoutPercent: 5,
    createdInMs: -40 * D,
    endsInMs: -12 * D,
    tally: { yes: 655, no: 112, abstain: 30 },
    passed: true,
  },
  {
    kind: 'mc',
    id: '9ZQrCUi34TzLKqyE4jyMwQJbEJUjHdBArhu2D68bBocV',
    ownerId: B,
    title: 'Which color should the new testnet explorer use?',
    url: 'https://example.com/explorer-colours',
    open: false,
    createdInMs: -30 * D,
    endsInMs: -16 * D,
    choices: [
      { id: 'F726kRafkzKFveGNibmFzCg2vXhRA1VUhBpvGpFLqytj', title: 'Dash blue', ownerId: B, votes: 402 },
      { id: '5kskMkHbcEbu5WygRVBhvk5fVWcErB9HZiCRQA8L72Fo', votes: 233 },
    ],
    abstain: 18,
    none: 9,
    keptId: 'F726kRafkzKFveGNibmFzCg2vXhRA1VUhBpvGpFLqytj',
  },
];
