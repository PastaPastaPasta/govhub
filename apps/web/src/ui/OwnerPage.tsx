// What the owner's own page says about a proposal (read at build time: lib/ownerPages.ts), shown as theirs: quoted, attributed to the
// host and the date it was read, and marked as claims nobody has checked. The on-chain name stays beside any title taken from it.
import { ownerPageOf, useOwnerPage, useOwnerPages, type OwnerPage } from '../lib/ownerPages.ts';
import { Link } from './Link.tsx';
import { useApp } from '../app/context.tsx';
import { Slug, titleIndex, titleOf, type TitleIndex } from './Slug.tsx';

/** The page's words about what the proposal is for: its opening paragraph, else its description. */
export const purposeOf = (page: OwnerPage): string | null => page.excerpt ?? page.description;

/** A proposal's reading title (titleOf) among the active proposals, where a look-alike name would compete for the same votes. */
export function useReadableTitle(name: string): string {
  const active = useApp().gov?.active?.data;
  return titleOf(name, active ? indexOf(active) : NO_TITLES);
}
// one index per active list, shared by every card and row that reads it
const indexes = new WeakMap<object, TitleIndex>();
const NO_TITLES: TitleIndex = new Map();
function indexOf(active: readonly { value: { name: string } }[]): TitleIndex {
  let idx = indexes.get(active);
  if (!idx) indexes.set(active, (idx = titleIndex(active.map((s) => s.value.name))));
  return idx;
}

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
  const words = useReadableTitle(p.name);
  return (
    <>
      <Link to={to} className="p-label" title={title ? `The owner’s title, from their page on ${page!.host}` : undefined}>
        {title ? <bdi>“{title}”</bdi> : words}
      </Link>
      <span className="p-slug small" data-testid="proposal-slug">
        <Slug name={p.name} />
      </span>
    </>
  );
}

/** A proposal named inside a sentence, as the lists name it (the owner's title quoted, else its name as words), linking to it. */
export function ProposalName({ p, to, owner }: { p: { govHash: string; url: string; name: string }; to: string; owner: boolean }) {
  const page = useOwnerPage(p)?.page;
  const title = owner ? page?.title : null;
  const words = useReadableTitle(p.name);
  return (
    <Link to={to} className="dh-link" title={title ? `${p.name}: the owner’s title, from their page on ${page!.host}` : p.name}>
      {title ? <bdi>“{title}”</bdi> : words}
    </Link>
  );
}

/** Said once above a list whose rows quote the owners: only when one of `proposals` has an owner's page to quote. */
export function OwnerWordsNote({ proposals }: { proposals: readonly { govHash: string; url: string }[] }) {
  const pages = useOwnerPages();
  if (!proposals.some((p) => ownerPageOf(pages, p))) return null;
  return <Link to="/about#owner-words" className="owner-words-info" title="About quoted titles and summaries" aria-label="About the owners’ words">ⓘ</Link>;
}
