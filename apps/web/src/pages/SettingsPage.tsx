// Endpoint registry editor (PLAN §1.1): edit, export/import JSON, share as a ?config= link, reset.
import { useEffect, useRef, useState } from 'react';
import { COSTS, isIdentifier } from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatCredits } from '../lib/format.ts';
import {
  customFields,
  defaultRegistry,
  exportRegistry,
  importSizeError,
  parseRegistry,
  PROFILE_ORDER,
  PROFILES,
  QUORUM_SERVICE,
  profileRegistry,
  resetRegistry,
  saveErrorText,
  shareLink,
  type BridgeEndpoint,
  type Overridable,
  type Registry,
} from '../config/registry.ts';
import { cacheClear } from '../data/cache.ts';
import { BadgeSettings } from '../badge/BadgeSettings.tsx';
import { ThemeSwitch } from '../ui/SignIn.tsx';

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** Marks a setting that differs from the profile's default. */
function Custom({ on }: { on: boolean }) {
  return on ? (
    <span className="chip chip-custom" title="Differs from the profile's default">
      custom
    </span>
  ) : null;
}

type Msg = { kind: 'ok' | 'error'; text: string };
/** Where on the page a message belongs: next to the buttons that produced it. */
type Area = 'advanced' | 'share' | 'json';

/** A result shown next to the control that produced it (a message at the top of the page is off-screen from the lower groups). */
function Message({ msg }: { msg: Msg | null }) {
  return msg ? (
    <p className={msg.kind === 'ok' ? 'notice' : 'error'} role={msg.kind === 'ok' ? 'status' : 'alert'}>
      {msg.text}
    </p>
  ) : null;
}

/**
 * The network profile: one action switches Core network, Platform network, contracts, bridge and DAPI nodes together, and drops the
 * old profile's cache. The radios only pick one (arrow keys move through a radio group, so switching on change would switch, and
 * wipe the cache, at every keypress); the switch happens when the user confirms.
 */
function ProfileSettings() {
  const { registry, setRegistry, switchProfile, mode, setMode } = useApp();
  const [picked, setPicked] = useState(registry.profile);
  const [msg, setMsg] = useState<Msg | null>(null);
  useEffect(() => setPicked(registry.profile), [registry.profile]);
  // the confirm buttons go away once used: focus returns to the radio group instead of falling to <body>
  const radios = useRef<HTMLFieldSetElement>(null);
  const backToRadios = () => requestAnimationFrame(() => radios.current?.querySelector<HTMLInputElement>('input:checked')?.focus());
  const custom = customFields(registry);
  const p = PROFILES[registry.profile];
  const run = (f: () => void, ok: string) => {
    try {
      f();
      setMsg({ kind: 'ok', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: saveErrorText(e) });
    }
  };
  return (
    <section className="form" aria-labelledby="profile-title" id="network">
      <h2 id="profile-title">Network</h2>
      <p className="small muted">Which Dash network govhub shows. Testnet is for trying things; Dev shows real mainnet proposals while govhub is being built.</p>
      <fieldset className="seg profile-switch" ref={radios}>
        <legend className="visually-hidden">Network profile</legend>
        {PROFILE_ORDER.map((id) => {
          const x = PROFILES[id];
          const on = picked === id;
          return (
            <label key={id} className={[on ? 'on' : '', x.deployed ? '' : 'disabled'].filter(Boolean).join(' ')} title={x.deployed ? x.title : `${x.title}: not yet deployed`}>
              <input
                type="radio"
                name="profile"
                value={id}
                checked={on}
                disabled={!x.deployed}
                onChange={() => {
                  setPicked(id);
                  setMsg(null);
                }}
              />
              {x.label}
              {!x.deployed && <span className="sub">not yet deployed</span>}
            </label>
          );
        })}
      </fieldset>
      {picked !== registry.profile && (
        <div className="form-actions" data-testid="profile-confirm">
          <button type="button" className="btn btn-primary" onClick={() => {
              run(() => switchProfile(picked), `Switched to ${PROFILES[picked].title}. Data reloads.`);
              backToRadios();
            }}
          >
            Switch to {PROFILES[picked].label}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setPicked(registry.profile);
              backToRadios();
            }}
          >
            Stay on {p.label}
          </button>
        </div>
      )}
      <Message msg={msg} />
      <p className="small" data-testid="profile-description">
        <b>{p.title}.</b> {p.description} Core {registry.coreNetwork}, Platform {registry.platformNetwork}
        {registry.govContractId ? '' : ', no governance contract yet'}.
      </p>
      {custom.size > 0 && (
        <p className="small">
          <Custom on /> Overrides in Advanced: {[...custom].join(', ')}.{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => run(() => setRegistry(profileRegistry(registry.profile)), `Overrides removed: back to the ${p.label} profile's settings.`)}
          >
            Use the profile's settings
          </button>
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={mode === 'fixtures'} onChange={(e) => setMode(e.target.checked ? 'fixtures' : 'live')} /> Show demo data (a recorded mainnet snapshot) instead, in this tab
      </label>
    </section>
  );
}

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
      setMsg({ kind: 'error', text: errText(e) });
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
          <span className="mono-ish small break">{registry.forum.moderationIdentityId}</span>
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
        {session && moderation.subs.doc && <p className="muted small">While you are signed in, your blockSubs document on Platform decides; changes here are saved to it.</p>}
        <div className="form-actions">
          {!(session && moderation.subs.doc) && (
            <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>
              Save in this browser
            </button>
          )}
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
  const { registry, setRegistry } = useApp();
  const [draft, setDraft] = useState<Registry>(registry);
  const [json, setJson] = useState('');
  // one message per area, rendered next to the buttons that produced it
  const [msg, setMsg] = useState<(Msg & { area: Area }) | null>(null);
  const say = (area: Area, kind: Msg['kind'], text: string) => setMsg({ area, kind, text });
  const at = (area: Area) => (msg?.area === area ? msg : null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [portalsText, setPortalsText] = useState(registry.forum.claimPortals.join(' '));
  const [advanced, setAdvanced] = useState(() => customFields(registry).size > 0);
  useEffect(() => {
    setDraft(registry);
    setPortalsText(registry.forum.claimPortals.join(' '));
    if (customFields(registry).size > 0) setAdvanced(true);
  }, [registry]);
  // /settings#network (from the header's chain status): React Router does not scroll to fragments by itself
  useEffect(() => {
    const el = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    el?.closest('details')?.setAttribute('open', '');
    el?.scrollIntoView();
  }, []);
  const custom = customFields(draft);
  const isCustom = (...ks: Overridable[]) => ks.some((k) => custom.has(k));

  const set = <K extends keyof Registry>(k: K, v: Registry[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setBridge = (i: number, patch: Partial<BridgeEndpoint>) => set('bridges', draft.bridges.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  const apply = (area: Area, r: unknown, okText: string) => {
    const { registry: parsed, errors } = parseRegistry(r);
    if (errors.length) return say(area, 'error', errors.join('. '));
    try {
      setRegistry(parsed);
    } catch (e) {
      return say(area, 'error', saveErrorText(e));
    }
    say(area, 'ok', okText);
  };
  const importText = (area: Area, text: string) => {
    const tooLarge = importSizeError(new Blob([text]).size);
    if (tooLarge) return say(area, 'error', tooLarge);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return say(area, 'error', `Not valid JSON: ${(e as Error).message}`);
    }
    apply(area, parsed, 'Imported and saved.');
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
    <section className="settings page-narrow" aria-labelledby="settings-title">
      <h1 id="settings-title">Settings</h1>
      <p className="muted">Settings stay in this browser.</p>

      <ProfileSettings />

      <section className="form" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance</h2>
        <ThemeSwitch />
      </section>

      <details className="group" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span className="group-title">
            Advanced: choose your own servers <Custom on={custom.size > 0} />
          </span>
          <span className="small muted">Every server govhub uses can be replaced; each network starts with govhub's own.</span>
        </summary>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            apply('advanced', draft, 'Saved. Data reloads with the new endpoints.');
          }}
        >
          <p className="muted small">Each setting starts as the {PROFILES[draft.profile].label} profile's. A setting you change here is marked custom; switching profile replaces them all.</p>
          <fieldset>
            <legend>
              Networks <Custom on={isCustom('coreNetwork', 'platformNetwork', 'govContractId')} />
            </legend>
            <p className="muted small">Core and Platform networks are separate overrides: a mismatched pair reads one network's data with the other's rules, so prefer a profile.</p>
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
            <legend>
              DAPI nodes for Core data <Custom on={isCustom('dapi', 'platform')} />
            </legend>
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
            <legend>
              Bridges <Custom on={isCustom('bridges')} />
            </legend>
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
            <legend>
              Relays and price feed <Custom on={isCustom('relays', 'priceFeed')} />
            </legend>
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
            <legend>
              Forum and moderation <Custom on={isCustom('forum')} />
            </legend>
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
              <input
                value={portalsText}
                onChange={(e) => {
                  setPortalsText(e.target.value);
                  set('forum', { ...draft.forum, claimPortals: lines(e.target.value) });
                }}
                spellCheck={false}
              />
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
                try {
                  setRegistry(resetRegistry());
                } catch (e) {
                  return say('advanced', 'error', saveErrorText(e));
                }
                void cacheClear();
                say('advanced', 'ok', 'Reset to the defaults and cleared the cache.');
              }}
            >
              Reset to defaults
            </button>
          </div>
          <Message msg={at('advanced')} />
        </form>
      </details>

      <details className="group">
        <summary>
          <span className="group-title">Hidden comments</span>
          <span className="small muted">The block lists that hide spam and abuse in discussions.</span>
        </summary>
        <BlockListSettings />
      </details>

      <details className="group">
        <summary>
          <span className="group-title">Masternode badges</span>
          <span className="small muted">Who may vouch that a commenter owns a masternode, and how private your own badge is.</span>
        </summary>
        <BadgeSettings />
      </details>

      <details className="group">
        <summary>
          <span className="group-title">Export, import and share</span>
          <span className="small muted">Move these settings to another browser, or share them as a link.</span>
        </summary>
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
                // the app's own URL, base path included (e.g. /govhub/ on a project Pages site)
                const link = shareLink(registry, new URL(import.meta.env.BASE_URL, location.origin).href);
                const inBox = () => {
                  setJson(link);
                  say('share', 'ok', 'The share link is in the box below: copy it from there.');
                };
                if (!navigator.clipboard) return inBox(); // no clipboard API (not a secure context)
                void navigator.clipboard.writeText(link).then(() => say('share', 'ok', 'Share link copied. Whoever opens it is asked before anything changes.'), inBox);
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
                e.target.value = '';
                if (!f) return;
                // refused before it is read: a huge file would be read into memory and parsed for nothing
                const tooLarge = importSizeError(f.size);
                if (tooLarge) return say('share', 'error', tooLarge);
                void f.text().then((text) => importText('share', text), (err: Error) => say('share', 'error', `The file could not be read: ${err.message}`));
              }}
            />
          </div>
          <Message msg={at('share')} />
          <label>
            Settings JSON (paste and import, or copy)
            <textarea rows={10} className="code" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} placeholder={exportRegistry(defaultRegistry()).slice(0, 120) + '…'} />
          </label>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => importText('json', json)} disabled={!json.trim()}>
              Import this JSON
            </button>
          </div>
          <Message msg={at('json')} />
        </section>
      </details>
    </section>
  );
}
