// Removes the block documents an interrupted live-forum run can leave on the testnet moderator identity: the user block of the
// test author (its own `forum.block` list) and default-list blocks (`mod.block`) of the e2e's comments. Left behind, they hide the
// next run's comments. Only blocks whose target is the live e2e's author or one of its comments are touched. Testnet only; keys
// come from ~/.local/share (never printed).
//   npx vite-node scripts/clean-live-blocks.ts [--dry]
import { readFileSync } from 'node:fs';
import { connect } from './live-lib.ts';

const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const MOD = 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY';
const author = (JSON.parse(readFileSync(`${process.env.HOME}/.local/share/govhub-phase2/live-state.json`, 'utf8')) as { results: { create: { identityId: string } } }).results.create.identityId;

const { queryDocs, signerFor } = await connect();
const mod = signerFor('owner');
// The author's comments (any of them may have been put on the default list by a run that stopped halfway).
const comments = new Set((await queryDocs(FORUM, 'comment', [['$ownerId', '==', author]], [['$ownerId', 'asc'], ['$createdAt', 'asc']])).map((c) => String(c.$id)));
let removed = 0;
for (const [contract, label] of [[FORUM, 'forum.block'], [MOD, 'mod.block']] as const) {
  const docs = await queryDocs(contract, 'block', [['$ownerId', '==', mod.identityId]], [['$ownerId', 'asc'], ['target', 'asc']]);
  for (const d of docs) {
    const target = String(d.target);
    if (target !== author && !comments.has(target)) continue;
    if (process.argv.includes('--dry')) {
      console.log(`would remove ${label} ${String(d.$id)} (target ${target})`);
      continue;
    }
    await mod.delete(contract, 'block', String(d.$id));
    removed++;
    console.log(`removed ${label} ${String(d.$id)} (target ${target})`);
  }
}
console.log(`done: ${removed} removed`);
process.exit(0);
