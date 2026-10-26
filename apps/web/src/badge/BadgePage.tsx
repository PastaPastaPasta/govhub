// "Get MN badge" (PLAN §8.5, §8.10): pick an MN (paste its voting key; the MN keyring calls the same requestBadge with its own
// signer), choose a privacy mode (Standard: the token now, the badge with your next post; Private: next epoch, at a random time),
// and follow the request until the badge is posted (Register now posts a held one at once).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EPOCH_PARAMS, epochStart, type EpochParams } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { BadgeLeaks, PolicyLink } from './BadgeLeaks.tsx';
import { isActive, isHeld, lapseHeight, nearLapse, requestWindow, type BadgeJob } from './client.ts';
import { useBadgeCtx } from './context.tsx';
import { ADVANCES_WHEN, availabilityText, clockTime, eta, fetchWaitMs, fetchWaitText, HELD_HERE, heldText, inTime, lapseText, registerNowResult, useKeyAvailability } from './flow.ts';
import { RegisterNow } from './MnBadgeOption.tsx';
import { MODES, modeBlocked, PrivacyModes } from './PrivacyModes.tsx';

/** A wall-clock time (ms) as "14:05 (in 1 hour)". */
function clock(ms: number): string {
  const t = clockTime(ms);
  const now = Date.now();
  return ms <= now ? `${t} (now)` : `${t} (in ${inTime((ms - now) / 1000)})`;
}

function requestedText(job: BadgeJob, p: EpochParams, coreHeight: number | null, quietSince: number): string {
  const requestWait = fetchWaitMs(job, quietSince);
  if (job.mode !== 'standard') return `Scheduled: the request for epoch ${job.epoch} goes out at a random time, around ${eta(job.requestAt, coreHeight)}. ${ADVANCES_WHEN}`;
  if (job.requestAt > (coreHeight ?? 0)) return `Requested: epoch ${job.epoch} starts at block ${formatInt(epochStart(p, job.epoch))}; your badge is fetched then, and appears the next time you post or react. ${ADVANCES_WHEN}`;
  if (requestWait > 0) return `${fetchWaitText(requestWait)} It then appears the next time you post or react. ${ADVANCES_WHEN}`;
  return `Fetching your badge now. It will appear the next time you post or react. ${ADVANCES_WHEN}`;
}

const STATE: Record<BadgeJob['state'], string> = {
  scheduled: 'scheduled',
  token: 'token received, badge not posted yet',
  posted: 'badge posted',
  expired: 'expired',
  failed: 'failed',
};

function JobRow({ job, now, postWait, onRemove, onCancel, onRetry, onRegister }: { job: BadgeJob; now: number | null; postWait: number; onRemove: () => void; onCancel: () => void; onRetry: () => void; onRegister: () => Promise<string | null> }) {
  const p = EPOCH_PARAMS[job.net];
  const active = isActive(job);
  const held = isHeld(job);
  const lapseAt = lapseHeight(p, job.epoch);
  const lapsing = held && nearLapse(p, job.epoch, now);
  const waiting = active && !held && job.retryAt !== undefined && job.retryAt > Date.now();
  return (
    <li className="badge-job" data-testid="badge-job" data-state={job.state}>
      <div>
        <b>Epoch {job.epoch}</b> with {job.issuer.name}: <span className={job.state === 'failed' ? 'error' : ''}>{held ? 'ready, appears with your next post or reaction' : STATE[job.state]}</span>
      </div>
      <div className="small muted">
        {job.proTxHash ? <>MN <span className="mono-ish">{job.proTxHash.slice(0, 12)}…</span></> : 'masternode forgotten'}
        {' · '}
        {MODES[job.mode].label}
        {job.state === 'scheduled' && <> · request at {eta(job.requestAt, now)} (window closes at block {formatInt(requestWindow(p, job.epoch, job.mode).to)})</>}
        {job.state === 'token' && job.postAt !== undefined && <> · posting at {eta(job.postAt, now)}</>}
        {held && <> · lapses at {eta(lapseAt, now)}</>}
        {job.state === 'posted' && <> · shown until block {formatInt(epochStart(p, job.epoch + 1) + p.graceBlocks)}</>}
        {job.signer.kind === 'wif' && job.keepKey && ' · voting key kept (encrypted) for renewal'}
      </div>
      {held && (
        <div className="small" data-testid="badge-job-held">
          <p>{heldText(postWait)}</p>
          {lapsing && <p className="vwarn">{lapseText(lapseAt, now)}</p>}
          <p className="muted">{HELD_HERE}</p>
        </div>
      )}
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
      {active && !held && <div className="small muted">{ADVANCES_WHEN}</div>}
      {held && <RegisterNow issuer={job.issuer.name} onRegister={onRegister} />}
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
  const { contractId, trust, jobs, coreHeight, requestBadge, removeJob, retryJob, registerNow, quietSince, postWait, reader, privacy, setPrivacy } = useBadgeCtx();
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
  const avail = useKeyAvailability(issuer);
  const av = avail?.state === 'ready' ? avail.av : null;
  const blocked = modeBlocked(av, privacy);
  const keyNotice = issuer && av ? availabilityText(av, issuer.name, p) : null;

  // a request's own notice shows only while that request is still waiting for its first attempt (D-046)
  const msgJob = msg?.jobId ? jobs.find((j) => j.id === msg.jobId) : undefined;
  const showMsg = msg && (!msg.jobId || (msgJob && msgJob.state === 'scheduled' && msgJob.attempts === 0 && !msgJob.note));

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const job = await requestBadge(wif, proTxHash, { ...(issuer ? { issuer } : {}), keepKey, mode: privacy });
      setWif('');
      setMsg({ kind: 'ok', text: requestedText(job, p, coreHeight, quietSince), jobId: job.id });
    } catch (e) {
      setMsg({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (j: BadgeJob) => {
    try {
      await removeJob(j.id);
    } catch (e) {
      return setMsg({ kind: 'error', text: `Not cancelled: ${errText(e)}` });
    }
    setMsg({
      kind: 'ok',
      text:
        j.state === 'token'
          ? `Cancelled: the badge for epoch ${j.epoch} is not posted, and the token and any voting key stored with it are deleted from this browser. The issuer already counted the token, so this masternode can ask again only from the next epoch. (If a post was already on its way at this moment, it may still appear.)`
          : `Cancelled: the request for epoch ${j.epoch} and the voting key stored with it are deleted from this browser. (If the request was already on its way to the issuer at this moment, the issuer may still have counted a token.)`,
    });
  };

  return (
    <section className="list-section badge-page" aria-labelledby="badge-title">
      <h1 id="badge-title">MN owner badge</h1>
      <p>
        Masternode owners can show <span className="chip chip-mn">MN · vouched by …</span> next to their name without revealing which masternode, how many, or of what type. An issuer
        blind-signs a token for your identity after you prove control of a masternode’s <b>voting key</b>. Blind signing means the token itself does not tell the issuer which
        identity it is for; the issuer can still try to match your request to a badge by timing. How hard that is depends on the mode you choose below. The govhub issuer’s
        operator commits to keeping no logs that could link them (<PolicyLink />).
      </p>
      <p className="small" data-testid="badge-main-path">
        The simplest way to get one: <Link to="/masternodes#mn-badge">add your masternodes</Link> with “Show the MN badge” on. This page is for pasting a key by hand,
        choosing the issuer, and your requests.
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
          {issuer && (avail?.state === 'error' ? (
            <p className="small muted" data-testid="badge-key-check">
              Could not check {issuer.name}’s keys on Platform ({avail.message}); the request checks again.
            </p>
          ) : !av ? (
            <p className="small muted" data-testid="badge-key-check" aria-live="polite">
              Checking which epochs {issuer.name} has keys for…
            </p>
          ) : (
            keyNotice && (
              <p className="notice" data-testid="badge-key-check" role="status">
                {keyNotice}
              </p>
            )
          ))}
          <PrivacyModes value={privacy} onChange={setPrivacy} av={av} net={net} />
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
              <JobRow
                key={j.id}
                job={j}
                now={coreHeight}
                postWait={postWait}
                onRemove={() => void removeJob(j.id).catch(() => undefined)}
                onCancel={() => void cancel(j)}
                onRetry={() => retryJob(j.id)}
                onRegister={() => registerNowResult(registerNow(j.id))}
              />
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
