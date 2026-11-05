// A record missing on this network may be on the other one: a link shared from Mainnet, opened under Testnet. Before saying
// "not found", Governance looks there and says what it found with the family's notice (<dashhq-not-found>, as Radar, Explorer and
// Bridge do): it exists there → "Open it on Mainnet"; on neither → not on either network; the other couldn't be asked → say so and
// offer to look.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { profileSearch } from '../config/network.ts';
import { registryForProfile, type ProfileId, type Registry } from '../config/registry.ts';
import { createSource, type DataSource } from '../data/repo.ts';
import { Link } from '../ui/Link.tsx';
import { useTitle } from './title.ts';
import { useApp } from './context.tsx';

export interface OtherNetwork {
  profile: ProfileId;
  /** "Mainnet" / "Testnet": the network looked in */
  label: string;
  registry: Registry;
  source: DataSource;
}

const LABEL: Partial<Record<ProfileId, string>> = { mainnet: 'Mainnet', testnet: 'Testnet' };

/** The other public network (Mainnet ↔ Testnet), or null where there is none to look in: demo data, the development profile. */
export function useOtherNetwork(): OtherNetwork | null {
  const { mode, registry } = useApp();
  return useMemo(() => {
    if (mode !== 'live' || !LABEL[registry.profile]) return null;
    const profile: ProfileId = registry.profile === 'mainnet' ? 'testnet' : 'mainnet';
    try {
      const other = registryForProfile(registry, profile);
      return { profile, label: LABEL[profile]!, registry: other, source: createSource(mode, other) };
    } catch {
      return null; // that profile isn't deployed
    }
  }, [mode, registry]);
}

export type Probe = 'checking' | 'found' | 'absent' | 'unknown';

const PROBE_TIMEOUT_MS = 25_000;

/** Whether `look` finds the record on the other network: an answer within 25 s, else "unknown" (never a guess either way). */
export function useProbe(other: OtherNetwork | null, look: (o: OtherNetwork) => Promise<boolean>, key: string): Probe {
  // the answer for one (network, key): a new question reads "checking" from its first frame, not the last answer
  const [done, setDone] = useState<{ other: OtherNetwork; key: string; probe: Probe } | null>(null);
  useEffect(() => {
    if (!other) return;
    let on = true;
    const settle = (probe: Probe) => on && setDone({ other, key, probe });
    const timer = setTimeout(() => settle('unknown'), PROBE_TIMEOUT_MS);
    look(other).then(
      (found) => settle(found ? 'found' : 'absent'),
      () => settle('unknown'),
    ).finally(() => clearTimeout(timer));
    return () => {
      on = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for what `look` looks up
  }, [other, key]);
  if (!other) return 'unknown';
  return done && done.other === other && done.key === key ? done.probe : 'checking';
}

/**
 * The family's not-found notice (`<dashhq-not-found>`, shell 1.6) for a record this network lacks, with this probe's answer:
 * checking, found on the other network ("Open it on Mainnet", which the bar's network handler routes), on neither, or couldn't
 * check. `thing`: "proposal"; `idLabel`: what the id is called ("name"); `absent`: one sentence for "on neither"; `list`: this
 * network's list. With no other network to ask (demo data, the development profile) it says plainly that there is none here.
 */
export function NetworkProbeNotice({ thing, idLabel, absent, probe, other, list }: { thing: string; idLabel: string; absent: string; probe: Probe; other: OtherNetwork | null; list: { path: string; label: string } }) {
  const { registry } = useApp();
  const here = registry.coreNetwork;
  const listHref = list.path + profileSearch('', registry.profile);
  if (!other) {
    return (
      <div className="dh-notice dh-notice--info" role="status" data-testid="not-found-plain">
        <p>
          There’s no {thing} with this {idLabel} here. {absent}
        </p>
        <Link to={list.path}>{list.label} →</Link>
      </div>
    );
  }
  const found = probe === 'found' ? other.registry.coreNetwork : probe === 'absent' ? 'none' : probe === 'checking' ? undefined : 'unknown';
  return (
    <dashhq-not-found thing={thing} id-label={idLabel} network={here} networks="mainnet testnet" found={found} list-href={listHref} list-label={list.label} data-testid="not-found" data-probe={probe}>
      {probe === 'absent' && <p>{absent}</p>}
    </dashhq-not-found>
  );
}

/** A record page's header (its kicker and name) over the not-found notice, as Radar and Explorer show a missing record. */
export function RecordNotFound({ kicker, name, title, ...notice }: Parameters<typeof NetworkProbeNotice>[0] & { kicker: string; name: ReactNode; title: string }) {
  useTitle(title);
  return (
    <section className="page-narrow record-missing" data-testid="record-missing" data-probe={notice.probe}>
      <header className="dh-page-header">
        <p className="dh-page-header__kicker">{kicker}</p>
        <h1 className="dh-page-header__title break">{name}</h1>
      </header>
      <NetworkProbeNotice {...notice} />
    </section>
  );
}
