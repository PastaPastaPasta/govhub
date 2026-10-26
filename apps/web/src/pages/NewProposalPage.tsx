// Create a proposal (replaces proposal.dash.org; PLAN 6.1). Step by step in plain words, the cost up front, technical detail behind
// "Details". Drafts stay in this browser (and in the backup file); nothing is published until the proposal is submitted.
import { duffsToDash } from '@govhub/verify';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { formatDateTime, shortHash } from '../lib/format.ts';
import { superblockPhrase } from '../lib/governance.ts';
import { CostSummary, DetailsStep, PaymentsStep, ReviewStep, usePlan, type EditProps } from '../proposal/EditSteps.tsx';
import { BackupError, draftStage, draftStore, mergeDraft, newDraft, readBackup, type DraftInputs, type ProposalDraft } from '../proposal/draft.ts';
import { PayStep } from '../proposal/PayStep.tsx';
import { demoServices, liveServices, type WizardServices } from '../proposal/services.ts';
import { SubmitStep } from '../proposal/SubmitStep.tsx';
import '../voting/voting.css';
import '../proposal/proposal.css';

const STEP_LABELS = ['Details', 'Payments', 'Review', 'Pay the fee', 'Submit'];
const MAX_BACKUP_BYTES = 64 * 1024;

export function NewProposalPage() {
  const { source, mode } = useApp();
  const network = source.coreNetwork;
  const services = useMemo<WizardServices>(() => (mode === 'fixtures' ? demoServices(network) : liveServices(source)), [mode, network, source]);
  const store = useMemo(() => draftStore(localStorage), []);
  const [params, setParams] = useSearchParams();
  const id = params.get('d');
  const [nonce, setNonce] = useState(0);
  const drafts = useMemo(() => store.list(network), [store, network, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const draft = id ? (drafts.find((d) => d.id === id) ?? store.load(id)) : null;
  /** Saves a new or restored draft and opens it. */
  const adopt = (d: ProposalDraft) => {
    store.save(d);
    setNonce((n) => n + 1);
    setParams({ d: d.id });
  };

  if (draft && draft.network !== network) {
    return (
      <section className="page-narrow">
        <h1>Create a proposal</h1>
        <p className="notice-box">This draft is for Dash {draft.network}; govhub is set to {network}. Switch the network profile in Settings to continue it.</p>
      </section>
    );
  }
  if (!draft) {
    return (
      <Start
        drafts={drafts}
        demo={services.demo}
        onOpen={(d) => setParams({ d: d.id })}
        onNew={() => adopt(newDraft(network))}
        onRestored={(d) => adopt(mergeDraft(store.load(d.id), d))}
      />
    );
  }
  return <Wizard key={draft.id} initial={draft} services={services} onChange={() => setNonce((n) => n + 1)} />;
}

const STAGE_TEXT = { edit: 'Being written', pay: 'Fee not paid yet', submit: 'Paid; being submitted', done: 'Live' } as const;

function Start({ drafts, demo, onOpen, onNew, onRestored }: { drafts: ProposalDraft[]; demo: boolean; onOpen(d: ProposalDraft): void; onNew(): void; onRestored(d: ProposalDraft): void }) {
  const { source, params } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = async (f: File) => {
    setError(null);
    if (f.size > MAX_BACKUP_BYTES) return setError('That file is too large to be a proposal backup.');
    try {
      onRestored(readBackup(await f.text(), source.coreNetwork));
    } catch (e) {
      setError(e instanceof BackupError ? e.message : `The file could not be read: ${(e as Error).message}`);
    }
  };
  return (
    <section className="page-narrow pw" aria-labelledby="pw-title" data-testid="p-start">
      <h1 id="pw-title">Create a proposal</h1>
      <p className="pw-lede">Ask the Dash treasury to fund your work. Masternodes vote on proposals; those with enough yes votes are paid at each {superblockPhrase(params)}.</p>
      {demo && <p className="notice-box small">Demo data: payments and the relay are simulated, nothing is sent anywhere.</p>}
      <CostSummary />
      <ol className="pw-overview small">
        <li>Describe it: a short name, the address that gets paid, a link to the full description.</li>
        <li>Choose the amount and how many payments (one at each superblock).</li>
        <li>Review it against Dash Core's rules.</li>
        <li>Save a backup, then pay the fee from any wallet or from Dash Core.</li>
        <li>govhub sends it to the network once the payment is ChainLocked (usually within a few minutes). It goes live after 6 confirmations (about 15 minutes).</li>
      </ol>
      {drafts.length > 0 && (
        <section aria-labelledby="pw-drafts-title">
          <h2 id="pw-drafts-title">Continue</h2>
          <ul className="pw-drafts" data-testid="p-drafts">
            {drafts.map((d) => (
              <li key={d.id}>
                <button type="button" className="choice" onClick={() => onOpen(d)}>
                  <b>{d.lock?.name || d.inputs.name || 'Untitled proposal'}</b>
                  <span className="small muted">
                    {STAGE_TEXT[draftStage(d)]}
                    {d.lock && ` · ${shortHash(d.lock.govHash, 6)}`} · {formatDateTime(Math.floor(d.updatedAt / 1000))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-primary btn-l" onClick={onNew} data-testid="p-new">
          Start a new proposal
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="p-restore">
          Restore from a backup file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="p-restore-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void restore(f);
          }}
        />
      </div>
      {error && (
        <p className="error" role="alert" data-testid="p-restore-error">
          {error}
        </p>
      )}
    </section>
  );
}

function Wizard({ initial, services, onChange }: { initial: ProposalDraft; services: WizardServices; onChange(): void }) {
  const store = useMemo(() => draftStore(localStorage), []);
  const { session } = useForum();
  const [draft, setDraft] = useState(initial);
  const ref = useRef(initial);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Applies `f` to the latest draft and saves it synchronously; throws when it could not be saved (callers then stop). */
  const commit = useCallback(
    (f: (d: ProposalDraft) => ProposalDraft): ProposalDraft => {
      const next = { ...f(ref.current), updatedAt: Date.now() };
      try {
        store.save(next);
      } catch (e) {
        setSaveError(`This browser could not save the proposal (${(e as Error).message}). Nothing was paid; free some storage and try again.`);
        throw e;
      }
      setSaveError(null);
      ref.current = next;
      setDraft(next);
      onChange();
      return next;
    },
    [store, onChange],
  );
  const plan = usePlan(draft);
  const stage = draftStage(draft);
  const step = stage === 'edit' ? draft.editStep : stage === 'pay' ? 3 : 4;
  // each step starts at the top of the page
  useEffect(() => {
    // newer browsers return a Promise from scrollTo: never hand it to React as a cleanup
    window.scrollTo({ top: 0 });
  }, [step]);
  const edit: EditProps = {
    draft,
    plan,
    setInputs: (patch: Partial<DraftInputs>) => commit((d) => ({ ...d, inputs: { ...d.inputs, ...patch }, ...(session && d.inputs.urlMode === 'govhub' ? { identityId: session.identityId } : {}) })),
    setStep: (s) => commit((d) => ({ ...d, editStep: s })),
    lock: (l) => commit((d) => ({ ...d, lock: l, identityId: session?.identityId ?? d.identityId })),
  };
  return (
    <section className="page-narrow pw" aria-labelledby="pw-title" data-testid="p-wizard" data-stage={stage}>
      <p className="small">
        <Link to="/create">← All proposals in progress</Link>
      </p>
      <h1 id="pw-title">{draft.lock?.name ?? (draft.inputs.name || 'Create a proposal')}</h1>
      {services.demo && <p className="notice-box small">Demo: payments and the relay are simulated, nothing is sent anywhere.</p>}
      <ol className="pw-steps" aria-label="Steps">
        {STEP_LABELS.map((l, i) => (
          <li key={l} data-status={i < step || stage === 'done' ? 'done' : i === step ? 'now' : 'todo'} aria-current={i === step ? 'step' : undefined}>
            <span className="pw-step-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="pw-step-l">{l}</span>
          </li>
        ))}
      </ol>
      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}
      {stage === 'edit' && draft.editStep === 0 && <DetailsStep {...edit} />}
      {stage === 'edit' && draft.editStep === 1 && <PaymentsStep {...edit} />}
      {stage === 'edit' && draft.editStep === 2 && <ReviewStep {...edit} />}
      {stage === 'pay' && <PayStep draft={draft} commit={commit} services={services} />}
      {(stage === 'submit' || stage === 'done') && <SubmitStep draft={draft} commit={commit} services={services} />}
      {stage !== 'edit' && draft.lock && (
        <p className="muted small pw-foot">
          {draft.lock.name}: {duffsToDash(BigInt(draft.lock.paymentDuffs))} DASH × {draft.lock.superblocks.length}, hash {shortHash(draft.lock.govHash, 8)}
        </p>
      )}
    </section>
  );
}
