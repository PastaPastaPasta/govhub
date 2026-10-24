// What a badge does and does not hide (PLAN §8.7), per privacy mode, in plain words. A short "learn more" disclosure on the badge
// page and in Settings; never a wall.
import { BLOCK_SECONDS, EPOCH_PARAMS, epochLength } from '@govhub/badge';
import type { CoreNetwork } from '../data/types.ts';
import { BADGE_NETWORKS } from './config.ts';

const days = (blocks: number) => {
  const d = (blocks * BLOCK_SECONDS) / 86400;
  return d >= 2 ? `about ${Math.round(d)} days` : `about ${Math.round(d * 24)} hours`;
};

export function BadgeLeaks({ net, open = false }: { net: CoreNetwork; open?: boolean }) {
  const p = EPOCH_PARAMS[net];
  const minSet = BADGE_NETWORKS[net].minAnonymitySet;
  return (
    <details className="badge-leaks" open={open}>
      <summary>Learn more: what the badge reveals, and to whom</summary>
      <ul className="small">
        <li>
          <b>What readers see:</b> “MN · vouched by X”: X checked that this identity controlled the voting key of a valid masternode. Never which masternode, how many, or
          whether it is an evonode.
        </li>
        <li>
          <b>Standard</b> (the default): the issuer signs a token for the current epoch and your badge is posted right away. The signature is blind, but the issuer sees your
          request and could see the badge appear a minute later, so it could tell which masternode the badge belongs to. The govhub issuer keeps no records or logs that
          would let it (no request times, addresses or masternode ids beyond the one-per-epoch check, deleted when the epoch ends), but you are trusting that; other
          issuers decide for themselves. Switching to Private later does not undo this for an identity that already used Standard with that issuer: use a new identity.
        </li>
        <li>
          <b>Private</b>: the token is for the next epoch, requested at a random time during this one, and the badge is posted at a random time in the first{' '}
          {days(p.graceBlocks)} of the next epoch, so every private token exists before any of those badges appear. The badge hides among the others who chose a private
          mode with the same issuer (the issuer knows who they are). It is not posted if the issuer reported fewer than {minSet} tokens for the epoch before: that is the
          issuer’s own count and includes Standard tokens, so the real crowd can be smaller. A badge that appears for the first time, or stops, can still be matched to a
          masternode that started or stopped asking at the same time when few others did. A request waits for half an hour without Platform writes from this browser,
          and posts wait half an hour after a request. A badge appears up to about one epoch plus {days(p.graceBlocks)} after you ask (Extra private: plus up to half an epoch more; an epoch is {days(epochLength(p))}).
        </li>
        <li>
          <b>Extra private</b>: like Private, but the badge is posted at a random time across the first half of the next epoch.
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
          encrypted with a key derived from your identity’s signing key.
        </li>
      </ul>
    </details>
  );
}
