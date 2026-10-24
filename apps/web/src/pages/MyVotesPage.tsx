// /votes: "my votes" across every active proposal, for all or selected masternodes of the keyring.
import { useApp } from '../app/context.tsx';
import { formatDateTime } from '../lib/format.ts';
import { useDeadline, VoteComposer, WatchedList } from '../ui/VotePanel.tsx';
import { useKeyring } from '../voting/KeyringContext.tsx';
import '../voting/voting.css';

export function MyVotesPage() {
  const { gov } = useApp();
  const k = useKeyring();
  const deadline = useDeadline();
  const active = (gov.active.data ?? []).map((s) => s.value);
  return (
    <section className="list-section vote-page" aria-labelledby="myvotes-title">
      <h1 id="myvotes-title">My votes</h1>
      <p className="muted">
        Every active proposal, with your masternodes' current votes from the bridge's verified vote set. Choose a vote per proposal, then sign once for all of them.
        {deadline && <> Voting deadline for the next superblock: {formatDateTime(deadline)}.</>}
      </p>
      {k.busy && (
        <p className="muted" role="status">
          <span className="spinner" aria-hidden="true" /> {k.busy}…
        </p>
      )}
      {k.error && (
        <p className="error" role="alert">
          {k.error}
        </p>
      )}
      {gov.active.loading && !active.length ? <p className="muted">Loading proposals…</p> : active.length ? <VoteComposer proposals={active} /> : <p className="muted">No active proposals.</p>}
      <WatchedList />
    </section>
  );
}
