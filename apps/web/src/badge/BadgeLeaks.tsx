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
        The issuer signs a token for the current epoch and your badge is posted right away. The signature is blind, but the issuer sees your request and could see the
        badge appear a minute later, so it could tell which masternode the badge belongs to. The operator of the govhub issuer commits to keeping no records or logs that
        would let it (no request times, addresses or masternode ids beyond the one-per-epoch check, which is deleted when the epoch ends; see its <PolicyLink />). That is a
        promise you are trusting, not something this app can check; other issuers decide for themselves. Switching to Private later does not undo this for an identity
        that already used Standard with that issuer: use a new identity.
      </>
    );
  }
  if (mode === 'private') {
    return (
      <>
        The token is for the next epoch, requested at a random time during this one, and the badge is posted at a random time within about the first {span(p.graceBlocks)}{' '}
        of the next epoch, so every private token exists before any of those badges appear. That makes it harder for the issuer to match the badge to your masternode by
        timing, not impossible: the badge hides only among the others who chose a private mode with the same issuer (the issuer knows who they are). The app posts it only
        if the issuer reported at least {minSet} tokens for the epoch before; for an issuer’s first epoch there is no earlier count, and the badge is posted without
        this check. That count is the issuer’s own and includes Standard tokens (the report cannot tell them
        apart), so the private crowd can be smaller than it says. A badge that appears for the first time, or stops, can still be matched to a masternode that started or
        stopped asking at the same time when few others did. A request waits for half an hour without Platform writes from this browser, and posts wait half an hour after
        a request. A badge appears up to about one epoch plus {span(p.graceBlocks)} after you ask (an epoch is about {span(epochLength(p))}).
      </>
    );
  }
  return (
    <>
      Like Private, but the badge is posted at a random time across the first half of the next epoch, so its timing is spread wider and harder to match. It can take up to
      half an epoch longer to appear. The same limits apply: the crowd is only those who chose a private mode with the same issuer.
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
          <b>Extra private</b>: <ModeDetails mode="extra" net={net} />
        </li>
        <li>
          <b>In every mode</b> the issuer learns which masternode asked, when, and from which IP address, and the network nodes this app talks to see the same address when your
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
          <b>In this browser:</b> a pending request’s blinding secret, and a pasted voting key until the request is sent (or for good, if you renew automatically), are stored
          encrypted with a key derived from your identity’s signing key. A request moves on only while this app is open and you are signed in as this identity with the
          same sign-in key; a pending one can be cancelled, which deletes it and its key.
        </li>
      </ul>
    </details>
  );
}
