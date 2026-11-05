// What the owner's own page says about a proposal (read at build time: lib/ownerPages.ts), shown as theirs: quoted, attributed to the
// host and the date it was read, and marked as claims nobody has checked. The on-chain name stays beside any title taken from it.
import { useOwnerPage, type OwnerPage } from '../lib/ownerPages.ts';
import { formatDate } from '../lib/format.ts';

/** The page's words about what the proposal is for: its opening paragraph, else its description. */
export const purposeOf = (page: OwnerPage): string | null => page.excerpt ?? page.description;

/** "From the owner's page" in the About section: title, the opening words, where and when they were read, and the way to the rest. */
export function OwnerPageSummary({ page, fetchedAt }: { page: OwnerPage; fetchedAt: number }) {
  const purpose = purposeOf(page);
  return (
    <div className="owner-page" data-testid="owner-page">
      <p className="small muted owner-page-from">
        From the owner’s page ({page.host}, read {formatDate(fetchedAt)}). These are the owner’s own claims: nobody has checked them, and the page can
        change.
      </p>
      <blockquote className="owner-page-quote" cite={page.url}>
        {page.title && <p className="owner-page-title">{page.title}</p>}
        {purpose && <p>{purpose}</p>}
      </blockquote>
      <a href={page.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext small" data-testid="owner-page-link">
        Read it all on {page.host}
        <span className="visually-hidden"> (opens another site)</span>
      </a>
    </div>
  );
}

/** A card's one line on what a proposal is for, attributed to the owner's page. */
export function PurposeLine({ page }: { page: OwnerPage }) {
  const purpose = purposeOf(page);
  if (!purpose && !page.title) return null;
  return (
    <p className="prow-purpose small" data-testid="card-purpose" title={`From the owner’s page on ${page.host}: the owner’s own words, not checked`}>
      <span className="muted">{page.host}:</span> {purpose ?? page.title}
    </p>
  );
}

/** The owner's title under a proposal's on-chain name in a list, when their page gives one. */
export function OwnerTitle({ govHash }: { govHash: string }) {
  const title = useOwnerPage(govHash)?.page.title;
  return title ? (
    <span className="owner-title small muted" title="The owner’s title, from their page">
      {title}
    </span>
  ) : null;
}
