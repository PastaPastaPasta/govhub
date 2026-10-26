// What a badge does and does not hide (PLAN §8.7, §8.8), per privacy mode, in plain words. A short "learn more" disclosure on the
// badge page and in Settings, and one per mode next to the mode choice; never a wall.
import { BLOCK_SECONDS, EPOCH_PARAMS, epochLength, type PrivacyMode } from '@govhub/badge';
import type { CoreNetwork } from '../data/types.ts';
import { BADGE_NETWORKS } from './config.ts';

/** The govhub issuer's logging policy: what its operator commits to keep and not keep. */
const ISSUER_POLICY_URL = 'https://github.com/PastaPastaPasta/govhub/blob/main/services/issuer/README.md#what-is-stored-and-logged-logging-policy';

/** "3 hours", "25 hours", "32 days" (no "about": the caller words it). */
export const span = (blocks: number): string => {
  const d = (blocks * BLOCK_SECONDS) / 86400;
  return d >= 2 ? `${Math.round(d)} days` : `${Math.max(1, Math.round(d * 24))} hours`;
};

export function PolicyLink() {
  return (
    <a href={ISSUER_POLICY_URL} target="_blank" rel="noreferrer noopener" data-testid="badge-policy-link">
      logging policy
    </a>
  );
}

/** The details of one mode: the badge page shows each under its own "learn more", BadgeLeaks shows all of them. */
export function ModeDetails({ mode, net }: { mode: PrivacyMode; net: CoreNetwork }) {
  const p = EPOCH_PARAMS[net];
  const minSet = BADGE_NETWORKS[net].minAnonymitySet;
  if (mode === 'standard') {
    return (
      <>
        The issuer blind-signs a token for the current epoch once nothing has been posted from this browser for half an hour, plus a random extra wait (about an
        hour on average). The token stays in this browser, and the badge is posted together with your next post, comment or reaction at least half an hour later, so
        it appears with your own activity, not right after the request. The issuer could still try to narrow it down from when you posted before and after its
        request; the random wait and a longer gap make that harder, not impossible. <b>Register now</b> posts it at once, and then the issuer can match it to your
        masternode by timing. Switching to Private later does not undo a match for an identity that already showed a badge: use a new identity for that. The token is
        kept in this browser only: posting from another device does not publish it. If nothing is posted before its epoch’s badges stop showing (about{' '}
        {span(p.graceBlocks)} after the epoch ends; an epoch is about {span(epochLength(p))}), it lapses, and the masternode can ask again only in the next epoch. The
        govhub issuer’s operator commits to keeping no records that would link a request to a badge (<PolicyLink />); that is a promise, not something this app can
        check.
      </>
    );
  }
  return (
    <>
      The token is for the next epoch, requested at a random time during this one, and the badge is posted at a random time within about the first {span(p.graceBlocks)} of
      the next epoch, so every Private token exists before any Private badge appears. The badge hides among the others who chose Private with the same issuer (the
      issuer knows who they are). It is posted only if the issuer reported at least {minSet} tokens for the epoch before (Standard ones included, so the Private crowd
      can be smaller); for an issuer’s first epoch there is no earlier count and the badge is posted without this check. A badge that appears for the first time, or
      stops, can still be matched to a masternode that started or stopped asking at the same time. A badge appears up to about one epoch plus {span(p.graceBlocks)} after
      you ask (an epoch is about {span(epochLength(p))}).
    </>
  );
}

export function BadgeLeaks({ net, open = false }: { net: CoreNetwork; open?: boolean }) {
  return (
    <details className="badge-leaks" open={open}>
      <summary>Learn more: what the badge reveals, and to whom</summary>
      <ul className="small">
        <li>
          <b>What readers see:</b> “MN · vouched by X”: X checked that this identity controlled the voting key of a valid masternode. Never which masternode, how many, or
          whether it is an evonode.
        </li>
        <li>
          <b>Standard</b> (the default): <ModeDetails mode="standard" net={net} />
        </li>
        <li>
          <b>Private</b>: <ModeDetails mode="private" net={net} />
        </li>
        <li>
          <b>In every mode</b> a token request waits until nothing has been posted from this browser for half an hour or more, and no badge is posted in the half hour
          after a request. The issuer learns which masternode asked, when, and from which IP address, and the network nodes this app talks to see the same address when your
          identity reads or writes. Use Tor or a VPN if that matters. Cloudflare, in front of our services, sees request metadata at its edge; that is outside our control.
        </li>
        <li>
          <b>Your own words:</b> a comment that says how you voted can be matched against the public vote records of each masternode. Keep voting and commenting apart.
        </li>
        <li>
          <b>One masternode per identity:</b> ask with one. Asking with several tells the issuer they belong together, and an identity shows one badge per issuer anyway.
          Do not fund this identity from wallets tied to your masternode.
        </li>
        <li>
          <b>Delegated keys and honesty:</b> whoever holds a voting key can get a badge with it, and an issuer could vouch for identities that own no masternode: that is why the
          badge names who vouched, and why you choose the issuers you trust.
        </li>
        <li>
          <b>In this browser:</b> a pending request’s blinding secret, a token waiting to be posted, and a pasted voting key until the request is sent (or for good, if you
          renew automatically), are stored encrypted with a key derived from your identity’s signing key, never on Platform. A request moves on only while this app is open and you are signed in as this identity with the
          same sign-in key; a pending one can be cancelled, which deletes it and its key.
        </li>
      </ul>
    </details>
  );
}
