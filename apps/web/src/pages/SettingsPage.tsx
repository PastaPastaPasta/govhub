// Endpoint registry editor (PLAN §1.1): edit, export/import JSON, share as a ?config= link, reset.
import { useEffect, useRef, useState } from 'react';
import { COSTS, isIdentifier } from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { formatCredits } from '../lib/format.ts';
import { defaultRegistry, exportRegistry, parseRegistry, QUORUM_SERVICE, resetRegistry, shareLink, type BridgeEndpoint, type Registry } from '../config/registry.ts';
import { cacheClear } from '../data/cache.ts';

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Block-list subscriptions (PLAN §9): kept in this browser, and in the user's `blockSubs` document when they publish. */
function BlockListSettings() {
  const { registry } = useApp();
  const { moderation, session, setSubs, balance } = useForum();
  const [defaultOff, setDefaultOff] = useState(moderation.subs.defaultOff);
  const [lists, setLists] = useState(moderation.subs.lists.join('\n'));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDefaultOff(moderation.subs.defaultOff);
    setLists(moderation.subs.lists.join('\n'));
  }, [moderation.subs]);
  const ids = lines(lists);
  const bad = ids.filter((x) => !isIdentifier(x));
  const save = async (publish: boolean) => {
    if (bad.length) return setMsg({ kind: 'error', text: `Not identity ids: ${bad.join(', ')}` });
    setBusy(true);
    setMsg(null);
    try {
      await setSubs({ defaultOff, lists: [...new Set(ids)], ...(moderation.subs.doc ? { doc: moderation.subs.doc } : {}) }, publish);
      setMsg({ kind: 'ok', text: publish ? 'Saved to your blockSubs document on Platform.' : 'Saved in this browser.' });
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const cost = moderation.subs.doc ? COSTS.blockSubsReplace : COSTS.blockSubsCreate;
  return (
    <section className="form" aria-labelledby="blocklists-title">
      <h2 id="blocklists-title">Block lists</h2>
      <p className="muted small">
        Blocked comments and authors are hidden, never deleted: every discussion has a "show hidden" switch. Lists are Platform documents; you can follow anyone's.
      </p>
      <fieldset>
        <legend>Lists you follow</legend>
        <label className="check">
          <input type="checkbox" checked={!defaultOff} onChange={(e) => setDefaultOff(!e.target.checked)} /> The default list, {registry.forum.moderationName}{' '}
          <span className="mono-ish small">{registry.forum.moderationIdentityId}</span>
        </label>
        <label>
          Other lists: the identity ids of their owners, one per line
          <textarea rows={3} className="code" value={lists} onChange={(e) => setLists(e.target.value)} spellCheck={false} />
        </label>
        <ul className="small muted">
          {moderation.lists.map((l) => (
            <li key={`${l.source}-${l.ownerId}`}>
              {l.name}: {l.blocks.length} {l.blocks.length === 1 ? 'block' : 'blocks'}
            </li>
          ))}
        </ul>
        {moderation.error && <p className="error small">{moderation.error}</p>}
        <div className="form-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>
            Save in this browser
          </button>
          {session && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
              Save to Platform (about {formatCredits(cost, true)}; balance {balance === null ? '…' : formatCredits(balance)})
            </button>
          )}
        </div>
        {msg && <p className={msg.kind === 'ok' ? 'notice' : 'error'}>{msg.text}</p>}
      </fieldset>
    </section>
  );
}

export function SettingsPage() {
  const { registry, setRegistry, mode, setMode } = useApp();
  const [draft, setDraft] = useState<Registry>(registry);
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(registry), [registry]);

  const set = <K extends keyof Registry>(k: K, v: Registry[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setBridge = (i: number, patch: Partial<BridgeEndpoint>) => set('bridges', draft.bridges.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const apply = (r: Registry, okText: string) => {
    const { registry: parsed, errors } = parseRegistry(r);
    if (errors.length) return setMsg({ kind: 'error', text: errors.join('. ') });
    setRegistry(parsed);
    setMsg({ kind: 'ok', text: okText });
  };
  const importText = (text: string) => {
    try {
      apply(JSON.parse(text) as Registry, 'Imported and saved.');
    } catch (e) {
      setMsg({ kind: 'error', text: `Not valid JSON: ${(e as Error).message}` });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportRegistry(registry)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'govhub-endpoints.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="settings list-section" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <p className="muted">Every backend govhub uses can be replaced. Settings stay in this browser.</p>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft, 'Saved. Data reloads with the new endpoints.');
        }}
      >
        <fieldset>
          <legend>Data</legend>
          <label className="check">
            <input type="checkbox" checked={mode === 'fixtures'} onChange={(e) => setMode(e.target.checked ? 'fixtures' : 'live')} /> Use the fixture snapshot instead of live data (this tab only)
          </label>
        </fieldset>

        <fieldset>
          <legend>Networks</legend>
          <p className="muted small">During phase 1, proposals are mainnet Core objects published into a testnet Platform contract. In production both are mainnet.</p>
          <div className="row2">
            <label>
              Core network
              <select
                value={draft.coreNetwork}
                onChange={(e) => {
                  const n = e.target.value as Registry['coreNetwork'];
                  setDraft((d) => ({ ...d, coreNetwork: n, dapi: { ...d.dapi, quorumUrl: QUORUM_SERVICE[n] } }));
                }}
              >
                <option value="mainnet">mainnet</option>
                <option value="testnet">testnet</option>
              </select>
            </label>
            <label>
              Platform network
              <select value={draft.platformNetwork} onChange={(e) => set('platformNetwork', e.target.value as Registry['platformNetwork'])}>
                <option value="mainnet">mainnet</option>
                <option value="testnet">testnet</option>
              </select>
            </label>
          </div>
          <label>
            Governance contract id
            <input value={draft.govContractId} onChange={(e) => set('govContractId', e.target.value.trim())} spellCheck={false} autoComplete="off" />
          </label>
        </fieldset>

        <fieldset>
          <legend>DAPI nodes for Core data</legend>
          <div className="radios">
            <label className="check">
              <input type="radio" name="dapi" checked={draft.dapi.source === 'quorum'} onChange={() => set('dapi', { ...draft.dapi, source: 'quorum' })} /> Quorum service list
            </label>
            <label className="check">
              <input type="radio" name="dapi" checked={draft.dapi.source === 'manual'} onChange={() => set('dapi', { ...draft.dapi, source: 'manual' })} /> My own nodes
            </label>
          </div>
          {draft.dapi.source === 'quorum' ? (
            <label>
              Quorum service URL
              <input type="url" value={draft.dapi.quorumUrl} onChange={(e) => set('dapi', { ...draft.dapi, quorumUrl: e.target.value })} spellCheck={false} />
            </label>
          ) : (
            <label>
              Nodes (host:port, one per line)
              <textarea rows={3} value={draft.dapi.nodes.join('\n')} onChange={(e) => set('dapi', { ...draft.dapi, nodes: lines(e.target.value) })} spellCheck={false} />
            </label>
          )}
          <label>
            Platform DAPI addresses (optional, https URLs; empty uses the SDK's defaults)
            <textarea rows={2} value={draft.platform.addresses.join('\n')} onChange={(e) => set('platform', { ...draft.platform, addresses: lines(e.target.value) })} spellCheck={false} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Bridges</legend>
          <p className="muted small">A bridge runs Dash Core and serves live tallies, signed votes and the masternode list. Its numbers are shown as reported until your browser verifies them.</p>
          {draft.bridges.length === 0 && <p className="muted">No bridge configured. Lists and tallies come from Platform only.</p>}
          {draft.bridges.map((b, i) => (
            <div key={i} className="bridge-row">
              <label>
                Name
                <input value={b.name} onChange={(e) => setBridge(i, { name: e.target.value })} />
              </label>
              <label className="grow">
                URL
                <input type="url" value={b.httpBase} placeholder="https://bridge.example.org" onChange={(e) => setBridge(i, { httpBase: e.target.value.trim() })} spellCheck={false} />
              </label>
              <label>
                Contract
                <input value={b.govContractId} onChange={(e) => setBridge(i, { govContractId: e.target.value.trim() })} spellCheck={false} />
              </label>
              <label>
                Identity
                <input value={b.bridgeIdentityId} onChange={(e) => setBridge(i, { bridgeIdentityId: e.target.value.trim() })} spellCheck={false} />
              </label>
              <label className="check">
                <input type="checkbox" checked={b.enabled} onChange={(e) => setBridge(i, { enabled: e.target.checked })} /> On
              </label>
              <button type="button" className="btn btn-quiet" onClick={() => set('bridges', draft.bridges.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => set('bridges', [...draft.bridges, { name: `bridge ${draft.bridges.length + 1}`, httpBase: '', govContractId: draft.govContractId, bridgeIdentityId: '', enabled: true }])}
          >
            Add a bridge
          </button>
        </fieldset>

        <fieldset>
          <legend>Relays and price feed</legend>
          <label>
            Relays (one URL per line; used for voting from phase 3)
            <textarea rows={2} value={draft.relays.map((r) => r.url).join('\n')} onChange={(e) => set('relays', lines(e.target.value).map((url, i) => ({ name: `relay ${i + 1}`, url })))} spellCheck={false} />
          </label>
          <label>
            Price feed URL (JSON with dash.usd; empty turns it off)
            <input type="url" value={draft.priceFeed?.url ?? ''} onChange={(e) => set('priceFeed', e.target.value ? { name: draft.priceFeed?.name ?? 'price feed', url: e.target.value } : null)} spellCheck={false} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Forum and moderation</legend>
          <div className="row2">
            <label>
              Forum contract
              <input value={draft.forum.contractId} onChange={(e) => set('forum', { ...draft.forum, contractId: e.target.value.trim() })} spellCheck={false} />
            </label>
            <label>
              Moderation (mod) contract
              <input value={draft.forum.modContractId} onChange={(e) => set('forum', { ...draft.forum, modContractId: e.target.value.trim() })} spellCheck={false} />
            </label>
          </div>
          <div className="row2">
            <label>
              Default block list: owner identity
              <input value={draft.forum.moderationIdentityId} onChange={(e) => set('forum', { ...draft.forum, moderationIdentityId: e.target.value.trim() })} spellCheck={false} />
            </label>
            <label>
              Default block list: name
              <input value={draft.forum.moderationName} onChange={(e) => set('forum', { ...draft.forum, moderationName: e.target.value })} />
            </label>
          </div>
          <label>
            Hosts accepted in URL-embedded ownership claims (https://host/p/&lt;identity&gt;/&lt;name&gt;)
            <input value={draft.forum.claimPortals.join(' ')} onChange={(e) => set('forum', { ...draft.forum, claimPortals: lines(e.target.value) })} spellCheck={false} />
          </label>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            Save settings
          </button>
          <button type="button" className="btn" onClick={() => setDraft(registry)}>
            Discard changes
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setRegistry(resetRegistry());
              void cacheClear();
              setMsg({ kind: 'ok', text: 'Reset to the defaults and cleared the cache.' });
            }}
          >
            Reset to defaults
          </button>
        </div>
        {msg && (
          <p className={msg.kind === 'ok' ? 'notice' : 'error'} role={msg.kind === 'ok' ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
      </form>

      <BlockListSettings />

      <section className="form" aria-labelledby="share-title">
        <h2 id="share-title">Export, import and share</h2>
        <div className="form-actions">
          <button type="button" className="btn" onClick={download}>
            Download JSON
          </button>
          <button type="button" className="btn" onClick={() => setJson(exportRegistry(registry))}>
            Show JSON
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const link = shareLink(registry, location.origin);
              void navigator.clipboard?.writeText(link).then(
                () => setMsg({ kind: 'ok', text: 'Share link copied. Whoever opens it is asked before anything changes.' }),
                () => setJson(link),
              );
            }}
          >
            Copy share link
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Import file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(importText);
              e.target.value = '';
            }}
          />
        </div>
        <label>
          Settings JSON (paste and import, or copy)
          <textarea rows={10} className="code" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} placeholder={exportRegistry(defaultRegistry()).slice(0, 120) + '…'} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => importText(json)} disabled={!json.trim()}>
            Import this JSON
          </button>
        </div>
      </section>
    </section>
  );
}
