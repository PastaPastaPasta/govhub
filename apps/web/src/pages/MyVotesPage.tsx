// /votes: "my votes" across every active proposal, for all or selected masternodes of the keyring.
import { useApp } from '../app/context.tsx';
import { fmtTime } from '../ui/vote/common.tsx';
import { VotesList } from '../ui/vote/VotesList.tsx';
import { useDeadline, VoteComposer } from '../ui/VotePanel.tsx';
import { useKeyring } from '../voting/KeyringContext.tsx';
import '../voting/voting.css';

export function MyVotesPage() {
  const { gov } = useApp();
  const k = useKeyring();
  const deadline = useDeadline();
  const active = (gov.active.data ?? []).map((s) => s.value);
  return (
    <section className="kr-page" aria-labelledby="myvotes-title">
      <header className="kr-head">
        <div className="kr-head-text">
          <h1 id="myvotes-title">My votes</h1>
          <p className="kr-state muted">
            Pick a vote for each proposal you care about, then sign once for all of them.
            {deadline && <> Voting for the next superblock closes {fmtTime(deadline)}.</>}
          </p>
        </div>
      </header>
      {k.busy && (
        <p className="kr-busy small" role="status">
          <span className="spinner" aria-hidden="true" /> {k.busy}…
        </p>
      )}
      {k.error && (
        <p className="kr-alert" role="alert">
          {k.error}
        </p>
      )}
      <div className="kr-card">
        {gov.active.loading && !active.length ? <p className="muted">Loading proposals…</p> : active.length ? <VoteComposer proposals={active} /> : <p className="muted">No active proposals.</p>}
      </div>
      {k.status === 'open' && <VotesList showWins={false} />}
    </section>
  );
}
