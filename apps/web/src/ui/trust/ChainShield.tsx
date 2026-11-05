// The header's chain status: a small shield, beside the budget figures it backs. The worker anchors the chain for the active
// profile (the same anchored chain every proposal page then reuses); the drawer says what it rests on, and when it could not be
// checked, what that means for the figures, what still holds, and how to try again.
import { useCallback, useEffect, useState } from 'react';
import { Link } from '../Link.tsx';
import { useApp } from '../../app/context.tsx';
import { customFields, PROFILES } from '../../config/registry.ts';
import type { DataSource } from '../../data/repo.ts';
import { errText, formatInt, formatRelative } from '../../lib/format.ts';
import { isNetworkReason, unfinishedReason } from '../../lib/netError.ts';
import type { TrustLevel } from '../../verify/aggregate.ts';
import type { AnchorSummary } from '../../verify/chain.ts';
import { runVerification } from '../../verify/client.ts';
import { Drawer } from '../Drawer.tsx';
import { ShieldIcon } from './TrustBadge.tsx';

type State = { anchor?: AnchorSummary; error?: string; progress?: string };

const TTL_MS = 5 * 60_000;
const runs = new Map<string, { at: number; promise: Promise<AnchorSummary> }>();
/** The last chain this session verified, per DAPI setting: shown when a later check fails. */
const lastGood = new Map<string, { anchor: AnchorSummary; at: number }>();

/** The anchored chain of this source's DAPI setting, once per 5 minutes (the worker keeps the headers in IndexedDB). */
function anchorOnce(source: DataSource, onProgress: (m: string) => void): Promise<AnchorSummary> {
  const dapi = source.dapiDescriptor();
  const key = JSON.stringify(dapi);
  const hit = runs.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = runVerification({ kind: 'anchor', dapi }, onProgress).then((r) => r.anchor);
  runs.set(key, { at: Date.now(), promise });
  // only a chain verified outright counts as "last verified" (testnet's proof of work is only checked)
  promise.then((anchor) => anchor.weak || lastGood.set(key, { anchor, at: Date.now() }), () => runs.delete(key));
  return promise;
}

function chainLevel(demo: boolean, notice: string | null, s: State): TrustLevel {
  if (demo) return 'demo';
  if (notice) return 'error';
  if (s.anchor) return s.anchor.weak ? 'partial' : 'verified';
  return s.error ? 'error' : 'checking';
}

function useChainStatus(): { level: TrustLevel; state: State; retry(): void; last: { anchor: AnchorSummary; at: number } | undefined } {
  const { source, mode } = useApp();
  const [state, setState] = useState<State>({});
  const [attempt, setAttempt] = useState(0);
  const idle = mode === 'fixtures' || !!source.notice;
  useEffect(() => {
    if (idle) return;
    let on = true;
    setState({});
    // after the first paint and the list: the chain is background work (a retry starts at once)
    const t = setTimeout(
      () => {
        anchorOnce(source, (m) => on && setState((s) => ({ ...s, progress: m }))).then(
          (anchor) => on && setState({ anchor }),
          (e: unknown) => on && setState({ error: errText(e) }),
        );
      },
      attempt ? 0 : 1500,
    );
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [source, idle, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { level: chainLevel(mode === 'fixtures', source.notice, state), state, retry, last: lastGood.get(JSON.stringify(source.dapiDescriptor())) };
}

function headline(level: TrustLevel, s: State, notice: string | null, nowS: number): string {
  if (level === 'demo') return 'Demo data: a recorded mainnet snapshot, nothing here is live';
  if (notice) return notice;
  if (s.anchor) {
    const a = s.anchor;
    return a.weak ? `Chain checked to block ${formatInt(a.tip)}, but only proof of work protects it here` : `Chain verified to block ${formatInt(a.tip)}, ChainLocked ${formatRelative(a.chainLock.time, nowS)}`;
  }
  if (s.error) return `Couldn't check the chain: ${unfinishedReason(s.error)}`;
  return `${s.progress || 'Checking the chain'}…`;
}

const CHIP_TEXT: Record<TrustLevel, string> = {
  demo: 'Demo data',
  checking: 'Checking the chain',
  verified: 'Chain verified',
  partial: 'Chain partly checked',
  error: "Couldn't verify",
  failed: 'Proof failed',
};

/** `line`: also say, under the chip, what is running or that the figures are unconfirmed (the budget header). */
export function ChainShield({ line: withLine = false }: { line?: boolean }) {
  const { registry, mode, source } = useApp();
  const [open, setOpen] = useState(false);
  const { level, state, retry, last } = useChainStatus();
  const p = PROFILES[registry.profile];
  const custom = customFields(registry).size > 0;
  const a = state.anchor;
  const nowS = Math.floor(Date.now() / 1000);
  const line = headline(level, state, source.notice, nowS);
  const failed = !!state.error && !source.notice;
  return (
    <>
      <span className="chain-status">
        {/* while the check runs the chip says so; "Reported" only once it has not verified */}
        {(level === 'error' || level === 'partial' || level === 'failed') && <span className="dh-badge">Reported</span>}
        <button type="button" className={`chainchip dh-proof dh-proof--${level === "verified" ? "ok" : level === "checking" ? "checking" : level === "failed" ? "failed" : "unverified"} trust-${level}`} onClick={() => setOpen(true)} data-testid="profile-label" data-trust={level} aria-label={`${p.title}${custom ? ', with custom settings' : ''}. ${line}`} title={line}>
          <ShieldIcon level={level} size={16} />
          <span aria-hidden="true">{CHIP_TEXT[mode === 'fixtures' ? 'demo' : level]}</span>
          <span className="visually-hidden">{p.title}</span>
          {custom && <span className="chip-custom">custom</span>}
        </button>
        {withLine && level === 'checking' && (
          <span className="chain-line small muted" aria-live="polite" data-testid="chain-progress">
            <span className="spinner" aria-hidden="true" /> {state.progress || 'Checking the chain in your browser'}
          </span>
        )}
        {withLine && failed && (
          <span className="chain-line small" data-testid="chain-unverified">
            Figures above are shown as reported.{' '}
            <button type="button" className="linkish dh-btn dh-btn--link" onClick={retry} data-testid="chain-retry">
              Try again
            </button>
          </span>
        )}
      </span>
      <Drawer open={open} onClose={() => setOpen(false)} title="Network and chain" testId="chain-drawer">
        <section className={`drawer-verdict trust-${level}`}>
          <ShieldIcon level={level} size={32} />
          <div>
            <p className="drawer-verdict-title">{p.title}</p>
            <p className="drawer-verdict-line">{line}</p>
          </div>
          {failed && (
            <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={retry} data-testid="chain-drawer-retry">
              Try again
            </button>
          )}
        </section>
        {level === 'checking' && (
          <p className="small muted" data-testid="chain-expect">
            The first check in a browser downloads about a thousand block headers and proves a ChainLock: usually 5 to 60 seconds. Later
            visits reuse what this browser already proved.
          </p>
        )}
        {failed && (
          <div className="chain-unverified" data-testid="chain-explain">
            <h3 className="small-head">What this means</h3>
            <p className="small">
              The budget, the vote counts and which proposals are in the next budget are shown as Dash Platform and the governance bridge
              report them. Your browser hasn't confirmed them against the Dash chain, so treat passing margins and budget places as
              reported, not verified.
            </p>
            <h3 className="small-head">What still holds</h3>
            <ul className="small">
              <li>Each proposal's text is still checked against its governance hash, which needs no network.</li>
              {registry.platform.trusted && <li>Platform's answers are still checked against Platform's quorum signatures by evo-sdk.</li>}
              <li>Your keys, votes and settings are untouched. Nothing was sent.</li>
            </ul>
            {last && (
              <p className="small muted" data-testid="chain-last-good">
                Last verified in this browser: block {formatInt(last.anchor.tip)}, {formatRelative(Math.floor(last.at / 1000), nowS)}.
              </p>
            )}
            {isNetworkReason(state.error) && (
              <details className="learn inline">
                <summary>Details</summary>
                <p className="small mono-ish">{state.error}</p>
              </details>
            )}
          </div>
        )}
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
