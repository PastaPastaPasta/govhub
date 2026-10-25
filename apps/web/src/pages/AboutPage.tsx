// /about/verification: what the trust badge means, in plain words (the rules are verify/aggregate.ts; README has the same list).
import { Link } from 'react-router-dom';
import type { ProvenanceKind } from '../data/types.ts';
import { LEVEL_LABEL, type TrustLevel } from '../verify/aggregate.ts';
import { ProvGlyph } from '../ui/Provenance.tsx';
import { ShieldIcon } from '../ui/trust/TrustBadge.tsx';

const STATES: Array<[TrustLevel, string]> = [
  ['verified', 'Every check below was proven in your browser. Nothing rests on a server’s or a node’s word.'],
  ['checking', 'The checks are still running. The first visit downloads the chain’s headers; later ones reuse them.'],
  ['partial', 'Every check finished, but something rests on someone’s word. The badge says what, in one line.'],
  ['error', 'A check couldn’t finish, usually because the network couldn’t be reached. Open the badge and choose Re-check.'],
  ['failed', 'A check contradicted the data. The proposal is hidden from the lists, and its page says what failed.'],
  ['demo', 'Recorded sample data for trying govhub. Never “Verified”.'],
];

const CHECKS: Array<[string, string]> = [
  ['The proposal text', 'The proposal’s fingerprint (its governance hash) is recomputed from the published text, and every field shown, from the name to the amount and dates, is the one it covers.'],
  ['The submission fee', 'Every proposal burns a fee on the Dash chain that names that fingerprint. Your browser fetches that transaction, checks it, and proves it sits in a final block of the chain it verified itself from a checkpoint built into govhub, at the published height.'],
  ['The chain and the masternode list', 'The list of masternodes, and so the number of votes a proposal needs, is proven by the chain too.'],
  ['The vote count', 'Every signed vote behind the tally is checked against the masternode’s voting key and recounted. The result must equal the tally recorded on Dash Platform, down to its fingerprint of the whole vote set.'],
  ['Funding', '“Passing” or “needs more votes” follows from the recount and the proven threshold. Whether a passing proposal fits in the next budget comes from recounting and ranking every active proposal the way Dash Core does.'],
];

const GLYPHS: Array<[ProvenanceKind, string, string]> = [
  ['verified', 'Proven', 'Checked in your browser against the chain.'],
  ['reported', 'Reported', 'As a bridge, a node or a feed says. Not checked.'],
  ['mismatch', 'Failed', 'Checked, and it did not match.'],
  ['proof', 'Platform proof', 'Read from Dash Platform; evo-sdk checked the proof against the quorum’s signature.'],
  ['fixture', 'Demo', 'Recorded sample data.'],
];

export function AboutPage() {
  return (
    <article className="page-narrow about" aria-labelledby="about-v-title">
      <h1 id="about-v-title">How govhub checks what it shows</h1>
      <p className="lede">
        govhub doesn’t ask you to trust a server. When you open a proposal, your browser checks it against the Dash chain by itself, in the background, and sums the
        result up in one badge. Click the badge on any proposal to see every check.
      </p>

      <h2>The badge</h2>
      <ul className="about-states">
        {STATES.map(([level, text]) => (
          <li key={level}>
            <span className={`trust trust-${level} trust-m`}>
              <ShieldIcon level={level} />
              <span className="trust-word">{LEVEL_LABEL[level]}</span>
            </span>
            <p>{text}</p>
          </li>
        ))}
      </ul>

      <h2>What “Verified” means</h2>
      <p>All five of these, proven:</p>
      <ol className="about-checks">
        {CHECKS.map(([title, text]) => (
          <li key={title}>
            <b>{title}.</b> {text}
          </li>
        ))}
      </ol>

      <details className="learn">
        <summary>What never counts as proven</summary>
        <ul className="small">
          <li>A node’s word about a transaction’s block, confirmations or ChainLock, even when a second node agrees.</li>
          <li>A ChainLock checked against a masternode list that only nodes agree on, when the chain itself couldn’t be verified.</li>
          <li>A collateral that no ChainLock covers yet, or whose height differs from the published one.</li>
          <li>Testnet’s proof of work, which is too weak to stop a forged chain (testnet is verified through quorum proofs instead).</li>
          <li>Voting keys as the bridge reports them, or a tally that is only the bridge’s own and not on Platform.</li>
          <li>A tally’s “in the next budget” flag, which whoever publishes it sets.</li>
        </ul>
      </details>

      <h2>What it can’t detect</h2>
      <p>
        A bridge can <b>withhold</b>. The recount proves the votes it was given, so votes the bridge didn’t serve can’t be detected, and neither can a proposal
        it never published. Using more than one bridge (Settings) or your own Dash Core node closes that gap. Who owns a proposal is checked separately, from
        the owner’s signed claim, and is not part of the badge.
      </p>

      <h2>Your own votes</h2>
      <p>
        When you vote with your masternodes, govhub follows each vote until the network has it, and checks that the vote the network now holds is yours: the
        exact signature, against your voting key. “Counted” means a recount of the tally includes it. Open “Check it yourself” on the confirmation to see the
        signature and the Dash Core command that shows the same.
      </p>

      <details className="learn">
        <summary>The marks inside the details</summary>
        <dl className="glyph-legend">
          {GLYPHS.map(([kind, name, text]) => (
            <div key={kind}>
              <dt>
                <ProvGlyph kind={kind} /> {name}
              </dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </details>

      <details className="learn">
        <summary>Where the data comes from</summary>
        <p className="small">
          Proposals, tallies, comments and profiles live on Dash Platform, read with proofs. Transactions, blocks, ChainLocks and the masternode list come from
          DAPI evonodes. Signed votes come from a bridge, a Dash Core node that publishes governance data, because DAPI has no governance calls. Every one of
          these can be replaced in <Link to="/settings">Settings</Link>.
        </p>
      </details>
    </article>
  );
}
