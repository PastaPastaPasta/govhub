// Trust list of badge issuers (PLAN §8.6): only issuers on it are shown; anyone may run one. Ours is the only default. Each issuer's
// current epoch is audited: verified badges against the issuer's own issuerReport.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { displayEpochsAt, EPOCH_PARAMS, epochStart, type EpochParams } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { BadgeLeaks } from './BadgeLeaks.tsx';
import { checkKeyAvailability, type KeyAvailability } from './client.ts';
import { isDefaultIssuer, parseTrustList, type TrustedIssuer } from './config.ts';
import { useBadgeCtx } from './context.tsx';
import { eta } from './flow.ts';
import type { IssuerEpochAudit } from './reader.ts';

interface Audits {
  audits: IssuerEpochAudit[];
  /** per issuer id: which epochs it has keys for (proved issuerKey reads) */
  keys: Map<string, KeyAvailability>;
  error: string | null;
}

const NO_AUDITS: Audits = { audits: [], keys: new Map(), error: null };

function useAudits(): Audits {
  const { reader, trust } = useBadgeCtx();
  const { registry } = useApp();
  const [state, setState] = useState<Audits>(NO_AUDITS);
  useEffect(() => {
    if (!reader) return setState(NO_AUDITS);
    let live = true;
    (async () => {
      const h = await reader.coreHeight();
      const net = registry.platformNetwork;
      const out: IssuerEpochAudit[] = [];
      const keys = new Map<string, KeyAvailability>();
      for (const i of trust.filter((t) => t.enabled)) {
        keys.set(i.identityId, await checkKeyAvailability((x, e) => reader.key(x, e), i, net, h));
        for (const e of displayEpochsAt(EPOCH_PARAMS[net], h)) out.push(await reader.audit(i, e, h));
      }
      if (live) setState({ audits: out, keys, error: null });
    })().catch((e: unknown) => live && setState({ ...NO_AUDITS, error: errText(e) }));
    return () => {
      live = false;
    };
  }, [reader, trust, registry.platformNetwork]);
  return state;
}

/** The reader's problem text for an epoch with no issuerKey at all (anything else means a key that is there but not usable: revoked, malformed, rule-breaking). */
const MISSING = 'no issuerKey for this epoch';

/** Whether the issuer issues badges now, in plain words; a revoked or invalid key is named, never hidden. */
export function issuingText(av: KeyAvailability, p: EpochParams): string {
  const std = av.modes.find((m) => m.mode === 'standard');
  const priv = av.modes.find((m) => m.mode === 'private');
  if (std?.ok) return `Issuing now (epoch ${std.epoch})`;
  if (std?.problem && std.problem !== MISSING) return `Not issuing: its key for epoch ${std.epoch} is not valid (${std.problem})`;
  const privNow = priv?.ok ? '; Private requests work now' : '';
  if (av.firstKeyEpoch !== null) return `Not issuing yet: Standard starts at ${eta(epochStart(p, av.firstKeyEpoch), av.height)}${privNow}`;
  return 'Not issuing yet: its key for this period is not on Platform yet';
}

/** An epoch's badges and report; epochs without a key are covered by issuingText. */
function auditText(a: IssuerEpochAudit): string {
  const rep = a.tokensIssued === null ? 'no issuerReport yet' : `${formatInt(a.tokensIssued)} tokens reported`;
  return `epoch ${a.epoch}: ${formatInt(a.badges)}${a.complete ? '' : '+ (audit incomplete)'} valid badges, ${rep}${a.flagged ? `: FLAGGED, badges hidden (${a.flagReason})` : ''}`;
}

export function BadgeSettings() {
  const { registry } = useApp();
  const { trust, setTrust, resetTrust, contractId } = useBadgeCtx();
  const net = registry.platformNetwork;
  const { audits, keys, error } = useAudits();
  const [draft, setDraft] = useState({ name: '', identityId: '', url: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const update = (list: TrustedIssuer[], ok: string) => {
    const { issuers, errors } = parseTrustList(list);
    if (errors.length) return setMsg({ kind: 'error', text: errors.join('; ') });
    setTrust(issuers);
    setMsg({ kind: 'ok', text: ok });
  };

  return (
    <section className="form" aria-labelledby="badge-trust-title" id="badge-trust">
      <h2 id="badge-trust-title">MN badge issuers</h2>
      <p className="muted small">
        Badges show “MN · vouched by &lt;issuer&gt;” only for issuers on this list; badges from others are ignored. Anyone can run an issuer. The default list, pinned in this app’s open
        source, has only ours. {contractId ? <>Badge contract: <span className="mono-ish">{contractId}</span>.</> : 'Badges are not deployed on this Platform network yet.'}{' '}
        <Link to="/masternodes#mn-badge">Get an MN badge</Link> (or <Link to="/badge">request one by hand</Link>).
      </p>
      <ul className="badge-trust">
        {trust.map((t, i) => (
          <li key={t.identityId}>
            <label className="check">
              <input type="checkbox" checked={t.enabled} onChange={(e) => update(trust.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)), 'Saved in this browser.')} /> <b>{t.name}</b>{' '}
              {isDefaultIssuer(net, t.identityId) ? <span className="chip">default</span> : <span className="chip chip-over">added by you</span>}
            </label>
            <div className="small muted">
              <span className="mono-ish">{t.identityId}</span> · {t.url}
            </div>
            {keys.get(t.identityId) && (
              <div className="small" data-testid="badge-issuing">
                {issuingText(keys.get(t.identityId)!, EPOCH_PARAMS[net])}
              </div>
            )}
            {audits
              .filter((a) => a.issuer.identityId === t.identityId && !a.keyProblem)
              .map((a) => (
                <div key={a.epoch} className={`small ${a.flagged ? 'error' : 'muted'}`} data-testid="badge-audit">
                  {auditText(a)}
                </div>
              ))}
            <button type="button" className="btn btn-s btn-quiet" onClick={() => update(trust.filter((_, j) => j !== i), `Removed ${t.name}.`)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error small">Audit could not be read: {error}</p>}
      <fieldset>
        <legend>Add an issuer</legend>
        <label>
          Name (shown as “vouched by …”)
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={40} />
        </label>
        <label>
          Issuer identity id
          <input value={draft.identityId} onChange={(e) => setDraft({ ...draft, identityId: e.target.value.trim() })} spellCheck={false} />
        </label>
        <label>
          Issuer URL (https, its own origin)
          <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value.trim() })} spellCheck={false} placeholder="https://issuer.example.org" />
        </label>
        <div className="form-actions">
          <button type="button" className="btn" disabled={!draft.name || !draft.identityId || !draft.url} onClick={() => (update([...trust, { ...draft, enabled: true }], `Added ${draft.name}.`), setDraft({ name: '', identityId: '', url: '' }))}>
            Add issuer
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => (resetTrust(), setMsg({ kind: 'ok', text: 'Back to the default list.' }))}>
            Reset to default
          </button>
        </div>
      </fieldset>
      {msg && (
        <p className={msg.kind === 'ok' ? 'notice' : 'error'} role={msg.kind === 'ok' ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
      <BadgeLeaks net={net} />
    </section>
  );
}
