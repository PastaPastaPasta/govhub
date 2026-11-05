// What the owner's own page says about a proposal (read at build time: lib/ownerPages.ts), shown as theirs: quoted, attributed to the
// host and the date it was read, and marked as claims nobody has checked. The on-chain name stays beside any title taken from it.
import { ownerPageOf, useOwnerPage, useOwnerPages, type OwnerPage } from '../lib/ownerPages.ts';
import { Link } from './Link.tsx';
import { readableName, Slug } from './Slug.tsx';

/** The page's words about what the proposal is for: its opening paragraph, else its description. */
export const purposeOf = (page: OwnerPage): string | null => page.excerpt ?? page.description;

/** A card's one line on what a proposal is for: the owner's words, quoted; where they come from is said once above the list. */
export function PurposeLine({ page }: { page: OwnerPage }) {
  const purpose = purposeOf(page);
  if (!purpose) return null;
  return (
    <p className="prow-purpose small" data-testid="card-purpose" title={`From the owner’s page on ${page.host}: the owner’s own words, not checked`}>
      <bdi>“{purpose}”</bdi>
    </p>
  );
}

/**
 * How a list names a proposal: the owner's title, quoted, when their page gives one (`owner`: only for a proposal that matches its
 * hash and passed its checks), else its on-chain name as words; the exact name always under it. Where quoted words come from is said
 * once per list (OwnerWordsNote), not on every row.
 */
export function ProposalLabel({ p, to, owner = true }: { p: { govHash: string; url: string; name: string }; to: string; owner?: boolean }) {
  const page = useOwnerPage(p)?.page;
  const title = owner ? page?.title : null;
  return (
    <>
      <Link to={to} className="p-label" title={title ? `The owner’s title, from their page on ${page!.host}` : undefined}>
        {title ? <bdi>“{title}”</bdi> : readableName(p.name)}
      </Link>
      <span className="p-slug small" data-testid="proposal-slug">
        <Slug name={p.name} />
      </span>
    </>
  );
}

/** Said once above a list whose rows quote the owners: only when one of `proposals` has an owner's page to quote. */
export function OwnerWordsNote({ proposals }: { proposals: readonly { govHash: string; url: string }[] }) {
  const pages = useOwnerPages();
  if (!proposals.some((p) => ownerPageOf(pages, p))) return null;
  return (
    <p className="small muted owner-words-note" data-testid="owner-words-note">
      Titles and summaries in quotes are the owners’ own words, from the pages their proposals link to; nobody has checked them.
    </p>
  );
}
