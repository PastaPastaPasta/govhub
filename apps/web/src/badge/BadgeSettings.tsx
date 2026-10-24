// Trust list of badge issuers (PLAN §8.6): only issuers on it are shown; anyone may run one. Ours is the only default. Each issuer's
// current epoch is audited: verified badges against the issuer's own issuerReport.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { displayEpochsAt, EPOCH_PARAMS } from '@govhub/badge';
import { useApp } from '../app/context.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { BadgeLeaks } from './BadgeLeaks.tsx';
import { isDefaultIssuer, parseTrustList, type TrustedIssuer } from './config.ts';
import { useBadgeCtx } from './context.tsx';
import type { IssuerEpochAudit } from './reader.ts';

function useAudits(): { audits: IssuerEpochAudit[]; error: string | null } {
  const { reader, trust } = useBadgeCtx();
  const { registry } = useApp();
  const [state, setState] = useState<{ audits: IssuerEpochAudit[]; error: string | null }>({ audits: [], error: null });
  useEffect(() => {
    if (!reader) return setState({ audits: [], error: null });
    let live = true;
    (async () => {
      const h = await reader.coreHeight();
      const out: IssuerEpochAudit[] = [];
      for (const i of trust.filter((t) => t.enabled)) for (const e of displayEpochsAt(EPOCH_PARAMS[registry.platformNetwork], h)) out.push(await reader.audit(i, e, h));
      if (live) setState({ audits: out, error: null });
    })().catch((e: unknown) => live && setState({ audits: [], error: errText(e) }));
    return () => {
      live = false;
    };
  }, [reader, trust, registry.platformNetwork]);
  return state;
}

function auditText(a: IssuerEpochAudit): string {
  if (a.keyProblem) return `epoch ${a.epoch}: no valid key (${a.keyProblem})`;
  const rep = a.tokensIssued === null ? 'no issuerReport yet' : `${formatInt(a.tokensIssued)} tokens reported`;
  return `epoch ${a.epoch}: ${formatInt(a.badges)}${a.complete ? '' : '+'} valid badges, ${rep}${a.flagged ? ': MORE BADGES THAN TOKENS, badges hidden' : ''}`;
}

export function BadgeSettings() {
  const { registry } = useApp();
  const { trust, setTrust, resetTrust, contractId } = useBadgeCtx();
  const net = registry.platformNetwork;
  const { audits, error } = useAudits();
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
        <Link to="/badge">Get an MN badge</Link>.
      </p>
      <ul className="badge-trust">
        {trust.map((t, i) => (
          <li key={t.identityId}>
            <label className="check">
              <input type="checkbox" checked={t.enabled} onChange={(e) => update(trust.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)), 'Saved in this browser.')} /> <b>{t.name}</b>{' '}
              {isDefaultIssuer(net, t.identityId) && <span className="chip">default</span>}
            </label>
            <div className="small muted">
              <span className="mono-ish">{t.identityId}</span> · {t.url}
            </div>
            {audits
              .filter((a) => a.issuer.identityId === t.identityId)
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
