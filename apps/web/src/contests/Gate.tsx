import { Link, Outlet } from 'react-router-dom';
import { useContestsShown } from './useContests.ts';

/** The /names routes: their pages (and every read they make) only where contests are shown. */
export function ContestsGate() {
  return useContestsShown() ? (
    <Outlet />
  ) : (
    <section className="page-narrow">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}
