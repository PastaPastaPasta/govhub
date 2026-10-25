// "Get MN badge" (PLAN §8.5): pick an MN (paste its voting key; the MN keyring calls the same requestBadge with its own signer),
// choose a privacy mode (Standard: now; Private / Extra private: later, harder to link), and follow the request until the badge is
// posted.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EPOCH_PARAMS, epochStart, PRIVACY_MODES, type EpochParams, type PrivacyMode } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { BadgeLeaks, ISSUER_POLICY_URL, ModeDetails } from './BadgeLeaks.tsx';
import { checkKeyAvailability, etaSeconds, isActive, requestWindow, type BadgeJob, type KeyAvailability } from './client.ts';
import { useBadgeCtx } from './context.tsx';

function inTime(s: number): string {
  const h = s / 3600;
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(s / 60))} min`;
}

function eta(height: number, now: number | null): string {
  if (now === null) return `block ${formatInt(height)}`;
  if (height <= now) return `block ${formatInt(height)} (now)`;
  return `block ${formatInt(height)} (in about ${inTime(etaSeconds(height, now))})`;
}

/** A wall-clock time (ms) as "14:05 (in 1 h)". */
function clock(ms: number, now = Date.now()): string {
  const t = new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return ms <= now ? `${t} (now)` : `${t} (in ${inTime((ms - now) / 1000)})`;
}

/** The privacy modes, one sentence each (PLAN §8.5, §8.7, §8.8); the details are under each mode's own "learn more". */
export const MODES: Record<PrivacyMode, { label: string; summary: string }> = {
  standard: {
    label: 'Standard',
    summary: 'Fast: your badge appears now. The issuer could tell which masternode it belongs to; the govhub issuer’s operator commits to keeping no records that would let it link them, and you are trusting that.',
  },
  private: {
    label: 'Private',
    summary:
      'Your badge appears at a random time early in the next epoch, among the others who chose a private mode with the same issuer. That makes it harder for the issuer to match it to your masternode by timing, not impossible.',
  },
  extra: {
    label: 'Extra private',
    summary: 'Like Private, but the badge goes out at a random time across the first half of the next epoch: its timing is harder to match still, and it takes longer.',
  },
};

/** The job only moves while the app is open and the same identity is signed in with the same key (D-081). */
const ADVANCES_WHEN = 'It moves on only while govhub is open in this browser and you are signed in as this identity with the same sign-in key.';

function requestedText(job: BadgeJob, p: EpochParams, coreHeight: number | null): string {
  if (job.mode !== 'standard') return `Scheduled: the request for epoch ${job.epoch} goes out at a random time, around ${eta(job.requestAt, coreHeight)}. ${ADVANCES_WHEN}`;
  if (job.requestAt > (coreHeight ?? 0)) return `Requested: epoch ${job.epoch} starts at block ${formatInt(epochStart(p, job.epoch))}; the badge is posted then. ${ADVANCES_WHEN}`;
  return `Requesting now: your badge is posted in a minute or two. ${ADVANCES_WHEN}`;
}

const STATE: Record<BadgeJob['state'], string> = {
  scheduled: 'scheduled',
  token: 'token received, badge not posted yet',
  posted: 'badge posted',
  expired: 'expired',
  failed: 'failed',
};

/** Why a mode cannot be requested right now, from the key pre-check (null: it can, or the check has not finished). */
function modeBlocked(av: KeyAvailability | null, m: PrivacyMode): string | null {
  const c = av?.modes.find((x) => x.mode === m);
  return c && !c.ok ? `no key for epoch ${c.epoch}` : null;
}

/** The key pre-check in words (D-044): which modes work now, and from when Standard does. */
export function availabilityText(av: KeyAvailability, issuerName: string, p: EpochParams): string | null {
  const std = av.modes.find((m) => m.mode === 'standard');
  const priv = av.modes.find((m) => m.mode === 'private');
  if (std?.ok && priv?.ok) return null;
  const first = av.firstKeyEpoch;
  const firstText =
    first === null
      ? `${issuerName} has published no key for the next few epochs.`
      : `${issuerName}’s first key is for epoch ${first}, which starts at ${eta(epochStart(p, first), av.height)}.`;
  if (std && !std.ok && priv?.ok) return `Standard is not available yet: ${issuerName} has no key for the current epoch, ${std.epoch} (${std.problem}). ${firstText} Private works now: it asks for a token for epoch ${priv.epoch}, and the badge appears early in that epoch.`;
  if (std?.ok && priv && !priv.ok) return `Private and Extra private are not available yet: ${issuerName} has no key for epoch ${priv.epoch} (${priv.problem}). Standard works now.`;
  return `No badge can be requested from ${issuerName} right now: it has no key for epoch ${std?.epoch ?? '?'} or ${priv?.epoch ?? '?'}. ${firstText}`;
}

function JobRow({ job, now, onRemove, onCancel, onRetry }: { job: BadgeJob; now: number | null; onRemove: () => void; onCancel: () => void; onRetry: () => void }) {
  const p = EPOCH_PARAMS[job.net];
  const active = isActive(job);
  const waiting = active && job.retryAt !== undefined && job.retryAt > Date.now();
  return (
    <li className="badge-job" data-testid="badge-job" data-state={job.state}>
      <div>
        <b>Epoch {job.epoch}</b> with {job.issuer.name}: <span className={job.state === 'failed' ? 'error' : ''}>{STATE[job.state]}</span>
      </div>
      <div className="small muted">
        {job.proTxHash ? <>MN <span className="mono-ish">{job.proTxHash.slice(0, 12)}…</span></> : 'masternode forgotten'}
        {' · '}
        {MODES[job.mode].label}
        {job.state === 'scheduled' && <> · request at {eta(job.requestAt, now)} (window closes at block {formatInt(requestWindow(p, job.epoch, job.mode).to)})</>}
        {job.state === 'token' && job.postAt !== undefined && <> · posting at {eta(job.postAt, now)}</>}
        {job.state === 'posted' && <> · shown until block {formatInt(epochStart(p, job.epoch + 1) + p.graceBlocks)}</>}
        {job.signer.kind === 'wif' && job.keepKey && ' · voting key kept (encrypted) for renewal'}
      </div>
      {job.note && (
        <div className="small" data-testid="badge-job-note">
          {job.note}
        </div>
      )}
      {waiting && (
        <div className="small" data-testid="badge-job-next-try">
          Next try around {clock(job.retryAt!)}.
        </div>
      )}
      {active && <div className="small muted">{ADVANCES_WHEN}</div>}
      <div className="badge-job-actions">
        {waiting && (
          <button type="button" className="btn btn-s" onClick={onRetry} data-testid="badge-job-retry">
            Retry now
          </button>
        )}
        {active && (
          <button type="button" className="btn btn-s btn-quiet" onClick={onCancel} data-testid="badge-job-cancel">
            {job.state === 'token' ? 'Cancel: do not post' : 'Cancel request'}
          </button>
        )}
        {!active && (
          <button type="button" className="btn btn-s btn-quiet" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

export function BadgePage() {
  const { registry, mode } = useApp();
  const { session } = useForum();
  const { contractId, trust, jobs, coreHeight, requestBadge, removeJob, retryJob, reader, privacy, setPrivacy } = useBadgeCtx();
  const net = registry.platformNetwork;
  const p = EPOCH_PARAMS[net];
  const enabled = trust.filter((t) => t.enabled);
  const [issuerId, setIssuerId] = useState(enabled[0]?.identityId ?? '');
  const [proTxHash, setProTxHash] = useState('');
  const [wif, setWif] = useState('');
  const [keepKey, setKeepKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; jobId?: string } | null>(null);
  const issuer = enabled.find((t) => t.identityId === issuerId) ?? enabled[0];
  // D-044: which modes the issuer has keys for, from proved issuerKey reads only (nothing goes to the issuer)
  const [avail, setAvail] = useState<{ issuerId: string; av: KeyAvailability | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!reader || !session || !issuer) return setAvail(null);
    let live = true;
    setAvail({ issuerId: issuer.identityId, av: null, error: null });
    (async () => {
      const height = await reader.coreHeight();
      const av = await checkKeyAvailability((i, e) => reader.key(i, e), issuer, net, height);
      if (live) setAvail({ issuerId: issuer.identityId, av, error: null });
    })().catch((e) => live && setAvail({ issuerId: issuer.identityId, av: null, error: errText(e) }));
    return () => {
      live = false;
    };
  }, [reader, session, issuer, net]);
  const av = avail?.issuerId === issuer?.identityId ? (avail?.av ?? null) : null;
  const blocked = modeBlocked(av, privacy);

  // a request's own notice shows only while that request is still waiting for its first attempt (D-046)
  const msgJob = msg?.jobId ? jobs.find((j) => j.id === msg.jobId) : undefined;
  const showMsg = msg && (!msg.jobId || (msgJob && msgJob.state === 'scheduled' && msgJob.attempts === 0 && !msgJob.note));

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const job = await requestBadge(wif, proTxHash, { ...(issuer ? { issuer } : {}), keepKey, mode: privacy });
      setWif('');
      setMsg({ kind: 'ok', text: requestedText(job, p, coreHeight), jobId: job.id });
    } catch (e) {
      setMsg({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = (j: BadgeJob) => {
    removeJob(j.id);
    setMsg({
      kind: 'ok',
      text:
        j.state === 'token'
          ? `Cancelled: the badge for epoch ${j.epoch} will not be posted, and the token and any voting key stored with it were deleted from this browser. The issuer already counted the token.`
          : `Cancelled: the request for epoch ${j.epoch} and the voting key stored with it were deleted from this browser. Nothing more goes to the issuer for it.`,
    });
  };

  return (
    <section className="list-section badge-page" aria-labelledby="badge-title">
      <h1 id="badge-title">MN owner badge</h1>
      <p>
        Masternode owners can show <span className="chip chip-mn">MN · vouched by …</span> next to their name without revealing which masternode, how many, or of what type. An issuer
        blind-signs a token for your identity after you prove control of a masternode’s <b>voting key</b>. Blind signing means the token itself does not tell the issuer which
        identity it is for; the issuer can still try to match your request to a badge by timing. How hard that is depends on the mode you choose below. The govhub issuer’s
        operator commits to keeping no logs that could link them (
        <a href={ISSUER_POLICY_URL} target="_blank" rel="noreferrer noopener">
          logging policy
        </a>
        ).
      </p>
      <BadgeLeaks net={net} />
      {mode !== 'live' || !contractId ? (
        <p className="notice">Badges need live data on a network where the badge contract is deployed (testnet for now). Change it in <Link to="/settings">Settings</Link>.</p>
      ) : !session ? (
        <p>
          <button type="button" className="btn btn-primary" onClick={openSignIn}>
            Sign in
          </button>{' '}
          with the identity that should show the badge.
        </p>
      ) : (
        <div className="form">
          {issuer && (avail?.error ? (
            <p className="small muted" data-testid="badge-key-check">
              Could not check {issuer.name}’s keys on Platform ({avail.error}); the request checks again.
            </p>
          ) : !av ? (
            <p className="small muted" data-testid="badge-key-check" aria-live="polite">
              Checking which epochs {issuer.name} has keys for…
            </p>
          ) : (
            availabilityText(av, issuer.name, p) && (
              <p className="notice" data-testid="badge-key-check" role="status">
                {availabilityText(av, issuer.name, p)}
              </p>
            )
          ))}
          <fieldset className="badge-modes">
            <legend>Privacy</legend>
            {PRIVACY_MODES.map((m) => (
              <div key={m} className="badge-mode">
                <label className="check">
                  <input type="radio" name="badge-mode" checked={privacy === m} onChange={() => setPrivacy(m)} data-testid={`badge-mode-${m}`} />
                  <span>
                    <b>{MODES[m].label}</b>
                    {m === 'standard' && ' (default)'}
                    {modeBlocked(av, m) && <span className="muted"> · not available yet ({modeBlocked(av, m)})</span>}: {MODES[m].summary}
                  </span>
                </label>
                <details className="badge-mode-more" data-testid={`badge-mode-more-${m}`}>
                  <summary>Learn more about {MODES[m].label}</summary>
                  <p className="small">
                    <ModeDetails mode={m} net={net} />
                  </p>
                </details>
              </div>
            ))}
          </fieldset>
          <fieldset>
            <legend>Masternode</legend>
            <label>
              proTxHash
              <input value={proTxHash} onChange={(e) => setProTxHash(e.target.value)} spellCheck={false} autoComplete="off" placeholder="64 hex characters" data-testid="badge-protx" />
            </label>
            <label>
              Voting key (WIF). Only the voting key: never the owner or collateral key.
              <input type="password" value={wif} onChange={(e) => setWif(e.target.value)} spellCheck={false} autoComplete="off" data-testid="badge-wif" />
            </label>
            <label className="check">
              <input type="checkbox" checked={keepKey} onChange={(e) => setKeepKey(e.target.checked)} />
              <span>
                Renew every epoch: keep the voting key in this browser, encrypted with your identity key. Anyone who gets your identity key then also gets the voting key. Off:
                the key is forgotten once the request is sent.
              </span>
            </label>
          </fieldset>
          <label>
            Issuer
            <select value={issuer?.identityId ?? ''} onChange={(e) => setIssuerId(e.target.value)}>
              {enabled.map((t) => (
                <option key={t.identityId} value={t.identityId}>
                  {t.name} ({t.url.replace(/^https?:\/\//, '')})
                </option>
              ))}
            </select>
          </label>
          <p className="small muted">{ADVANCES_WHEN} You can cancel a pending request below.</p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy || !reader || !proTxHash || !wif || !enabled.length || !!blocked} onClick={() => void submit()} data-testid="badge-request">
              {busy ? 'Preparing…' : 'Get MN badge'}
            </button>
            {blocked && (
              <span className="small muted" data-testid="badge-request-blocked">
                {MODES[privacy].label} is not available yet ({blocked}).
              </span>
            )}
          </div>
          {showMsg && msg && (
            <p className={msg.kind === 'ok' ? 'notice' : 'error'} role={msg.kind === 'ok' ? 'status' : 'alert'} data-testid="badge-msg">
              {msg.text}
            </p>
          )}
        </div>
      )}
      {jobs.length > 0 && (
        <>
          <h2>Your badge requests</h2>
          <ul className="badge-jobs">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} now={coreHeight} onRemove={() => removeJob(j.id)} onCancel={() => cancel(j)} onRetry={() => retryJob(j.id)} />
            ))}
          </ul>
        </>
      )}
      <p className="small muted">
        Trusted issuers are set in <Link to="/settings#badge-trust">Settings</Link>.
      </p>
    </section>
  );
}
