// Your signed votes, grouped by proposal: what each one is doing now (in plain words), which relay holds it, and cancel / retry.
import { Link } from 'react-router-dom';
import { useApp } from '../../app/context.tsx';
import { shortHash } from '../../lib/format.ts';
import { useKeyring } from '../../voting/KeyringContext.tsx';
import { isOpen, type WatchedVote } from '../../voting/pending.ts';
import { relayHost } from '../../voting/relay.ts';
import { describeVote, leadRelay } from '../../voting/status.ts';
import { Badge, fmtTime, mnName, OutcomeChip, useLabels, useNow } from './common.tsx';
import { VoteSuccess } from './VoteSuccess.tsx';

/** Relay reachability, with Retry now when votes wait for one. */
function RelayStrip() {
  const k = useKeyring();
  const waiting = k.watched.filter((w) => w.status === 'queued' && !w.restored).length;
  if (!k.relays.length) return <p className="vwarn small">No relay is configured, so votes cannot be sent. Add one in Settings.</p>;
  return (
    <div className="vrelays" data-testid="relay-strip">
      <ul>
        {k.relays.map((r) => {
          const h = k.relayHealth[r];
          const held = k.watched.filter((w) => w.status === 'held' && w.refs.some((x) => x.relay === r)).length;
          return (
            <li key={r} className={h ? (h.ok ? 'up' : 'down') : 'unknown'} data-testid="relay-row">
              <span className="vdot" aria-hidden="true" />
              <span className="mono-ish">{relayHost(r)}</span>
              <span className="small muted">
                {!h ? 'checking…' : h.ok ? `reachable${held ? `, holds ${held} of your votes` : ''}` : `unreachable: ${h.error ?? 'no answer'}`}
              </span>
            </li>
          );
        })}
      </ul>
      {waiting > 0 && (
        <p className="small">
          {waiting} vote{waiting === 1 ? '' : 's'} waiting in this browser for a relay.{' '}
          <button type="button" className="btn btn-s btn-primary" onClick={k.retryNow} data-testid="relays-retry">
            Retry now
          </button>
        </p>
      )}
    </div>
  );
}

function VoteRow({ v, name, now }: { v: WatchedVote; name: string; now: number }) {
  const k = useKeyring();
  const view = describeVote(v, now, fmtTime);
  const lead = leadRelay(v);
  const canCancel = v.status === 'held' || (v.status === 'queued' && !v.restored);
  return (
    <li className={`vrow vrow-${view.tone}`} data-testid="watched-row" data-status={v.status}>
      <div className="vrow-main">
        <span className="vrow-name">{name}</span>
        <OutcomeChip outcome={v.outcome} />
        <Badge tone={view.tone} testId="watched-badge">
          {view.badge}
        </Badge>
      </div>
      <p className="vrow-line small">{view.line}</p>
      <p className="vrow-meta small muted">
        {v.releaseAt > (v.signedAt ?? v.time) + 60 ? `Release ${fmtTime(v.releaseAt)}` : `Signed ${fmtTime(v.signedAt ?? v.time)}`}
        {lead && <>, through {relayHost(lead.relay)}</>}
        {v.refs.length > 1 && <> and {v.refs.length - 1} more</>}
        {v.rebroadcasts > 0 && <>, re-sent {v.rebroadcasts}×</>}
      </p>
      {(canCancel || (v.status === 'queued' && v.lastSendError)) && (
        <div className="vrow-actions">
          {v.status === 'queued' && v.lastSendError && (
            <button type="button" className="btn btn-s btn-primary" onClick={k.retryNow} data-testid="vote-retry">
              Retry now
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn btn-s" onClick={() => void k.cancel(v.voteHash).catch(() => {})} disabled={!!k.busy} data-testid="vote-cancel">
              {v.status === 'queued' ? 'Discard' : 'Cancel'}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function VotesList({ title = 'Votes', showWins = true }: { title?: string; showWins?: boolean }) {
  const k = useKeyring();
  const { gov } = useApp();
  const labels = useLabels();
  const anyOpen = k.watched.some(isOpen);
  const now = Math.floor(useNow(15_000, anyOpen) / 1000);
  const names = new Map((gov.active.data ?? []).map((s) => [s.value.govHash, s.value.name]));
  const groups = new Map<string, WatchedVote[]>();
  for (const v of [...k.watched].sort((a, b) => (b.signedAt ?? b.time) - (a.signedAt ?? a.time))) groups.set(v.govHash, [...(groups.get(v.govHash) ?? []), v]);
  const wins = !showWins ? [] : k.celebrations.map((h) => k.watched.find((w) => w.voteHash === h)).filter((w): w is WatchedVote => !!w);
  return (
    <section className="kr-card" aria-labelledby="votes-title" data-testid="votes-section">
      <header className="kr-card-head">
        <h2 id="votes-title">{title}</h2>
        {k.watched.length > 0 && <span className="small muted">{k.watched.filter(isOpen).length} on the way</span>}
      </header>
      <RelayStrip />
      {wins.map((w) => (
        <VoteSuccess key={w.voteHash} vote={w} name={mnName(w, labels)} proposalName={names.get(w.govHash) ?? shortHash(w.govHash, 6)} />
      ))}
      {!k.watched.length ? (
        <p className="vempty-line muted" data-testid="votes-empty">
          No votes yet. Votes you sign show up here, with where each one is, until the network counts it.
        </p>
      ) : (
        <div className="vgroups" data-testid="watched">
          {[...groups].map(([h, list]) => (
            <section key={h} className="vgroup" aria-label={names.get(h) ?? `Proposal ${shortHash(h, 6)}`}>
              <h3 className="vgroup-title">
                <Link to={`/p/h/${h}`}>{names.get(h) ?? <span className="mono-ish">{shortHash(h, 8)}</span>}</Link>
              </h3>
              <ul className="vrows">
                {list.map((v) => (
                  <VoteRow key={v.voteHash} v={v} name={mnName(v, labels)} now={now} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p className="small muted vfoot">Each vote stays in this browser until the network has counted it. If a relay doesn't deliver it, another one gets it. Cancelling a held vote relies on the relay; to be sure you change your mind, cast the new vote too: the later vote wins.</p>
    </section>
  );
}
