// Steps 1-3: what the proposal says, when and how much it pays, and a review that fixes ("locks") it for payment. Every rule shown
// here is Dash Core's own (checkNewProposal in @govhub/verify, which runs Core's ValidateProposal on the exact bytes) or one that
// decides whether Core can ever pay it; nothing is published until the user submits.
import {
  checkNewProposal, dashToDuffs, duffsToDash, GOVERNANCE_PROPOSAL_FEE_DUFFS, hexToBytes, lockProposal, MAX_PROPOSAL_DATA_BYTES, proposalSchedule, upcomingSuperblocks, type NewProposalCheck,
  type NewProposalField, type ProposalSchedule, type SuperblockChoice,
} from '@govhub/verify';
import { useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { formatDate, formatDateTime, formatInt } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { ProvGlyph } from '../ui/Provenance.tsx';
import type { Provenance } from '../data/types.ts';
import { feeUnit, type DraftInputs, type DraftLock, type ProposalDraft } from './draft.ts';

/** The govhub page the default URL points at (claim method 1: the URL names the identity, PLAN 6.3). */
export const GOVHUB_PORTAL = 'gov.dashhq.org';
export const govhubUrl = (identityId: string, name: string) => `https://${GOVHUB_PORTAL}/p/${identityId}/${name}`;
const GOVHUB_URL_OWNER = new RegExp(`^https://${GOVHUB_PORTAL.replaceAll('.', '\\.')}/p/([1-9A-HJ-NP-Za-km-z]{32,44})/`);
/** The identity a govhub URL names, or undefined for any other URL. */
export const govhubUrlOwner = (url: string): string | undefined => GOVHUB_URL_OWNER.exec(url)?.[1];
/** A govhub limit for the payment count (Core has none): five years of monthly payments. */
export const MAX_PAYMENTS = 60;

export interface Plan {
  tip: number | null;
  now: number;
  choices: SuperblockChoice[];
  schedule: ProposalSchedule | null;
  duffs: bigint | null;
  url: string;
  check: NewProposalCheck;
  /** Field errors, per field (the first message each). */
  errors: Partial<Record<NewProposalField, string>>;
}

/** Everything derived from the inputs: the URL, the schedule, Core's verdict on the exact bytes. */
export function usePlan(d: ProposalDraft): Plan {
  const { gov, source } = useApp();
  const { session } = useForum();
  const tip = gov.height.data?.value ?? null;
  const now = source.now();
  const network = source.coreNetwork;
  const identityId = session?.identityId ?? d.identityId ?? null;
  const i = d.inputs;
  return useMemo(() => {
    const choices = tip ? upcomingSuperblocks(network, tip, now, 12) : [];
    let schedule: ProposalSchedule | null = null;
    if (tip && i.firstSuperblock) {
      try {
        schedule = proposalSchedule({ network, tipHeight: tip, now, firstSuperblock: i.firstSuperblock, payments: i.payments });
      } catch {
        schedule = null;
      }
    }
    const duffs = dashToDuffs(i.amount);
    const url = i.urlMode === 'govhub' ? (identityId ? govhubUrl(identityId, i.name.trim()) : '') : i.customUrl.trim();
    const check = checkNewProposal({
      network,
      name: i.name.trim(),
      paymentAddress: i.paymentAddress.trim(),
      paymentDuffs: duffs ?? 0n,
      url,
      // placeholders until the schedule step: field errors of the other steps stay meaningful
      startEpoch: schedule?.startEpoch ?? now,
      endEpoch: schedule?.endEpoch ?? now + 86400,
      now,
      superblocks: schedule?.superblocks ?? [],
    });
    const errors: Plan['errors'] = {};
    for (const e of check.errors) errors[e.field] ??= e.message;
    if (i.amount.trim() && duffs === null) errors.paymentAmount = 'enter an amount in DASH, with at most 8 decimals';
    if (i.urlMode === 'govhub' && !identityId) errors.url = 'sign in to use a govhub page, or enter your own link';
    if (!schedule) errors.schedule ??= tip ? 'choose the first payment' : 'waiting for the current block height';
    return { tip, now, choices, schedule, duffs, url, check, errors };
  }, [tip, now, network, identityId, i.name, i.paymentAddress, i.amount, i.urlMode, i.customUrl, i.firstSuperblock, i.payments]);
}

const CHOICE_NOTE: Record<SuperblockChoice['state'], string> = { open: '', tight: ' — little time to vote', closed: ' — too late to enter' };

const STEP_FIELDS: NewProposalField[][] = [['name', 'paymentAddress', 'url'], ['paymentAmount', 'schedule'], ['name', 'paymentAddress', 'url', 'paymentAmount', 'schedule', 'data']];

export function stepErrors(plan: Plan, step: number): string[] {
  return STEP_FIELDS[step]!.flatMap((f) => (plan.errors[f] ? [plan.errors[f]!] : []));
}

function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string | undefined; children: ReactNode; id: string }) {
  return (
    <div className="pw-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="error small" id={`${id}-err`} data-testid={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="muted small" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface EditProps {
  draft: ProposalDraft;
  plan: Plan;
  setInputs(patch: Partial<DraftInputs>): void;
  setStep(s: 0 | 1 | 2): void;
  lock(l: DraftLock): void;
}

export function DetailsStep({ draft, plan, setInputs, setStep }: EditProps) {
  const { session } = useForum();
  const i = draft.inputs;
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const show = (f: NewProposalField, key: string) => (touched[key] || (key === 'url' && i.urlMode === 'govhub') ? plan.errors[f] : undefined);
  const blocking = stepErrors(plan, 0);
  return (
    <form
      className="pw-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched({ name: true, address: true, url: true });
        if (!blocking.length) setStep(1);
      }}
    >
      <Field id="p-name" label="Short name" error={show('name', 'name')} hint="Up to 40 characters: letters, digits, - and _. It is how the proposal is listed, e.g. dash-docs-2027.">
        <input
          id="p-name"
          data-testid="p-name"
          value={i.name}
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInputs({ name: e.target.value })}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
        />
      </Field>
      <Field id="p-address" label="Dash address that receives the payments" error={show('paymentAddress', 'address')} hint="A normal Dash address or a multisig (P2SH) address of this network. Double-check it: payments can't be redirected later.">
        <input
          id="p-address"
          data-testid="p-address"
          value={i.paymentAddress}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setInputs({ paymentAddress: e.target.value })}
          onBlur={() => setTouched((t) => ({ ...t, address: true }))}
        />
      </Field>
      <fieldset className="pw-fieldset">
        <legend>Where voters read about it</legend>
        <label className="check">
          <input type="radio" name="p-url-mode" checked={i.urlMode === 'govhub'} onChange={() => setInputs({ urlMode: 'govhub' })} data-testid="p-url-govhub" />
          <span>
            <b>A page on govhub</b> (recommended). You write the description after submitting; the link proves the proposal is yours.
          </span>
        </label>
        {i.urlMode === 'govhub' &&
          (session ? (
            <p className="pw-url" data-testid="p-url-preview">
              {plan.url || govhubUrl(session.identityId, '<name>')}
            </p>
          ) : (
            <div className="notice-box">
              <p className="small">This needs a govhub sign-in: the link names your Dash identity, which is what lets you publish the description later.</p>
              <button type="button" className="btn btn-s" onClick={openSignIn}>
                Sign in
              </button>
            </div>
          ))}
        <label className="check">
          <input type="radio" name="p-url-mode" checked={i.urlMode === 'custom'} onChange={() => setInputs({ urlMode: 'custom' })} data-testid="p-url-custom" />
          <span>
            <b>My own link</b> (a forum post or document)
          </span>
        </label>
        {i.urlMode === 'custom' && (
          <Field id="p-url" label="Link" error={touched.url ? plan.errors.url : undefined} hint="No spaces. It is fixed once the fee is paid.">
            <input
              id="p-url"
              data-testid="p-url"
              type="url"
              value={i.customUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              onChange={(e) => setInputs({ customUrl: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, url: true }))}
            />
          </Field>
        )}
        {i.urlMode === 'govhub' && plan.errors.url && session && <p className="error small">{plan.errors.url}</p>}
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="p-next">
          Next: payments
        </button>
      </div>
    </form>
  );
}

export function PaymentsStep({ draft, plan, setInputs, setStep }: EditProps) {
  const { gov, params, source } = useApp();
  const i = draft.inputs;
  const [touched, setTouched] = useState(false);
  const blocking = stepErrors(plan, 1);
  const cycle = gov.cycle.data;
  const s = plan.schedule;
  const total = plan.duffs !== null && s ? plan.duffs * BigInt(s.superblocks.length) : null;
  const maxTotal = plan.duffs !== null && s ? plan.duffs * BigInt(s.eligible.length) : null;
  const available = cycle ? cycle.value.budget - cycle.value.allocated : null;
  const firstChoice = plan.choices.find((c) => c.height === i.firstSuperblock);
  const testnet = source.coreNetwork === 'testnet';
  return (
    <form
      className="pw-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!blocking.length) setStep(2);
      }}
    >
      <Field id="p-amount" label="Amount per payment (DASH)" error={touched || i.amount ? plan.errors.paymentAmount : undefined} hint="Paid at each superblock (the network's payout block) while the proposal has enough yes votes.">
        <input id="p-amount" data-testid="p-amount" inputMode="decimal" value={i.amount} autoComplete="off" onChange={(e) => setInputs({ amount: e.target.value })} />
      </Field>
      <div className="row2">
        <Field id="p-first" label="First payment" error={touched && plan.errors.schedule === 'choose the first payment' ? plan.errors.schedule : undefined}>
          <select
            id="p-first"
            data-testid="p-first"
            value={i.firstSuperblock ?? ''}
            onChange={(e) => setInputs({ firstSuperblock: e.target.value ? Number(e.target.value) : null })}
            disabled={!plan.choices.length}
          >
            <option value="">{plan.choices.length ? 'Choose a payout' : 'Loading the chain height…'}</option>
            {plan.choices.map((c) => (
              <option key={c.height} value={c.height} disabled={c.state === 'closed'}>
                {formatDate(c.estTime)} (block {formatInt(c.height)}){CHOICE_NOTE[c.state]}
              </option>
            ))}
          </select>
        </Field>
        <Field id="p-count" label="Number of payments">
          <input
            id="p-count"
            data-testid="p-count"
            type="number"
            min={1}
            max={MAX_PAYMENTS}
            value={i.payments}
            onChange={(e) => setInputs({ payments: Math.max(1, Math.min(MAX_PAYMENTS, Math.floor(Number(e.target.value) || 1))) })}
          />
        </Field>
      </div>
      {gov.height.data && (
        <p className="muted small">
          Dates are estimates from block {formatInt(gov.height.data.value)} <ProvNote prov={gov.height.data.prov} /> at {(params.blockSeconds / 60).toFixed(2)} minutes per block, the estimate Dash Core itself uses.
        </p>
      )}
      {firstChoice && (
        <p className={firstChoice.state === 'tight' ? 'notice-box small' : 'muted small'} data-testid="p-deadline">
          Masternodes must vote yes before block {formatInt(firstChoice.votingDeadline)} (about {formatDateTime(firstChoice.votingDeadlineEstTime)}) for the first payment.
          {firstChoice.state === 'tight' && ' That is soon: the fee needs 6 confirmations first, and voters need time. A later first payment is safer.'}
        </p>
      )}
      {s && plan.duffs !== null && plan.duffs > 0n && (
        <section className="pw-summary" aria-label="Payment summary" data-testid="p-summary">
          <p>
            <b>{duffsToDash(plan.duffs)} DASH</b> × {s.superblocks.length} {s.superblocks.length === 1 ? 'payment' : 'payments'} = <b data-testid="p-total">{duffsToDash(total!)} DASH</b>
          </p>
          <ol className="pw-dates">
            {s.superblocks.map((b) => (
              <li key={b.height}>
                {formatDate(b.estTime)} <span className="muted small">block {formatInt(b.height)}</span>
              </li>
            ))}
          </ol>
          {s.eligible.length > s.superblocks.length && (
            <p className="notice-box small" data-testid="p-eligible">
              {testnet ? 'Testnet pays every hour and Dash Core allows a 2-hour margin around the dates, so' : 'Dash Core allows a 2-hour margin around the dates, so'} this proposal can be paid at up to {s.eligible.length} superblocks:
              up to {duffsToDash(maxTotal!)} DASH in total.
            </p>
          )}
          <p className="muted small">
            A superblock pays at most {duffsToDash(s.superblocks[0]!.budgetLimit)} DASH in total (Dash's consensus rules, computed here).
            {available !== null && cycle && (
              <>
                {' '}
                Of the next one's {duffsToDash(BigInt(cycle.value.budget))} DASH, {duffsToDash(BigInt(Math.max(0, available)))} DASH are not yet promised to proposals that pass{' '}
                <ProvNote prov={cycle.prov} />.
              </>
            )}
          </p>
          {available !== null && plan.duffs > BigInt(Math.max(0, available)) && plan.duffs <= s.superblocks[0]!.budgetLimit && (
            <p className="notice-box small" data-testid="p-budget-warn">
              That is more than is unpromised in the next payout right now. Dash Core pays passing proposals in order of their net yes votes until the budget runs out, so
              this one would need more yes votes than some that are passing today.
            </p>
          )}
        </section>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => setStep(0)}>
          Back
        </button>
        <button type="submit" className="btn btn-primary" data-testid="p-next">
          Next: review
        </button>
      </div>
    </form>
  );
}

export function ReviewStep({ draft, plan, setStep, lock }: EditProps) {
  const { source } = useApp();
  const [error, setError] = useState<string | null>(null);
  const c = plan.check;
  const s = plan.schedule;
  const blocking = stepErrors(plan, 2);
  const ok = !blocking.length && !!c.dataHex && !!s && plan.duffs !== null;
  const json = c.dataHex ? new TextDecoder().decode(hexToBytes(c.dataHex)) : '';
  const doLock = () => {
    setError(null);
    if (!ok) return;
    try {
      // the time is hashed: fixed now, together with the exact bytes (re-checked against Core's rules at this moment)
      const time = Math.floor(source.now());
      const again = checkNewProposal({ ...c.fields!, network: source.coreNetwork, paymentDuffs: plan.duffs!, now: time, superblocks: s!.superblocks });
      if (!again.dataHex || again.dataHex !== c.dataHex) throw new Error(again.errors.map((e) => e.message).join('; ') || 'the proposal changed');
      const l = lockProposal(c.dataHex!, time);
      lock({
        ...l,
        name: c.fields!.name,
        url: c.fields!.url,
        paymentAddress: c.fields!.paymentAddress,
        paymentDuffs: plan.duffs!.toString(),
        startEpoch: c.fields!.startEpoch,
        endEpoch: c.fields!.endEpoch,
        superblocks: s!.superblocks.map((b) => b.height),
        eligible: s!.eligible,
        lockedAt: Date.now(),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="pw-form">
      <dl className="kv pw-review" data-testid="p-review">
        <div>
          <dt>Name</dt>
          <dd>{c.fields?.name ?? draft.inputs.name}</dd>
        </div>
        <div>
          <dt>Pays to</dt>
          <dd className="break">{c.fields?.paymentAddress ?? draft.inputs.paymentAddress}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>
            {plan.duffs !== null ? `${duffsToDash(plan.duffs)} DASH` : '–'} × {s?.superblocks.length ?? '–'}
            {s && plan.duffs !== null && <> = {duffsToDash(plan.duffs * BigInt(s.superblocks.length))} DASH</>}
          </dd>
        </div>
        <div>
          <dt>Payments</dt>
          <dd>{s ? `${formatDate(s.superblocks[0]!.estTime)} to ${formatDate(s.superblocks.at(-1)!.estTime)}` : '–'}</dd>
        </div>
        <div>
          <dt>Link</dt>
          <dd className="break">{plan.url || '–'}</dd>
        </div>
      </dl>
      <CostSummary />
      {ok ? (
        <p className="pw-ok" data-testid="p-core-ok">
          <span aria-hidden="true">✓</span> Passes Dash Core's proposal checks ({c.dataBytes} of {MAX_PROPOSAL_DATA_BYTES} bytes).
        </p>
      ) : (
        <ul className="error small" data-testid="p-review-errors">
          {blocking.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <details className="pw-details">
        <summary>Details: the exact data</summary>
        <p className="small muted">
          Dash Core checks and hashes exactly these bytes (keys in alphabetical order, no spaces). Start {s ? formatDateTime(s.startEpoch) : '–'}, end {s ? formatDateTime(s.endEpoch) : '–'}: halfway
          between the superblocks, the way Dash Core's own proposal dialog sets them.
        </p>
        <pre className="pw-code" data-testid="p-json">{json}</pre>
      </details>
      <p className="notice-box small">
        Next, the proposal is fixed: the fee pays for these exact details and this moment's timestamp. Changing anything afterwards needs a new {duffsToDash(GOVERNANCE_PROPOSAL_FEE_DUFFS)} DASH fee.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => setStep(1)}>
          Back
        </button>
        <button type="button" className="btn btn-primary" disabled={!ok} onClick={doLock} data-testid="p-lock">
          Fix the details and continue to payment
        </button>
      </div>
    </div>
  );
}

/** The cost, up front: the burned fee and the network fee. */
export function CostSummary() {
  const { source } = useApp();
  const unit = feeUnit(source.coreNetwork);
  const fee = duffsToDash(GOVERNANCE_PROPOSAL_FEE_DUFFS);
  return (
    <div className="pw-cost" data-testid="p-cost">
      <p>
        <b>Cost: {fee} {unit}</b> plus a network fee under 0.0001 {unit}.
      </p>
      <p className="small muted">
        The {fee} {unit} is burned by the network to submit the proposal. It is not refunded, even if the proposal does not pass. Payments only happen if
        enough masternodes vote yes.
      </p>
    </div>
  );
}

const PROV_WORDS: Record<Provenance['kind'], string> = {
  proof: 'proved on Dash Platform',
  verified: 'verified here',
  reported: 'reported, not verified',
  mismatch: 'failed a check',
  fixture: 'demo snapshot',
};

/** Where a number came from, in words (every number shows its source and whether it was verified). */
export function ProvNote({ prov }: { prov: Provenance }) {
  return (
    <span className="pw-prov" title={prov.detail ?? prov.source}>
      <ProvGlyph kind={prov.kind} /> ({PROV_WORDS[prov.kind]}: {prov.source})
    </span>
  );
}
