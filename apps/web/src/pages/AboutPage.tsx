// /about: what govhub is, who it's for, where its data lives, and where to read more. Plain words; the details are on
// /about/verification, /about/trust and the docs on GitHub (docs/privacy.md, docs/self-hosting.md).
import { Link } from 'react-router-dom';
import { TRUST_DOC_URL } from './TrustPage.tsx';

const REPO_URL = 'https://github.com/PastaPastaPasta/govhub';
export const PRIVACY_DOC_URL = `${REPO_URL}/blob/main/docs/privacy.md`;
export const SELF_HOSTING_DOC_URL = `${REPO_URL}/blob/main/docs/self-hosting.md`;
/** The operations wallet (ops seed, m/44'/5'/0'/0/1; deploy/README.md 13.3): it pays the hosted servers' Platform fees. */
export const DONATION_ADDRESS = 'XcLkMQensjHhr5r9SAUVm4meh2HFKaeAXG';

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function AboutPage() {
  return (
    <article className="page-narrow about" aria-labelledby="about-title">
      <h1 id="about-title">About govhub</h1>
      <p className="lede">
        govhub is a place to follow, discuss and vote on Dash governance proposals. It does what dashcentral.org did, but your browser checks the data it’s given
        before showing it as verified.
      </p>

      <h2>Why it exists</h2>
      <p>
        Every month the Dash network pays for the proposals that enough masternodes vote for. Most people follow that process on a website, and have to trust
        whoever runs it to show the proposals and votes as they really are.
      </p>
      <p>
        govhub cuts down how much you have to trust us. Your browser checks each proposal’s text against the fee it paid on the blockchain, so a changed amount,
        address or date shows up as a failure. It checks the signature on every vote and counts the votes again, so nobody can invent a vote or change one.
      </p>
      <p>
        It can’t notice something that’s missing. Our servers, or anyone else’s, could leave out a proposal, leave out some votes, or show a masternode’s older
        vote instead of its latest one. Your browser can only count the votes it was given. If that matters to you, compare with a server you run yourself or
        with your own Dash Core node. <Link to="/about/trust">What we can and can’t lie about</Link> goes through this for each of our servers.
      </p>

      <h2>What you can do here</h2>
      <ul>
        <li>See every active proposal, how its votes stand, whether it’s passing, and whether it fits in the next budget. Older proposals are under Past.</li>
        <li>Comment on proposals, reply and react. Proposal owners can post updates, and get an “owner” label once they’ve proven the proposal is theirs.</li>
        <li>
          Vote with your masternodes. You add their voting keys once, and can then vote on several proposals together. Votes are signed in your browser, and you
          can send them straight away or spread them out over time so they don’t all show up at once.
        </li>
        <li>Get an “MN” badge next to your name, which shows you run a masternode without saying which one.</li>
        <li>Submit your own proposal. A step-by-step form helps you write it, pay the 1 DASH fee the network charges, and send it.</li>
      </ul>
      <p>
        Anyone can read. Commenting, badges and saving your voting keys need an account. You can also vote without one, by signing each vote in Dash Core and
        pasting the signature in.
      </p>

      <h2>How the checking works</h2>
      <p>
        Each proposal has a badge, such as <i>Verified</i> or <i>Partly verified</i>. For <i>Verified</i>, your browser has:
      </p>
      <ul>
        <li>worked out the proposal’s fingerprint from its text, so it can tell if anything in it was changed;</li>
        <li>found the fee the proposal paid, and checked that the payment really is on the Dash blockchain;</li>
        <li>checked the signature on every vote against the masternode that cast it, and counted the votes again;</li>
        <li>used that count to decide whether the proposal passes and whether it fits in the budget.</li>
      </ul>
      <p>
        <i>Verified</i> covers what your browser was given. It doesn’t mean nothing was left out. If any step had to take someone’s word for it, the badge says so. Click the badge on a proposal to see each step. The full explanation is on{' '}
        <Link to="/about/verification">how govhub checks what it shows</Link>.
      </p>

      <h2>Where the data lives</h2>
      <p>
        Proposals and votes are on the Dash network, in the same records Dash Core uses to decide what gets paid. Comments, profiles and badges are only on Dash
        Platform, a public database run by the Dash network, and each one is signed by the person who posted it. Our servers keep a copy of proposals and votes,
        and serve it to anyone who asks.
      </p>
      <p>
        Our servers fetch data from the network and pass votes to it. If they went away, proposals, votes and comments would still be on the Dash network, and
        anyone could run the same software. The one thing at risk is old vote history, which Dash Core discards after a while and our servers keep a copy of.
      </p>

      <h2>Your account</h2>
      <p>
        A govhub account is a Dash Platform identity, so it isn’t stored by us. You sign in with its recovery phrase, a private key, or a passkey. Your phrase and
        keys stay in your browser. If you use a passkey, it unlocks an encrypted copy of your keys that is kept on Dash Platform, which only the passkey can open.
      </p>
      <p>
        Creating an account costs a little DASH, sent from any Dash wallet. Each post or change on Platform then costs a small fee, taken from your account’s
        balance by the network. govhub doesn’t charge anything, and none of that money goes to us.
      </p>

      <h2>Networks</h2>
      <p>
        Settings has a switch for which Dash network you’re looking at. Mainnet is the live network, where votes count and DASH has real value. Testnet is for
        practice: test DASH is free and worth nothing. Dev is for people working on govhub, and you can ignore it.
      </p>

      <h2>Using other servers</h2>
      <p>
        govhub works with servers that anyone can run: the ones that fetch governance data, send votes to the network, or hand out badges. You can switch to
        servers you run or trust in <Link to="/settings">Settings</Link>, and share your settings as a link. To run your own, see{' '}
        <Ext href={SELF_HOSTING_DOC_URL}>running your own govhub servers</Ext>.
      </p>

      <h2>Privacy</h2>
      <p>
        govhub has no ads or analytics, sets no cookies, and never asks for your email address. Our servers see your IP address when you use them, like any
        website, and don’t store it. Cloudflare, which sits in front of them, has its own policy. Anything you post on Dash Platform is public. What each of our
        servers sees and keeps is on <Ext href={PRIVACY_DOC_URL}>our privacy page</Ext>. Other people’s servers follow their own rules.
      </p>

      <h2>Supporting govhub</h2>
      <p>
        Running govhub costs money: the Dash network charges our servers to publish proposals and vote counts, and the servers themselves need a machine to run
        on. <Ext href={`${SELF_HOSTING_DOC_URL}#what-it-costs`}>What it costs</Ext> lists our real numbers. If you’d like to help, donations go to the wallet that
        pays for it:
      </p>
      <p className="donate">
        <a href={`dash:${DONATION_ADDRESS}`} className="mono-ish" data-testid="donation-address">
          {DONATION_ADDRESS}
        </a>
      </p>
      <p className="small muted">Like any Dash address, everything sent to it, and everything it spends, is public on the blockchain.</p>

      <h2>Who runs it</h2>
      <p>
        govhub is open source under the MIT license. The code, the issue tracker and the history of every change are on <Ext href={REPO_URL}>GitHub</Ext>. This
        copy at gov.dashhq.org, and the servers it uses unless you change them, are run by the project’s maintainers. If something looks wrong, please{' '}
        <Ext href={`${REPO_URL}/issues`}>open an issue</Ext>. The technical detail behind this page is in the <Ext href={TRUST_DOC_URL}>trust model</Ext>.
      </p>
    </article>
  );
}
