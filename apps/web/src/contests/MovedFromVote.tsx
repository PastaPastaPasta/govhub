// Arriving from vote.dashhq.org: EvoVote's old links forward to /names and /names/<label> with `from=vote`.
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Arriving from vote.dashhq.org (EvoVote's old links forward here with `from=vote`): say once that this is the same contest list, and
 * that voting needs no account, then drop the marker so a link copied from here doesn't carry it.
 */
export function MovedFromVote() {
  const { search, pathname } = useLocation();
  const navigate = useNavigate();
  const [moved] = useState(() => new URLSearchParams(search).get('from') === 'vote');
  useEffect(() => {
    const p = new URLSearchParams(search);
    if (p.get('from') !== 'vote') return;
    p.delete('from');
    navigate({ pathname, search: p.toString() ? `?${p}` : '' }, { replace: true });
  }, [search, pathname, navigate]);
  if (!moved) return null;
  return (
    <p className="notice moved-from-vote" data-testid="moved-from-vote">
      <b>EvoVote now lives here.</b> Same name contests, same voting keys: paste a masternode voting key on a contest to vote, with no account.
    </p>
  );
}
