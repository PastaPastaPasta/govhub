// /about/trust: what the people running govhub's servers could and couldn't lie about, in plain words. The full, code-cited
// version is docs/TRUST.md; keep the two in step.
import { Link } from 'react-router-dom';

export const TRUST_DOC_URL = 'https://github.com/PastaPastaPasta/govhub/blob/main/docs/TRUST.md';

const POINTS: Array<[string, string]> = [
  [
    'Proposals can’t be altered.',
    'Your browser recomputes each proposal’s fingerprint from its text and finds the fee on the Dash chain that names it. A changed name, amount, address or date fails the check. If the nodes don’t return the fee transaction, the proposal shows “Couldn’t verify”, not “Failed”: nodes can’t prove a transaction doesn’t exist.',
  ],
  [
    'Votes can’t be forged, but they can be left out.',
    'Every vote is signed by a masternode’s voting key and recounted in your browser. Only votes from masternodes in the masternode list your browser proved, signed with the voting key that list gives them, are counted; any other vote is left out of the count and flagged as excluded. The “How do we know?” drawer gives the reason for each kind and lists the first few such votes. A server can’t change a signed vote. But it can leave votes or whole proposals out, or show an older vote instead of a newer one, and nothing here detects that. Compare with another bridge or your own Dash Core node.',
  ],
  [
    'Your vote can be delayed, not changed.',
    'A relay holds your signed vote until it sends it. It can hold it back or drop it, and it sees your IP address, the time and how you voted, but it can’t change the vote. Once sent, the status says what the bridge reports (“the bridge reports the network counted it”), and names any other bridge or relay you configured that agrees. Check your own node if it matters.',
  ],
  [
    'The chain is checked from checkpoints built into this app.',
    'Blocks, the masternode list and the votes a proposal needs are proven from checkpoints in govhub’s code, through ChainLocks or, when no quorum proof is available, proof of work. Nodes can refuse to answer, but can’t fake the chain without the Dash network’s own signing quorums or mining power. On testnet, mining power protects little, and the app says so.',
  ],
  [
    '“MN · vouched by X” is X’s word.',
    'A badge issuer could vouch for someone who runs no masternode. You choose which issuers to trust in Settings. Blind signatures stop an issuer from linking a badge to a masternode, unless it matches them by timing (Standard mode).',
  ],
  [
    'Moderation hides, it doesn’t delete.',
    'The default block list is ours and hides posts from view in this app. You can turn it off or choose other lists in Settings.',
  ],
  [
    'The app itself is the biggest trust.',
    'Whoever serves this website could serve different code. To remove that trust, build govhub from its source and run it yourself, with your own backends.',
  ],
];

export function TrustPage() {
  return (
    <article className="page-narrow about" aria-labelledby="about-t-title">
      <h1 id="about-t-title">What we can and can’t lie about</h1>
      <p className="lede">
        govhub checks most of what it shows in your browser. Some things still rest on someone’s word: here is what the people running govhub’s servers could get wrong
        or hide, and what they couldn’t.
      </p>
      <ul className="about-checks" data-testid="trust-points">
        {POINTS.map(([title, text]) => (
          <li key={title}>
            <b>{title}</b> {text}
          </li>
        ))}
      </ul>
      <p>
        The details, with every server and what it could do, are in{' '}
        <a href={TRUST_DOC_URL} target="_blank" rel="noopener noreferrer" data-testid="trust-doc-link">
          the trust model on GitHub
        </a>
        . What each badge state means is on <Link to="/about/verification">How govhub checks what it shows</Link>.
      </p>
    </article>
  );
}
