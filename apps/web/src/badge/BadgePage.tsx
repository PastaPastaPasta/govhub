// "Get MN badge" (PLAN §8.5): pick an MN (paste its voting key; the MN keyring calls the same requestBadge with its own signer),
// schedule a token request for the next epoch, and follow the request until the badge is posted.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { clientIssuanceWindow, epochLength, EPOCH_PARAMS, epochOf, epochStart, postingWindow, requestableEpoch } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { BadgeLeaks } from './BadgeLeaks.tsx';
import { etaSeconds, type BadgeJob } from './client.ts';
import { useBadgeCtx } from './context.tsx';

function eta(height: number, now: number | null): string {
  if (now === null) return `block ${formatInt(height)}`;
  if (height <= now) return `block ${formatInt(height)} (now)`;
  const s = etaSeconds(height, now);
  const h = s / 3600;
  return `block ${formatInt(height)} (in ${h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(s / 60))} min`})`;
}

const STATE: Record<BadgeJob['state'], string> = {
  scheduled: 'scheduled',
  token: 'token received, badge not posted yet',
  posted: 'badge posted',
  expired: 'expired',
  failed: 'failed',
};

function JobRow({ job, now, onRemove }: { job: BadgeJob; now: number | null; onRemove: () => void }) {
  const p = EPOCH_PARAMS[job.net];
  return (
    <li className="badge-job" data-testid="badge-job" data-state={job.state}>
      <div>
        <b>Epoch {job.epoch}</b> with {job.issuer.name}: <span className={job.state === 'failed' ? 'error' : ''}>{STATE[job.state]}</span>
      </div>
      <div className="small muted">
        {job.proTxHash ? <>MN <span className="mono-ish">{job.proTxHash.slice(0, 12)}…</span></> : 'masternode forgotten'}
        {job.state === 'scheduled' && <> · request at {eta(job.requestAt, now)} (window closes at block {formatInt(clientIssuanceWindow(p, job.epoch).to)})</>}
        {job.state === 'token' && <> · posting at {eta(job.postAt ?? postingWindow(p, job.epoch).from, now)}</>}
        {job.state === 'posted' && <> · shown until block {formatInt(epochStart(p, job.epoch + 1) + p.graceBlocks)}</>}
        {job.signer.kind === 'wif' && job.keepKey && ' · voting key kept (encrypted) for renewal'}
      </div>
      {job.note && <div className="small">{job.note}</div>}
      {(job.state === 'expired' || job.state === 'failed' || job.state === 'posted') && (
        <button type="button" className="btn btn-s btn-quiet" onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}

export function BadgePage() {
  const { registry, mode } = useApp();
  const { session } = useForum();
  const { contractId, trust, jobs, coreHeight, requestBadge, removeJob, reader } = useBadgeCtx();
  const net = registry.platformNetwork;
  const p = EPOCH_PARAMS[net];
  const enabled = trust.filter((t) => t.enabled);
  const [issuerId, setIssuerId] = useState(enabled[0]?.identityId ?? '');
  const [proTxHash, setProTxHash] = useState('');
  const [wif, setWif] = useState('');
  const [keepKey, setKeepKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const next = coreHeight !== null ? requestableEpoch(p, coreHeight) : null;
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const issuer = enabled.find((t) => t.identityId === issuerId);
      const job = await requestBadge(wif, proTxHash, { ...(issuer ? { issuer } : {}), keepKey });
      setWif('');
      setMsg({ kind: 'ok', text: `Scheduled: the request for epoch ${job.epoch} goes out at a random time, around ${eta(job.requestAt, coreHeight)}. Keep this app open now and then until the badge is posted.` });
    } catch (e) {
      setMsg({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="list-section badge-page" aria-labelledby="badge-title">
      <h1 id="badge-title">MN owner badge</h1>
      <p>
        Masternode owners can show <span className="chip chip-mn">MN · vouched by …</span> next to their name without revealing which masternode, how many, or of what type. An issuer
        blind-signs a token for your identity after you prove control of a masternode’s <b>voting key</b>; it never learns which identity the badge ends up on.
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
          <p className="small muted">
            Epochs are {formatInt(epochLength(p))} blocks ({formatInt(p.epochCycles)} superblock cycle{p.epochCycles === 1 ? '' : 's'}).{' '}
            {coreHeight !== null && next !== null && (
              <>
                Now: block {formatInt(coreHeight)}, epoch {epochOf(p, coreHeight)}. A request made now is for epoch {next}: it is sent at a random height before block{' '}
                {formatInt(clientIssuanceWindow(p, next).to)}, and the badge is posted at a random height from block {formatInt(epochStart(p, next) + p.boundaryMarginBlocks)} to{' '}
                {formatInt(postingWindow(p, next).to)}.
              </>
            )}
          </p>
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
              <input type="checkbox" checked={keepKey} onChange={(e) => setKeepKey(e.target.checked)} /> Renew every epoch: keep the voting key in this browser, encrypted with your
              identity key. Anyone who gets your identity key then also gets the voting key. Off: the key is forgotten once the request is sent.
            </label>
          </fieldset>
          <label>
            Issuer
            <select value={issuerId} onChange={(e) => setIssuerId(e.target.value)}>
              {enabled.map((t) => (
                <option key={t.identityId} value={t.identityId}>
                  {t.name} ({t.url.replace(/^https?:\/\//, '')})
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy || !reader || !proTxHash || !wif || !enabled.length} onClick={() => void submit()} data-testid="badge-request">
              {busy ? 'Preparing…' : 'Get MN badge'}
            </button>
          </div>
          {msg && (
            <p className={msg.kind === 'ok' ? 'notice' : 'error'} role={msg.kind === 'ok' ? 'status' : 'alert'}>
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
              <JobRow key={j.id} job={j} now={coreHeight} onRemove={() => removeJob(j.id)} />
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
