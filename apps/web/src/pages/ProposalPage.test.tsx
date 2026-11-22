// @vitest-environment happy-dom
// The proposal page for a lame duck (still on the network, nothing left that can pay it) against a proposal that has payments left.
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { formatDate } from '../lib/format.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import type { ChainReport } from '../verify/chain.ts';
import { render } from '../test/render.tsx';

const DAY = 86400;
const NOW = Date.UTC(2026, 9, 25) / 1000;
const prov = { kind: 'proof', source: 'test' } as const;

const hold = vi.hoisted(() => ({ tally: null as unknown, report: null as unknown, funded: null as unknown, cycle: null as unknown, keyring: 'open' }));
vi.mock('../app/context.tsx', () => ({
  useApp: () => ({
    source: { now: () => NOW, bridgeDescriptor: () => null },
    gov: { cycle: { data: hold.cycle }, bridgeTallies: new Map() },
    params: GOV_PARAMS.mainnet,
    checks: { state: () => ({ status: 'passed' }) },
  }),
}));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null }) }));
vi.mock('../ui/Discussion.tsx', () => ({ Discussion: () => null }));
vi.mock('../ui/ReadError.tsx', () => ({ ReadError: () => null }));
vi.mock('../ui/WriteError.tsx', () => ({ WriteError: () => null }));
vi.mock('../ui/SignIn.tsx', () => ({ openSignIn: () => {} }));
vi.mock('../ui/trust/TrustBadge.tsx', () => ({ TrustBadge: () => null }));
vi.mock('../ui/trust/VerificationDrawer.tsx', () => ({ VerificationDrawer: () => null }));
vi.mock('../ui/vote/VoteBlock.tsx', () => ({ mnParam: () => null, ProposalVoteBlock: ({ closesIn }: { closesIn: number | null }) => <div data-testid="vote-panel">{closesIn !== null && 'Voting closes in (the block)'}</div> }));
const owner = vi.hoisted(() => ({ page: null as unknown }));
vi.mock('../lib/ownerPages.ts', () => ({ useOwnerPage: () => owner.page }));
// these records stand for ones whose fields match their hash, unless a test says otherwise
const content = vi.hoisted(() => ({ problem: null as string | null }));
vi.mock('../verify/checks.ts', async (orig) => ({ ...(await orig<typeof import('../verify/checks.ts')>()), contentFailure: () => content.problem }));
vi.mock('../ui/trust/store.ts', () => ({ trustScope: () => 'test', useCachedTrust: () => null }));
vi.mock('../ui/Ownership.tsx', () => ({
  ClaimPanel: () => null,
  OwnerPost: () => null,
  OwnerValue: () => null,
  RejectedClaims: () => null,
  useOwnership: () => ({ verdict: null }),
  useOwnerPost: () => ({ state: null }),
}));
vi.mock('../ui/trust/useProposalTrust.ts', () => ({
  useProposalTrust: () => ({
    aggregate: { level: 'verified', reason: null, components: [] },
    collateral: { verdict: null },
    chain: { report: hold.report, error: null, unavailable: false },
    funded: hold.funded,
  }),
}));
vi.mock('../ui/hooks.ts', async (orig) => ({
  ...(await orig<typeof import('../ui/hooks.ts')>()),
  useAsync: () => ({ data: new Map([[(hold.tally as Sourced<Tally>).value.govHash, hold.tally]]), loading: false }),
}));

const { ProposalView } = await import('./ProposalPage.tsx');
afterEach(() => {
  owner.page = null;
  content.problem = null;
});

const cycle = (estTime: number): Sourced<Cycle> => ({ value: { superblockHeight: 1, budget: 6000e8, allocated: 250e8, votingDeadlineHeight: 0, estTime, validWeighted: 3320, paid: 0 }, prov });
const proposal = (over: Partial<Proposal>): Sourced<Proposal> => ({
  value: { govHash: 'aa', parentHash: '0'.repeat(64), revision: 1, time: NOW - 30 * DAY, dataHex: '', name: 'pshenmic-dev-dash-desktop-november-2026', url: '', paymentAddress: 'X', paymentAmount: 100e8, startEpoch: 0, endEpoch: 2e9, collateralTxid: 'aa', collateralHeight: 0, ...over },
  prov,
});
const report = (over: { paid: number; remainingEstimate: number }): ChainReport =>
  ({
    schedule: { tip: 1, nextEstTime: NOW + 23 * DAY, deadlineEstTime: NOW + 20 * DAY, inMaturityWindow: false, votingDeadline: 1, next: 1 },
    payments: { checked: [1], paid: Array.from({ length: over.paid }, (_, i) => ({ height: i + 1, output: 0, time: 0 })), ambiguous: [], unread: [], remainingEstimate: over.remainingEstimate, othersComplete: true, anchor: { tip: 1, weak: null } },
    threshold: { value: 332, validWeighted: 3320, height: 1, status: 'verified', legacy: { valid: 0, proven: 0 } },
  }) as unknown as ChainReport;

async function view(p: Sourced<Proposal>, opts: { estTime: number; report: ChainReport | null; inNextBudget?: boolean }) {
  hold.tally = { value: { govHash: 'aa', asOfHeight: 100, yesWeighted: 852, noWeighted: 348, abstainWeighted: 0, yesCount: 300, noCount: 20, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget: opts.inNextBudget ?? false, margin: 0 }, prov };
  hold.report = opts.report;
  hold.funded = opts.inNextBudget ?? null;
  hold.cycle = cycle(opts.estTime);
  return render(
    <MemoryRouter>
      <ProposalView sp={p} />
    </MemoryRouter>,
  );
}

// 852 yes, 348 no: passing by 172 over the 332 needed, as on mainnet
const pshenmic = proposal({ startEpoch: Date.UTC(2026, 8, 29) / 1000, endEpoch: Date.UTC(2026, 9, 27, 12) / 1000 });

describe('ProposalView for a lame duck', () => {
  it('says it is paid in full and drops the passing, budget and deadline lines (172 net yes, next budget full)', async () => {
    const { el } = await view(pshenmic, { estTime: NOW + 23 * DAY, report: report({ paid: 1, remainingEstimate: 0 }) });
    const status = el.querySelector('[data-testid="lameduck-status"]')!;
    expect(status.textContent).toContain('Paid in full');
    expect(status.textContent).toContain('1 of 1 payment made. No more payments are possible; it leaves the network on 27 Oct 2026.');
    const text = el.textContent ?? '';
    expect(text).not.toMatch(/Passing by|next budget is full|In the next budget|Voting closes|Voting for this payout/);
    expect(el.querySelector('[data-testid="p-paid"]')!.textContent).toBe('No payments left · 1 paid');
    // votes stay, de-emphasised
    const votes = el.querySelector('[data-testid="p-votes"]')!;
    expect(votes.className).toContain('p-votes-dim');
    expect(votes.textContent).toContain('852');
    expect(votes.textContent).toContain('These votes no longer affect payment.');
    // nobody is invited to vote on it
    expect(el.querySelector('[data-testid="vote-panel"]')).toBeNull();
  });

  it('before the chain check has run, it still says no payment is possible (from the estimated schedule) and claims no count', async () => {
    const { el } = await view(pshenmic, { estTime: NOW + 23 * DAY, report: null });
    const status = el.querySelector('[data-testid="lameduck-status"]')!;
    expect(status.textContent).toContain('No more payments possible');
    expect(status.textContent).not.toContain('Paid in full');
    expect(status.textContent).toContain('estimate');
  });
});

describe('ProposalView for a proposal with payments left', () => {
  // 90 days, started 40 days ago, one payment behind it and another to come
  const partly = proposal({ startEpoch: NOW - 40 * DAY, endEpoch: NOW + 50 * DAY });

  it('keeps its normal funding status, deadline and vote panel', async () => {
    const { el } = await view(partly, { estTime: NOW + 5 * DAY, report: report({ paid: 1, remainingEstimate: 2 }) });
    expect(el.querySelector('[data-testid="lameduck-status"]')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).toContain('Passing, but the next budget is full');
    expect(text).toContain('Voting closes in');
    expect(el.querySelector('[data-testid="p-votes"]')!.className).not.toContain('p-votes-dim');
    expect(el.querySelector('[data-testid="vote-panel"]')).not.toBeNull();
  });

  it('is not a lame duck when the verified chain still counts a payment possible (the page never contradicts its own summary)', async () => {
    const { el } = await view(pshenmic, { estTime: NOW + 23 * DAY, report: report({ paid: 1, remainingEstimate: 1 }) });
    expect(el.querySelector('[data-testid="lameduck-status"]')).toBeNull();
    expect(el.querySelector('[data-testid="p-paid"]')!.textContent).toBe('1 more possible · 1 paid');
  });

  it('is not a lame duck when the next superblock is flagged to pay it', async () => {
    const { el } = await view(pshenmic, { estTime: NOW + 23 * DAY, report: report({ paid: 1, remainingEstimate: 0 }), inNextBudget: true });
    expect(el.querySelector('[data-testid="lameduck-status"]')).toBeNull();
    expect(el.textContent).toContain('In the next budget');
  });
});

describe('ProposalView for a proposal that starts paying at a later superblock', () => {
  // Dash-Pay-name-registration-rules: Jan 3 to Feb 1, 2027; the next superblock is Nov 20, 2026, the one that can pay it ~Jan 19
  const NEXT = Date.UTC(2026, 10, 20, 12) / 1000;
  const later = proposal({ startEpoch: 1798946946, endEpoch: 1801522426, paymentAmount: 1e8, name: 'Dash-Pay-name-registration-rules' });

  it('explains when the first payment is, judges by votes, and has no "budget is full" or voting-deadline line', async () => {
    const { el } = await view(later, { estTime: NEXT, report: null });
    const status = el.querySelector('[data-testid="startslater-status"]')!;
    expect(status.textContent).toContain('Starts paying ~Jan 2027');
    // the first superblock is NEXT plus two cycles (~Jan 19 23:00 UTC); the day shown follows the reader's timezone
    const first = Math.round(NEXT + 2 * GOV_PARAMS.mainnet.superblockCycle * GOV_PARAMS.mainnet.blockSeconds);
    expect(status.textContent).toContain(`Its first payment is the superblock around ${formatDate(first)}. Votes count then; it isn't eligible for the ${formatDate(NEXT)} budget.`);
    const text = el.textContent ?? '';
    expect(text).toContain('Passing by 172'); // 852 yes, 348 no against 332: by votes alone
    expect(el.querySelector('[data-testid="funding-meter"]')!.className).toContain('meter-pass');
    expect(text).not.toMatch(/next budget is full|In the next budget|Voting closes|Voting for this payout/);
    expect(el.querySelector('[data-testid="lameduck-status"]')).toBeNull();
    // votes still count, so masternode owners can still vote
    expect(el.querySelector('[data-testid="vote-panel"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="p-votes"]')!.className).not.toContain('p-votes-dim');
  });

  it('a proof that the next superblock pays it takes the usual "In the next budget"', async () => {
    const { el } = await view(later, { estTime: NEXT, report: null, inNextBudget: true });
    expect(el.querySelector('[data-testid="startslater-status"]')).toBeNull();
    expect(el.textContent).toContain('In the next budget');
  });
});

describe('ProposalView reading order', () => {
  const open = proposal({ startEpoch: NOW - 10 * DAY, endEpoch: NOW + 80 * DAY });

  it('identifies the masternode-list block behind the proposal threshold', async () => {
    const r = report({ paid: 0, remainingEstimate: 3 });
    r.threshold.value = 331;
    r.threshold.validWeighted = 3310;
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: r });
    expect(el.querySelector('[data-testid="p-decision"]')?.textContent).toContain('331 to pass (masternode list at block 1)');
  });
  it('leads with the ask, full tally and vote entry before the details and owner’s words', async () => {
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: null });
    const summary = el.querySelector('[data-testid="p-decision"]')!;
    expect(summary.textContent).toContain('Requested');
    expect(summary.textContent).toContain('504 net yes; 332 to pass (feed estimate)');
    expect(summary.textContent).toContain('next payout around');
    expect(el.querySelector('.p-hero [data-testid="p-chain-name"]')).toBeNull();
    const funds = el.querySelector('[data-testid="p-funds"]')!;
    const vote = el.querySelector('[data-testid="vote-panel"]')!;
    expect(funds.compareDocumentPosition(vote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelector('[data-testid="p-ask"]')!.textContent).toMatch(/^100 DASH per month × \d+ payments = [\d,]+ DASH$/);
    const details = el.querySelector('[data-testid="p-details"]')!;
    expect(details.textContent).toContain('Pays');
    expect(details.textContent).toContain(`the next payout is around ${formatDate(NOW + 5 * DAY)}`);
    expect(funds.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(funds.querySelector('[data-testid="jump-vote"]')).not.toBeNull();
    expect(funds.querySelector('[data-testid="p-facts"]')).toBeNull();
    expect(funds.querySelector('[data-testid="p-votes"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="jump-vote"]')!.getAttribute('href')).toBe('#vote');
  });

  it('heads an unclaimed proposal with its name as words and keeps the exact name in the record', async () => {
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: null });
    expect(el.querySelector('[data-testid="p-title"]')!.textContent).toBe('Pshenmic dev dash desktop november 2026');
    expect(el.querySelector('[data-testid="p-chain-name"]')!.textContent).toBe('pshenmic-dev-dash-desktop-november-2026');
  });

  it('has no jump to a vote it no longer shows', async () => {
    const { el } = await view(proposal({ startEpoch: NOW - 40 * DAY, endEpoch: NOW - DAY }), { estTime: NOW + 5 * DAY, report: null });
    expect(el.querySelector('[data-testid="jump-vote"]')).toBeNull();
  });
});

describe('ProposalView before and without its record', () => {
  const open = proposal({ startEpoch: NOW - 10 * DAY, endEpoch: NOW + 80 * DAY });

  it('holds the heading while owners.json is read, with the name for screen readers, instead of swapping it later', async () => {
    owner.page = undefined;
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: null });
    const h1 = el.querySelector('[data-testid="p-title"]')!;
    expect(h1.getAttribute('aria-busy')).toBe('true');
    expect(h1.querySelector('.dh-skel')).not.toBeNull();
    expect(h1.textContent).toBe('pshenmic-dev-dash-desktop-november-2026');
  });

  it('heads with the owner’s title once read, with attribution and the exact name in the record', async () => {
    owner.page = { page: { source: '', url: 'https://www.dashcentral.org/p/x', host: 'dashcentral.org', title: 'Dash Desktop, November', description: null, excerpt: 'It funds the desktop wallet.' }, fetchedAt: NOW };
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: null });
    expect(el.querySelector('[data-testid="p-title"]')!.textContent).toBe('Dash Desktop, November');
    expect(el.querySelector('.p-hero')!.textContent).toContain('title from the owner’s page on dashcentral.org');
    expect(el.querySelector('.p-hero [data-testid="p-chain-name"]')).toBeNull();
    expect(el.querySelector('[data-testid="p-details"] blockquote')!.textContent).toBe('It funds the desktop wallet.');
    expect(el.querySelector('[data-testid="owner-page"] time')!.getAttribute('datetime')).toBe('2026-10-25T00:00:00.000Z');
    expect(el.querySelector('[data-testid="owner-page"] time')!.getAttribute('title')).toBe('25 Oct 2026, 00:00 UTC');
  });

  it('does not show fields that don’t match the hash as what it funds', async () => {
    content.problem = 'url';
    const { el } = await view(open, { estTime: NOW + 5 * DAY, report: null });
    const funds = el.querySelector('[data-testid="p-funds"]')!;
    expect(funds.querySelector('[data-testid="p-funds-mismatch"]')!.textContent).toContain('don’t match the hash the network votes on (url)');
    expect(funds.querySelector('[data-testid="p-ask"]')).toBeNull();
    expect(funds.textContent).not.toContain('Pays');
  });
});
