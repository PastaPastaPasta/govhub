// The MN badge inside "Add your masternodes" and on the keyring card: one switch ("Show the MN badge next to your name"), the
// privacy mode folded under "Privacy options", and the request's progress in plain words (scheduled with a cancel, fetching in
// ~N min, ready and waiting for the next post with Register now, about to lapse, issuer unreachable with a retry, already
// showing, success). Everything runs through the badge client (flow.ts useMnBadge).
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { epochLength } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { WinMark } from '../ui/vote/VoteSuccess.tsx';
import { BadgeLeaks, span } from './BadgeLeaks.tsx';
import { MnBadges } from './BadgeChip.tsx';
import type { BadgeJob } from './client.ts';
import { ADVANCES_WHEN, availabilityText, clockTime, eta, fetchWaitText, HELD_HERE, heldText, inTime, lapseIn, lapseText, noCrowdText, registerNowNote, type MnBadge } from './flow.ts';
import { MODES, PrivacyModes } from './PrivacyModes.tsx';

/** "14:05 (in about 2 hours)" */
function clock(ms: number): string {
  const t = clockTime(ms);
  return ms <= Date.now() ? t : `${t} (in about ${inTime((ms - Date.now()) / 1000)})`;
}

/** What the badge request keeps of the voting key, and for how long (the job store: badge/store.ts, wiped by client.ts). */
const KEY_COPY = 'To send that request, govhub keeps a copy of the voting key in this browser, never in plain text, until the request is sent, then deletes it.';

/** When the issuer can issue in the chosen mode, before anything is requested. `offer`: the switch is still off (keyring card). */
function ReadinessLine({ b, offer = false }: { b: MnBadge; offer?: boolean }) {
  const a = b.availability;
  const name = b.issuer?.name ?? 'the issuer';
  if (!a || a.state === 'checking')
    return (
      <p className="small muted" data-testid="mnb-ready" data-state="checking" aria-live="polite">
        <span className="spinner" aria-hidden="true" /> Checking whether {name} is issuing badges…
      </p>
    );
  if (a.state === 'error')
    return (
      <p className="small" data-testid="mnb-ready" data-state="error">
        Couldn’t check {name}’s badge keys on Platform just now.{' '}
        <button type="button" className="btn btn-s btn-quiet" onClick={a.retry}>
          Try again
        </button>
      </p>
    );
  const r = b.ready!;
  // Private mode for the issuer's first key epoch: no crowd check (step() posts without it)
  const noCrowd = b.privacy !== 'standard' && r.kind !== 'blocked' ? noCrowdText(a.av, name, r.epoch) : '';
  if (r.kind === 'now')
    return (
      <p className="small" data-testid="mnb-ready" data-state="now">
        <span className="vdot vdot-on" aria-hidden="true" />{' '}
        {b.privacy === 'standard'
          ? `${name} is issuing now. Your badge is fetched in the background and appears the next time you post or react.`
          : `${name} is issuing now: in ${MODES[b.privacy].label} mode your badge appears at a random time early in epoch ${r.epoch}.`}
        {noCrowd && ` ${noCrowd}`}
      </p>
    );
  if (r.kind === 'later')
    return (
      <p className="small" data-testid="mnb-ready" data-state="later">
        <b>
          {offer ? 'Switch it on and your badge' : 'Your badge'} will be issued automatically from {eta(r.from, b.height)}.
        </b>{' '}
        {name}’s first key is for the period that starts then. {ADVANCES_WHEN} You can cancel it until then.{noCrowd && ` ${noCrowd}`}
      </p>
    );
  return (
    <p className="small vwarn" data-testid="mnb-ready" data-state="blocked">
      {r.noKeys ? `${name} isn’t issuing badges yet: its key for this period is not on Platform yet. The badge can be requested as soon as it is; your masternodes are added either way, and you can switch the badge on from this page then.` : availabilityText(a.av, name, b.p)}
    </p>
  );
}

/** The privacy mode folded under "Privacy options"; `children` is whatever else belongs in the fold. */
function PrivacyOptions({ b, name, testId, children }: { b: MnBadge; name: string; testId?: string; children?: ReactNode }) {
  const { registry } = useApp();
  return (
    <details className="mnb-privacy" data-testid={testId}>
      <summary>
        Privacy options: <b>{MODES[b.privacy].label}</b>
      </summary>
      <PrivacyModes value={b.privacy} onChange={b.setPrivacy} av={null} net={registry.platformNetwork} name={name} />
      {children}
    </details>
  );
}

/** The switch and what it means; the privacy mode under "Privacy options". `on` is the user's choice (default on). */
export function BadgeChoice({ b, on, onChange }: { b: MnBadge; on: boolean; onChange(v: boolean): void }) {
  const { registry } = useApp();
  const name = b.issuer?.name ?? 'govhub';
  return (
    <div className="mnb-choice" data-testid="mnb-choice">
      <label className="mnb-switch">
        <input type="checkbox" role="switch" checked={on && b.usable} onChange={(e) => onChange(e.target.checked)} disabled={!b.usable} data-testid="mnb-toggle" />
        <span>
          <b>Show the MN badge next to your name</b>
          <span className="small muted"> · {on && b.usable ? 'on' : 'off'}</span>
        </span>
      </label>
      <p className="small">
        Readers see <MnBadges issuers={[name]} /> next to your name in discussions, never which masternode or how many you have. It’s on by default; switch it off to only add your
        masternodes.
      </p>
      {!b.usable ? (
        <p className="small muted" data-testid="mnb-unusable">
          {b.unusableText}
        </p>
      ) : (
        on && (
          <>
            <ReadinessLine b={b} />
            <p className="small muted">
              {name} checks your voting key once, then blind-signs a token for your identity; it sees which masternode asked. {KEY_COPY} A badge can’t be deleted once posted; it
              shows until shortly after its epoch ends (an epoch is about {span(epochLength(b.p))}).
            </p>
            <PrivacyOptions b={b} name="mnb-mode" testId="mnb-privacy">
              <BadgeLeaks net={registry.platformNetwork} />
              <p className="small muted">
                Issuers, and requests made by hand, are on the <Link to="/badge">badge page</Link>.
              </p>
            </PrivacyOptions>
          </>
        )
      )}
    </div>
  );
}

/**
 * This identity's badge, as it stands: showing (a success card when `celebrate`: the user asked for it in this visit), pending (scheduled, being
 * requested, or retrying after the issuer could not be reached), or the reason the last request ended.
 */
export function BadgeProgress({ b, celebrate = false, onAgain }: { b: MnBadge; celebrate?: boolean; onAgain?: () => void }) {
  const s = b.status;
  const name = b.issuer?.name ?? 'the issuer';
  if (s.kind === 'shown') {
    const until = s.until !== null ? <> It shows until {eta(s.until, b.height)}.</> : null;
    if (celebrate)
      return (
        <section className="vwin mnb-win" role="status" data-testid="mnb-success" aria-labelledby="mnb-win-title">
          <WinMark />
          <div className="vwin-body">
            <h3 id="mnb-win-title">Your MN badge is live</h3>
            <p className="vwin-sub">
              Next to your name in discussions: <MnBadges issuers={[s.issuer]} />
            </p>
            <p className="small muted">Nobody reading it can see which masternode or how many.{until}</p>
          </div>
        </section>
      );
    return (
      <p className="small kr-found" role="status" data-testid="mnb-shown">
        ✓ Your MN badge is already showing: <MnBadges issuers={[s.issuer]} />.{until}
      </p>
    );
  }
  if (s.kind === 'held') return <HeldBadge b={b} job={s.job} lapseAt={s.lapseAt} lapsing={s.lapsing} />;
  if (s.kind === 'pending') {
    const j = s.job;
    const waiting = j.retryAt !== undefined && j.retryAt > Date.now();
    // the challenge or the token call did not get through; the issuer may still have seen the request (a timeout after sending)
    const unreachable = waiting && /could not reach the issuer/i.test(j.note ?? '');
    const scheduled = s.from > (b.height ?? 0);
    // due, but held back by the spacing after a Platform write or another request from this browser
    const fetchWait = j.state === 'scheduled' ? b.fetchWait(j) : 0;
    const spacing = !scheduled && fetchWait > 0;
    const cancel = (
      <button type="button" className="btn btn-s btn-quiet" onClick={() => void b.cancel(j)} data-testid="mnb-cancel">
        {j.state === 'token' ? 'Cancel: don’t post it' : 'Cancel'}
      </button>
    );
    let state = 'requesting';
    if (unreachable) state = 'unreachable';
    else if (waiting) state = 'waiting';
    else if (scheduled) state = 'scheduled';
    else if (spacing) state = 'fetch-wait';
    return (
      <div className="mnb-progress" role="status" data-testid="mnb-pending" data-state={state}>
        {waiting ? (
          <>
            {unreachable ? (
              <p className="small">
                <b>{name}’s badge issuer can’t be reached right now.</b> Your request is kept and tried again around {clock(j.retryAt!)}.
              </p>
            ) : (
              <p className="small">{j.note}</p>
            )}
            <div className="badge-job-actions">
              <button type="button" className="btn btn-s" onClick={() => b.retry(j)} data-testid="mnb-retry">
                Try again now
              </button>
              {cancel}
            </div>
            {unreachable && (
              <details className="small muted">
                <summary>Details</summary>
                {j.note}
              </details>
            )}
          </>
        ) : (
          <>
            <p className="small">
              {scheduled ? (
                <>
                  <b>Badge scheduled:</b> it will be issued automatically from {eta(s.from, b.height)}
                  {j.mode !== 'standard' && ', at a random time'}.
                </>
              ) : spacing ? (
                <>{fetchWaitText(fetchWait)}</>
              ) : j.state === 'token' ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Token received; posting your badge…
                </>
              ) : (
                <>
                  <span className="spinner" aria-hidden="true" /> Fetching your badge from {name}…
                </>
              )}{' '}
              {j.note && <span className="muted">{j.note} </span>}
            </p>
            <p className="small muted">{ADVANCES_WHEN}</p>
            <div className="badge-job-actions">{cancel}</div>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      {b.cancelled && (
        <p className="small notice" role="status" data-testid="mnb-cancelled">
          {b.cancelled}
        </p>
      )}
      {!b.cancelled && s.last?.note && (
        <div className="small" role="status" data-testid="mnb-ended">
          <p>
            Your last badge request (epoch {formatInt(s.last.epoch)}) ended: {s.last.note}
          </p>
          {onAgain && (
            <button type="button" className="btn btn-s" onClick={onAgain} data-testid="mnb-again">
              Ask again
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A held token: the nudge, Register now (with its honest note), Cancel, and, near its end, the lapse warning. The token lives in
 * this browser only, so the copy says a post from another device will not carry it.
 */
function HeldBadge({ b, job, lapseAt, lapsing }: { b: MnBadge; job: BadgeJob; lapseAt: number; lapsing: boolean }) {
  return (
    <div className="mnb-progress" role="status" data-testid="mnb-held" data-state={lapsing ? 'lapsing' : 'ready'}>
      <p className="small">{heldText(b.postWait)}</p>
      {lapsing && (
        <p className="small vwarn" data-testid="mnb-lapsing">
          {lapseText(lapseAt, b.height)}
        </p>
      )}
      <p className="small muted">{HELD_HERE}</p>
      {job.note && <p className="small muted">{job.note}</p>}
      <RegisterNow issuer={job.issuer.name} onRegister={() => b.registerNow(job)}>
        <button type="button" className="btn btn-s btn-quiet" onClick={() => void b.cancel(job)} data-testid="mnb-cancel">
          Cancel: don’t post it
        </button>
      </RegisterNow>
    </div>
  );
}

/** "Register now" for a held token, with its note; `onRegister` resolves with an error text or null. Shared with the badge page. */
export function RegisterNow({ issuer, onRegister, children }: { issuer: string; onRegister(): Promise<string | null>; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    const e = await onRegister();
    setBusy(false);
    setError(e);
  };
  return (
    <>
      <div className="badge-job-actions">
        <button type="button" className="btn btn-s" onClick={() => void go()} disabled={busy} data-testid="mnb-register-now">
          {busy ? 'Posting…' : 'Register now'}
        </button>
        {children}
      </div>
      <p className="small muted" data-testid="mnb-register-note">
        {registerNowNote(issuer)}
      </p>
      {error && (
        <p className="small error" role="alert">
          Not posted: {error}
        </p>
      )}
    </>
  );
}

/** "MN badge: shown / ready, appears with your next post / fetching in ~N min / will lapse in N days / …", for the keyring card. */
function badgeSummary(b: MnBadge): string {
  const s = b.status;
  if (s.kind === 'shown') return 'shown';
  if (s.kind === 'held') return s.lapsing ? `will lapse in ${lapseIn(s.lapseAt, b.height)}` : 'ready, appears with your next post';
  if (s.kind === 'pending') {
    if (s.from > (b.height ?? 0)) return `pending (from block ${formatInt(s.from)})`;
    const wait = s.job.state === 'scheduled' ? b.fetchWait(s.job) : 0;
    if (wait > 0) return `fetching in ~${Math.max(1, Math.ceil(wait / 60_000))} min`;
    return 'pending (being issued)';
  }
  return 'not shown';
}

/**
 * The keyring card's badge row: a switch that asks for the badge now with one of the keyring's masternodes (`request`, null with
 * `why` when it cannot), cancels a pending request when switched off, and cannot remove a posted badge (badges are immutable).
 */
export function KeyringBadgeRow({ b, request, why, hideProgress = false }: { b: MnBadge; request: (() => Promise<BadgeJob>) | null; why: string | null; hideProgress?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const s = b.status;
  const ask = async () => {
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      await request();
      setAsked(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const on = s.kind !== 'none';
  const toggle = (v: boolean) => {
    if (v) void ask();
    else if (s.kind === 'pending' || s.kind === 'held') void b.cancel(s.job);
  };
  return (
    <div className="mnb-row" id="mn-badge" data-testid="mnb-row" data-state={s.kind}>
      <div className="mnb-row-head">
        <label className="mnb-switch">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            onChange={(e) => toggle(e.target.checked)}
            disabled={!b.usable || busy || s.kind === 'shown' || (!on && (!request || !b.canRequest))}
            data-testid="mnb-row-toggle"
          />
          <span>
            <b>MN badge:</b> <span data-testid="mnb-summary">{b.usable ? badgeSummary(b) : 'not available here'}</span>
          </span>
        </label>
        {s.kind === 'shown' && <MnBadges issuers={[s.issuer]} />}
      </div>
      {!b.usable ? (
        <p className="small muted">{b.unusableText}</p>
      ) : (
        <>
          {s.kind === 'shown' && (
            <p className="small muted" data-testid="mnb-immutable">
              A posted badge can’t be removed or switched off: it’s a permanent document on Platform. It stops showing on its own after its epoch ends
              {s.until !== null ? ` (from block ${formatInt(s.until + 1)})` : ''}; ask again then to keep showing one.
            </p>
          )}
          {s.kind === 'none' &&
            (why ? (
              <p className="small muted">{why}</p>
            ) : (
              <>
                <ReadinessLine b={b} offer />
                <p className="small muted">{KEY_COPY}</p>
              </>
            ))}
          {!hideProgress && (s.kind !== 'shown' || asked) && <BadgeProgress b={b} celebrate={asked} {...(request && b.canRequest ? { onAgain: () => void ask() } : {})} />}
          {s.kind === 'none' && <PrivacyOptions b={b} name="mnb-row-mode" />}
        </>
      )}
      {error && (
        <p className="small error" role="alert" data-testid="mnb-error">
          {error}
        </p>
      )}
    </div>
  );
}
