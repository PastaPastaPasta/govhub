// /masternodes?proTx=<hash>, arriving from Radar: the exact masternode, its record in Radar, and on request its public votes on the
// active proposals (as the bridge serves them), before any account or key is involved.
import { mapLimit } from '@govhub/forum';
import { useState } from 'react';
import { useApp } from '../../app/context.tsx';
import { BridgeError } from '../../data/bridge.ts';
import { makeBridge } from '../../data/bridgeFactory.ts';
import type { Proposal } from '../../data/types.ts';
import { errText, formatInt } from '../../lib/format.ts';
import { unfinishedReason } from '../../lib/netError.ts';
import { countNames, proposalHref } from '../../lib/view.ts';
import { Link } from '../Link.tsx';

interface Summary {
  type: 'regular' | 'evo';
  rows: Array<{ p: Proposal; outcome: number | undefined; unread?: true }>;
}

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'absent' } | { kind: 'error'; message: string } | { kind: 'done'; summary: Summary };

export function RadarHandoff({ proTx }: { proTx: string }) {
  const { source, gov, registry } = useApp();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const active = (gov.active.data ?? []).map((s) => s.value);
  const descriptor = source.bridgeDescriptor();
  const radar = window.dashhq?.href('radar', '/mn/' + proTx, { network: registry.coreNetwork });

  const load = async () => {
    if (!descriptor) return;
    setState({ kind: 'loading' });
    try {
      const bridge = makeBridge(descriptor);
      const mn = (await bridge.mnlist()).masternodes.find((m) => m.proTxHash.toLowerCase() === proTx);
      if (!mn) return setState({ kind: 'absent' });
      const outpoint = `${mn.collateralTxid.toLowerCase()}-${mn.collateralIndex}`;
      const rows = await mapLimit(active, 4, async (p) => {
        try {
          const latest = (await bridge.votes(p.govHash)).votes
            .filter((v) => v.signal === 1 && `${v.collateralTxid.toLowerCase()}-${v.collateralIndex}` === outpoint)
            .sort((a, b) => b.time - a.time)[0];
          return { p, outcome: latest?.outcome };
        } catch (e) {
          // no published vote set yet (a new proposal): nobody has voted on it
          if (e instanceof BridgeError && e.status === 404) return { p, outcome: undefined };
          return { p, outcome: undefined, unread: true as const };
        }
      });
      setState({ kind: 'done', summary: { type: mn.type, rows } });
    } catch (e) {
      setState({ kind: 'error', message: unfinishedReason(errText(e)) });
    }
  };

  return (
    <section className="kr-card radar-handoff" aria-labelledby="radar-handoff-title" data-testid="radar-handoff">
      <h2 id="radar-handoff-title">Continue from Radar</h2>
      <p>
        <dashhq-hash value={proTx} full="" label="ProTx hash" href={radar}>
          {proTx}
        </dashhq-hash>
      </p>
      <p className="small">
        {radar ? <a href={radar}>Its network record is in Radar →</a> : 'Its network record is in Radar.'} Voting with it needs its voting key; the ways to vote are
        below.
      </p>
      {descriptor && active.length > 0 && state.kind === 'idle' && (
        <button type="button" className="btn btn-s" onClick={() => void load()} data-testid="radar-votes-load">
          Show its votes on the {formatInt(active.length)} active proposals
        </button>
      )}
      {state.kind === 'loading' && (
        <p className="small muted" role="status">
          <span className="spinner" aria-hidden="true" /> Reading this masternode's votes from the governance bridge…
        </p>
      )}
      {state.kind === 'absent' && <p className="small">This masternode isn't in the current masternode list on {registry.coreNetwork === 'testnet' ? 'Testnet' : 'Mainnet'}.</p>}
      {state.kind === 'error' && (
        <p className="small">
          Couldn't read its votes: {state.message}.{' '}
          <button type="button" className="linkish" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {state.kind === 'done' && <VotesSummary summary={state.summary} />}
    </section>
  );
}

function VotesSummary({ summary }: { summary: Summary }) {
  const names = countNames(summary.rows.map((r) => r.p));
  const group = (o: number | undefined) => summary.rows.filter((r) => !r.unread && r.outcome === o).sort((a, b) => a.p.name.localeCompare(b.p.name));
  const unread = summary.rows.filter((r) => r.unread);
  // not voted first: those are what an owner arriving here can still act on
  const groups: Array<{ label: string; rows: Summary['rows'] }> = [
    { label: 'Not voted', rows: group(undefined) },
    { label: 'Yes', rows: group(1) },
    { label: 'No', rows: group(2) },
    { label: 'Abstain', rows: group(3) },
    { label: "Couldn't be read", rows: unread },
  ];
  return (
    <div data-testid="radar-votes">
      <p className="small">
        Its votes on the active proposals, as the governance bridge reports them ({summary.type === 'evo' ? 'an evonode: each vote counts 4 times' : 'a regular masternode'}):
      </p>
      <ul className="radar-votes small">
        {groups
          .filter((g) => g.rows.length)
          .map((g) => (
            <li key={g.label}>
              <b>
                {g.label} ({formatInt(g.rows.length)})
              </b>
              {': '}
              {g.rows.map((r, i) => (
                <span key={r.p.govHash}>
                  {i > 0 && ', '}
                  <Link to={proposalHref(r.p, names)}>{r.p.name}</Link>
                </span>
              ))}
            </li>
          ))}
      </ul>
    </div>
  );
}
