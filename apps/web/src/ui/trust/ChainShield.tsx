// The header's chain status: a small shield with the network profile's short name. The worker anchors the chain for the active
// profile (the same anchored chain every proposal page then reuses); the drawer says what it rests on.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/context.tsx';
import { customFields, PROFILES } from '../../config/registry.ts';
import type { DataSource } from '../../data/repo.ts';
import { formatInt, formatRelative } from '../../lib/format.ts';
import type { TrustLevel } from '../../verify/aggregate.ts';
import type { AnchorSummary } from '../../verify/chain.ts';
import { runVerification } from '../../verify/client.ts';
import { Drawer } from '../Drawer.tsx';
import { ShieldIcon } from './TrustBadge.tsx';

type State = { anchor?: AnchorSummary; error?: string; progress?: string };

const TTL_MS = 5 * 60_000;
const runs = new Map<string, { at: number; promise: Promise<AnchorSummary> }>();

/** The anchored chain of this source's DAPI setting, once per 5 minutes (the worker keeps the headers in IndexedDB). */
function anchorOnce(source: DataSource, onProgress: (m: string) => void): Promise<AnchorSummary> {
  const dapi = source.dapiDescriptor();
  const key = JSON.stringify(dapi);
  const hit = runs.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = runVerification({ kind: 'anchor', dapi }, onProgress).then((r) => r.anchor);
  runs.set(key, { at: Date.now(), promise });
  promise.catch(() => runs.delete(key));
  return promise;
}

function chainLevel(demo: boolean, notice: string | null, s: State): TrustLevel {
  if (demo) return 'demo';
  if (notice) return 'error';
  if (s.anchor) return s.anchor.weak ? 'partial' : 'verified';
  return s.error ? 'error' : 'checking';
}

function useChainStatus(): { level: TrustLevel; state: State } {
  const { source, mode } = useApp();
  const [state, setState] = useState<State>({});
  const idle = mode === 'fixtures' || !!source.notice;
  useEffect(() => {
    if (idle) return;
    let on = true;
    setState({});
    // after the first paint and the list: the chain is background work
    const t = setTimeout(() => {
      anchorOnce(source, (m) => on && setState((s) => ({ ...s, progress: m }))).then(
        (anchor) => on && setState({ anchor }),
        (e: Error) => on && setState({ error: e.message }),
      );
    }, 1500);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [source, idle]);
  return { level: chainLevel(mode === 'fixtures', source.notice, state), state };
}

function headline(level: TrustLevel, s: State, notice: string | null, nowS: number): string {
  if (level === 'demo') return 'Demo data: a recorded mainnet snapshot, nothing here is live';
  if (notice) return notice;
  if (s.anchor) {
    const a = s.anchor;
    return a.weak ? `Chain checked to block ${formatInt(a.tip)}, but only proof of work protects it here` : `Chain verified to block ${formatInt(a.tip)}, ChainLocked ${formatRelative(a.chainLock.time, nowS)}`;
  }
  if (s.error) return `The chain couldn't be verified: ${s.error}`;
  return `${s.progress || 'Verifying the chain'}…`;
}

export function ChainShield() {
  const { registry, mode, source } = useApp();
  const [open, setOpen] = useState(false);
  const { level, state } = useChainStatus();
  const p = PROFILES[registry.profile];
  const custom = customFields(registry).size > 0;
  const a = state.anchor;
  const nowS = Math.floor(Date.now() / 1000);
  const line = headline(level, state, source.notice, nowS);
  return (
    <>
      <button type="button" className={`chainchip trust-${level}`} onClick={() => setOpen(true)} data-testid="profile-label" data-trust={level} aria-label={`${p.title}${custom ? ', with custom settings' : ''}. ${line}`} title={line}>
        <ShieldIcon level={level} size={16} />
        <span aria-hidden="true">{mode === 'fixtures' ? 'Demo' : p.label}</span>
        <span className="visually-hidden">{p.title}</span>
        {custom && <span className="chip-custom">custom</span>}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Network and chain" testId="chain-drawer">
        <section className={`drawer-verdict trust-${level}`}>
          <ShieldIcon level={level} size={32} />
          <div>
            <p className="drawer-verdict-title">{p.title}</p>
            <p className="drawer-verdict-line">{line}</p>
          </div>
        </section>
        <p className="small">{p.description}</p>
        {a && (
          <details className="learn">
            <summary>What the chain check rests on</summary>
            <dl className="kv">
              <div>
                <dt>Rests on</dt>
                <dd>
                  {a.trust.kind === 'quorum-proof'
                    ? `ChainLocks proven from the quorum checkpoint pinned in this app (block ${formatInt(a.trust.checkpoint.height)}), each a BLS signature checked here. No proof of work involved.`
                    : `The header checkpoint pinned in this app (block ${formatInt(a.trust.checkpoint.height)}) and proof of work${a.weak ? ', which is too weak on this network to stop a forged chain' : ''}.`}
                </dd>
              </div>
              <div>
                <dt>Newest ChainLock</dt>
                <dd>
                  block {formatInt(a.chainLock.height)}, {formatRelative(a.chainLock.time, nowS)}
                </dd>
              </div>
              <div>
                <dt>Masternode list</dt>
                <dd>
                  {formatInt(a.sml.entries)} masternodes, proven by block {formatInt(a.sml.height)}
                </dd>
              </div>
              <div>
                <dt>Headers</dt>
                <dd>
                  {formatInt(a.tip - a.lo + 1)} checked ({formatInt(a.headers.cached)} from this browser's cache, {formatInt(a.headers.fetched)} downloaded{a.ms.total ? `, ${(a.ms.total / 1000).toFixed(1)} s` : ''})
                </dd>
              </div>
            </dl>
          </details>
        )}
        <p className="small muted">
          Proposals, tallies and comments are read from Dash Platform{registry.platform.trusted ? ' with proofs: evo-sdk checks every answer against the quorum signature' : ' in untrusted mode'}. Each proposal page checks the rest
          against this chain.
        </p>
        <p className="small">
          <Link to="/settings#network" onClick={() => setOpen(false)}>
            Change network
          </Link>
          {' or '}
          <Link to="/about/verification" onClick={() => setOpen(false)}>
            read how verification works
          </Link>
        </p>
      </Drawer>
    </>
  );
}
