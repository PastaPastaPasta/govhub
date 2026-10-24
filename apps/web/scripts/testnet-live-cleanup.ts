// Removes what an interrupted live run (e2e/live-forum.spec.ts) left on testnet: u6's "govhub live e2e" comments,
// the moderator identity's reactions on them, and its blocks of u6 (forum list) or of those comments (default list).
//
//   npx vite-node scripts/testnet-live-cleanup.ts
import { base58, base64 } from '@scure/base';
import { connect } from './live-lib.ts';

const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const MOD = 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY';
const { queryDocs: q, signerFor, stableBalance } = await connect();
const u6 = signerFor('u6');
const mod = signerFor('owner');
const before = { u6: await stableBalance(u6.identityId), mod: await stableBalance(mod.identityId) };

const comments = (await q(FORUM, 'comment', [['$ownerId', '==', u6.identityId], ['$createdAt', '>', 0]], [['$ownerId', 'asc'], ['$createdAt', 'desc']])).filter((c) => String(c.body).startsWith('govhub live e2e'));
const ids = comments.map((c) => String(c.$id));
console.log(`leftover live comments: ${ids.join(', ') || 'none'}`);
for (const id of ids) {
  for (const r of await q(FORUM, 'reaction', [['$ownerId', '==', mod.identityId], ['target', '==', base64.encode(base58.decode(id))]])) {
    await mod.delete(FORUM, 'reaction', String(r.$id));
    console.log(`deleted reaction ${String(r.$id)}`);
  }
}
if (ids.length) {
  for (const b of await q(MOD, 'block', [['$ownerId', '==', mod.identityId], ['target', 'in', ids]], [['$ownerId', 'asc'], ['target', 'asc']])) {
    await mod.delete(MOD, 'block', String(b.$id));
    console.log(`deleted default-list block ${String(b.$id)}`);
  }
}
for (const b of await q(FORUM, 'block', [['$ownerId', '==', mod.identityId], ['target', 'in', [u6.identityId]]], [['$ownerId', 'asc'], ['target', 'asc']])) {
  await mod.delete(FORUM, 'block', String(b.$id));
  console.log(`deleted user block ${String(b.$id)}`);
}
// Replies first: newest first is the order the query returned.
for (const id of ids) {
  await u6.delete(FORUM, 'comment', id);
  console.log(`deleted comment ${id}`);
}
const after = { u6: await stableBalance(u6.identityId), mod: await stableBalance(mod.identityId) };
console.log(`credits: u6 ${before.u6 - after.u6}, moderator ${before.mod - after.mod} (negative = refund)`);
process.exit(0);
