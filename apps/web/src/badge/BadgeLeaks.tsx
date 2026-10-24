// What a badge does and does not hide (PLAN §8.7), in plain words. Shown on the badge page and in Settings.
import { BLOCK_SECONDS, EPOCH_PARAMS, epochLength, type BadgeNetwork } from '@govhub/badge';

const days = (blocks: number) => {
  const d = (blocks * BLOCK_SECONDS) / 86400;
  return d >= 2 ? `about ${Math.round(d)} days` : `about ${Math.round(d * 24)} hours`;
};

export function BadgeLeaks({ net, open = false }: { net: BadgeNetwork; open?: boolean }) {
  const p = EPOCH_PARAMS[net];
  return (
    <details className="badge-leaks" open={open}>
      <summary>What the badge reveals, and to whom</summary>
      <ul className="small">
        <li>
          <b>What readers see:</b> “MN · vouched by X”. It means X checked that this identity controlled the voting key of a valid masternode. Never which masternode, how many, or
          whether it is an evonode.
        </li>
        <li>
          <b>What the issuer learns:</b> which masternode asked, when, and from which IP address and browser. It does not learn which identity got the badge: the signature is blind.
          Your badge hides among the masternodes that asked the same issuer in the same epoch, not among all masternodes.
        </li>
        <li>
          <b>Nothing public about your masternode:</b> the issuer keeps its one-token-per-masternode record privately and deletes it when the epoch’s window closes. It publishes only
          how many tokens it issued, and readers hide its badges if it shows more badges than that.
        </li>
        <li>
          <b>Timing:</b> your request goes out at a random time during the epoch before the badge’s epoch, and the badge is posted at a random time in the first {days(p.graceBlocks)} of
          its epoch. If the app is closed at that time, it runs on your next visit after a random delay. A new badge therefore appears up to one epoch ({days(epochLength(p))}) after you
          ask, and renews every epoch while you keep the voting key here.
        </li>
        <li>
          <b>The same operator:</b> if one organisation runs this portal, the issuer and the network nodes, it can try to match your IP address and timing. The request goes from a
          worker to the issuer’s own address, without cookies or referrer. Use Tor or a VPN for the browser if that matters to you, and consider adding a second, independent issuer.
        </li>
        <li>
          <b>Your own words:</b> a comment that says how you voted can be matched against the public vote records of each masternode, which reveals the masternode and how many share
          its voting key. Keep voting and commenting apart.
        </li>
        <li>
          <b>One masternode per identity:</b> ask with one masternode. Asking with several tells the issuer they belong together, and an identity shows one badge per issuer anyway.
        </li>
        <li>
          <b>Funding:</b> do not fund this identity from wallets tied to your masternode (collateral, payout or owner addresses) or with credits sent from a masternode’s identity. A
          faucet voucher is fine: the faucet never checks masternode status.
        </li>
        <li>
          <b>Delegated keys:</b> whoever holds a voting key (a hosting provider, a pool) can get a badge with it. The badge means “controls a valid masternode’s voting key”.
        </li>
        <li>
          <b>Issuer honesty:</b> an issuer can vouch for identities that own no masternode. That is why the badge names who vouched, and why you choose the issuers you trust.
        </li>
        <li>
          <b>In this browser:</b> a pasted voting key and the request’s blinding secret are stored encrypted with a key derived from your identity’s signing key.
        </li>
      </ul>
    </details>
  );
}
