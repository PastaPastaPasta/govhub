// A record missing on this network may be on the other one: a link shared from Mainnet, opened under Testnet. Before saying
// "not found", Governance looks there and says what it found, the family's wrong-network pattern (Explorer's identity page, Radar's
// masternode page): it exists there → open it there (the primary action); it exists on neither → not found; the other network
// couldn't be asked → say so and offer to look.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { profileSearch } from '../config/network.ts';
import { registryForProfile, type ProfileId, type Registry } from '../config/registry.ts';
import { createSource, type DataSource } from '../data/repo.ts';
import { Link } from '../ui/Link.tsx';
import { useTitle } from './title.ts';
import { useApp } from './context.tsx';

export interface OtherNetwork {
  profile: ProfileId;
  /** "Mainnet" / "Testnet": the network looked in, and the one this page is on */
  label: string;
  here: string;
  registry: Registry;
  source: DataSource;
}

const LABEL: Partial<Record<ProfileId, string>> = { mainnet: 'Mainnet', testnet: 'Testnet' };

/** The other public network (Mainnet ↔ Testnet), or null where there is none to look in: demo data, the development profile. */
export function useOtherNetwork(): OtherNetwork | null {
  const { mode, registry } = useApp();
  return useMemo(() => {
    const here = LABEL[registry.profile];
    if (mode !== 'live' || !here) return null;
    const profile: ProfileId = registry.profile === 'mainnet' ? 'testnet' : 'mainnet';
    try {
      const other = registryForProfile(registry, profile);
      return { profile, label: LABEL[profile]!, here, registry: other, source: createSource(mode, other) };
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

/** This page's URL on the other network: same path and query, its `network`. */
export function useOtherNetworkHref(other: OtherNetwork | null): string | null {
  const loc = useLocation();
  return other ? `${loc.pathname}${profileSearch(loc.search, other.profile)}${loc.hash}` : null;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * The heading for a record this network lacks, as the probe stands: "This proposal isn’t on Testnet" once found elsewhere, "Proposal
 * not found" when it is on neither or there is no other network to ask, "No proposal here on Testnet" while that is open.
 */
export function wrongNetworkTitle(what: string, probe: Probe, here: string, other: OtherNetwork | null): string {
  if (probe === 'found') return `This ${what} isn’t on ${here}`;
  return probe === 'absent' || !other ? `${cap(what)} not found` : `No ${what} here on ${here}`;
}

/**
 * What this network lacks and what the other network said. `what`: "proposal"; `missing`: one sentence ("Testnet has no proposal
 * named …"); `absent`: why it may be on neither; `back`: a link to this network's list.
 */
export function NetworkProbeNotice({ what, missing, absent, probe, other, back }: { what: string; missing: string; absent: ReactNode; probe: Probe; other: OtherNetwork | null; back: ReactNode }) {
  const href = useOtherNetworkHref(other);
  if (probe === 'found' && other)
    return (
      <div className="dh-notice dh-notice--info wrong-net-notice" role="status" data-testid="wrong-network-found">
        <p className="dh-notice__title">It’s on {other.label}.</p>
        <p>
          {missing} Each {what} is on one network only; this link opens it with {other.label} chosen.
        </p>
        <div className="dh-notice__actions dh-actions">
          <Link className="dh-btn dh-btn--primary" to={href!} data-testid="wrong-network-open">
            Open it on {other.label} →
          </Link>
          {back}
        </div>
      </div>
    );
  if (probe === 'checking' && other)
    return (
      <div className="dh-notice dh-notice--info wrong-net-notice" role="status" aria-busy="true" data-testid="wrong-network-checking">
        <p>
          {missing} <span className="spinner" aria-hidden="true" /> Checking whether it’s on {other.label}…
        </p>
        <div className="dh-notice__actions dh-actions">{back}</div>
      </div>
    );
  return (
    <div className="dh-notice dh-notice--warn wrong-net-notice" role="status" data-testid={probe === 'absent' ? 'wrong-network-absent' : 'wrong-network-unknown'}>
      <p>
        {missing} {probe === 'absent' && other ? <>{other.label} has none either. {absent}</> : other ? `${other.label} couldn’t be checked just now, so it may be there.` : absent}
      </p>
      <div className="dh-notice__actions dh-actions">
        {probe !== 'absent' && other && (
          <Link className="dh-btn dh-btn--secondary" to={href!} data-testid="wrong-network-look">
            Look on {other.label} →
          </Link>
        )}
        {back}
      </div>
    </div>
  );
}

/** The not-found page of a record, after asking the other network (NetworkProbeNotice). */
export function WrongNetwork(props: Parameters<typeof NetworkProbeNotice>[0]) {
  const { registry } = useApp();
  const title = wrongNetworkTitle(props.what, props.probe, LABEL[registry.profile] ?? 'this network', props.other);
  useTitle(title);
  return (
    <section className="page-narrow wrong-net" data-testid="wrong-network" data-probe={props.probe}>
      <h1 className="dh-page-header__title">{title}</h1>
      <NetworkProbeNotice {...props} />
    </section>
  );
}

/** "Mainnet" / "Testnet" for a public profile. */
export const networkName = (profile: ProfileId): string | null => LABEL[profile] ?? null;
