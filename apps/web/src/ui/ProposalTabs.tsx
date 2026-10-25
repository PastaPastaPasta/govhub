// Active / Past: the two views of Proposals, with the active count.
import { NavLink } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { formatInt } from '../lib/format.ts';

export function ProposalTabs() {
  const { gov, activeRows } = useApp();
  const count = gov.active.data ? activeRows.shown.length : undefined;
  return (
    <nav className="subtabs" aria-label="Proposals">
      <NavLink to="/" end>
        Active{count !== undefined && <span className="count">{formatInt(count)}</span>}
      </NavLink>
      <NavLink to="/past">Past</NavLink>
    </nav>
  );
}
