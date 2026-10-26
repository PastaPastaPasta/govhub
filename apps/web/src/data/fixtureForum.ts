// Sample discussion for fixture mode: comments (threaded, with a markdown sanitisation showcase and a reply whose
// parent was retracted), reactions, profiles, DPNS names, a default-list block, and a hosting-team attestation
// with the owner's proposalPost on dash-growth-q4-2026. Everything is synthetic and labelled as such in the UI.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToId, CLAIM_METHOD, forumOps, hexToBytes, idToBytes, packPostBody, type DocData, type MemoryStore } from '@govhub/forum';
import type { Registry } from '../config/registry.ts';
import { contractsOf } from './forum.ts';

const fid = (name: string): string => bytesToId(sha256(new TextEncoder().encode(`govhub-fixture-${name}`)));

export const FIXTURE_IDS = {
  alice: fid('alice'),
  bob: fid('bob'),
  carol: fid('carol'),
  dave: fid('dave'),
  spammer: fid('spammer'),
  growth: fid('growth-team'),
} as const;

export const FIXTURE_HASH = {
  orchardPay: '8410614191c3f2df69a224a1c34ebc745288700515fdece6ad3764bfc1c987fe',
  growthQ4: 'd784b13a4fa55e8e1e5f6a0271db412fda5f4407221349fd1a6d1498dfad6a96',
  dcgOps: '91808ffd72336fd89bcf5f0b3377b3c73a9b5873da8ac9419b59ba8c92e56640',
} as const;

const GROWTH_POST = `## What this funds

Q4 growth work for Dash: **paid acquisition tests**, exchange listings support and community grants.

| Line | DASH |
|---|--:|
| Acquisition experiments | 420 |
| Listings support | 300 |
| Community grants | 180 |

Monthly reports go to the forum thread and [our tracker](https://example.org/growth-q4).

> Everything here was written by the proposal owner and is stored deflated in \`proposalPost\` b0..b2.`;

/** Seeds the store relative to `now` (ms, the snapshot's frozen clock). */
export async function seedFixtureForum(store: MemoryStore, registry: Registry, nowMs: number): Promise<{ names: Map<string, string> }> {
  const { alice, bob, carol, dave, spammer, growth } = FIXTURE_IDS;
  const ops = forumOps(contractsOf(registry));
  const H = 60 * 60 * 1000;
  const at = (hoursAgo: number) => ({ createdAt: nowMs - hoursAgo * H });
  const data = (op: ReturnType<typeof ops.comment>): DocData => (op.action === 'create' ? op.data : {});
  const comment = (owner: string, govHash: string, body: string, hoursAgo: number, parentId?: string, fmt = 1) =>
    store.seed('forum', 'comment', owner, data(ops.comment(govHash, body, { fmt, ...(parentId ? { parentId } : {}) })), at(hoursAgo));
  const react = (owner: string, target: { commentId: string }, value: 1 | -1, hoursAgo: number) =>
    store.seed('forum', 'reaction', owner, data(ops.react(target, value)), at(hoursAgo));

  store.seed('forum', 'profile', alice, { displayName: 'Alice', about: 'DashCentral regular since 2017' });
  store.seed('forum', 'profile', bob, { displayName: 'bob.mn', avatarUrl: 'https://avatars.example.org/bob.png' });
  store.seed('forum', 'profile', carol, { displayName: 'Carol' });
  store.seed('forum', 'profile', growth, { displayName: 'Dash Growth team' });
  store.seed('forum', 'profile', spammer, { displayName: 'FREE DASH' });

  // OrchardPay: a thread three levels deep, a reply to a retracted comment, the sanitiser showcase and spam.
  const op = FIXTURE_HASH.orchardPay;
  const c1 = comment(alice, op, 'Strong proposal. The **milestones** look realistic and the team shipped the last one on time.\n\nRoadmap: https://github.com/orchardpay', 50);
  const c2 = comment(bob, op, 'Agree on the milestones, but who audits the payment channel code?', 44, c1);
  comment(carol, op, 'Section 4 of their doc: an external audit is budgeted for month 3.', 30, c2);
  comment(dave, op, 'Following up on a comment that its author has since retracted: the numbers were updated.', 20, fid('retracted-comment'));
  comment(
    bob,
    op,
    'Quick test of what the renderer does with markup:\n\n`x < y && y > z`\n\n<script>alert("xss")</script>\n\n![tracking pixel](https://evil.example/pixel.png) and [a javascript: link](javascript:alert(1))',
    12,
  );
  comment(spammer, op, 'FREE DASH!!! Send 1 DASH, get 2 back: http://scam.example', 6);
  react(bob, { commentId: c1 }, 1, 40);
  react(carol, { commentId: c1 }, 1, 29);
  react(dave, { commentId: c1 }, -1, 19);
  react(spammer, { commentId: c1 }, -1, 5);

  // Default moderation list: the spammer's identity.
  store.seed('mod', 'block', registry.forum.moderationIdentityId, { target: idToBytes(spammer), kind: 1, reason: 'spam' }, at(5));

  // dash-growth-q4-2026: hosting-team attestation (claim method 4), the owner's post and a comment from the owner.
  const g = FIXTURE_HASH.growthQ4;
  store.seed('gov', 'claimAttestation', registry.forum.moderationIdentityId, { govHash: hexToBytes(g), identityId: idToBytes(growth), method: CLAIM_METHOD.attestation, note: 'payout is a multisig; verified with the team' });
  const chunks = await packPostBody(GROWTH_POST);
  const post: DocData = { govHash: hexToBytes(g), title: 'Dash growth, Q4 2026' };
  chunks.forEach((c, i) => (post[`b${i}`] = c));
  store.seed('forum', 'proposalPost', growth, post, at(70));
  const q1 = comment(alice, g, 'How will you measure the acquisition experiments?', 26);
  comment(growth, g, 'Cost per funded wallet, reported monthly with the raw numbers.', 22, q1);

  // A few comments elsewhere so list cards show counts.
  comment(carol, FIXTURE_HASH.dcgOps, 'Thanks for the detailed report.', 80);
  comment(bob, FIXTURE_HASH.dcgOps, 'Yes from me.', 60, undefined, 0);

  return { names: new Map([[alice, 'alice.dash'], [growth, 'dashgrowth.dash']]) };
}
