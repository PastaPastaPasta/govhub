import { Link } from 'react-router-dom';
import { formatInt } from '../lib/format.ts';

/** A list card's comment count, linking to the page (undefined while counting). */
export function CommentsLink({ to, count }: { to: string; count: number | undefined }) {
  return (
    <Link to={to} className="prow-comments" title={count === undefined ? 'Counting comments…' : `${count} ${count === 1 ? 'comment' : 'comments'} (hidden ones not counted)`} data-testid="card-comments">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M2 2.5h10v7H6l-3 2.5v-2.5H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="visually-hidden">Comments: </span>
      {count === undefined ? '–' : formatInt(count)}
    </Link>
  );
}
