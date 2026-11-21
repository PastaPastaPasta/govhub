// Comment editor: markdown with a live preview, the UTF-8 byte budget (5,000 B), the fee estimate and the balance
// it will be paid from, shown before anything is signed.
import { useId, useState, type FormEvent } from 'react';
import { commentCost, COMMENT_MAX_BYTES, isBlank, upfrontRequired } from '@govhub/forum';
import { useForum } from '../app/forum.tsx';
import { formatCredits, formatInt } from '../lib/format.ts';
import { isShort } from '../voting/funds.ts';
import { Markdown } from './Markdown.tsx';
import { useAction } from './useAction.ts';
import { LowBalance, WriteError } from './WriteError.tsx';

const enc = new TextEncoder();

export function Composer({
  onSubmit,
  onCancel,
  label,
  hint,
  autoFocus = false,
}: {
  onSubmit(body: string): Promise<void>;
  onCancel?: () => void;
  label: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  const { balance } = useForum();
  const hintId = useId();
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const { busy, error, needsTopUp, run } = useAction();
  // "Posted" stays until the next keystroke: the comment lands in the thread above or below the form, and a form that just empties
  // looks like nothing happened.
  const [posted, setPosted] = useState(false);
  const bytes = enc.encode(body).length;
  const cost = commentCost(bytes);
  const over = bytes > COMMENT_MAX_BYTES;
  const required = upfrontRequired(cost); // Platform wants more available than the fee itself
  const poor = isShort(balance, cost, true);
  const blank = isBlank(body); // zero-width, bidi and other invisible characters alone are not a comment
  const submit = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await onSubmit(body);
      setBody('');
      setPreview(false);
      setPosted(true);
    });
  };
  return (
    <form className="composer" onSubmit={submit}>
      {hint && (
        <p className="muted small" id={hintId} data-testid="composer-hint">
          {hint}
        </p>
      )}
      <div className="composer-tabs dh-tabs" role="group" aria-label="Editor mode">
        <button type="button" className={`btn dh-btn btn-quiet dh-btn--quiet ${preview ? '' : 'on'}`} aria-pressed={!preview} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" className={`btn dh-btn btn-quiet dh-btn--quiet ${preview ? 'on' : ''}`} aria-pressed={preview} onClick={() => setPreview(true)} disabled={blank}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="composer-preview">
          <Markdown text={body} />
        </div>
      ) : (
        <textarea className="dh-textarea" aria-label={label} aria-describedby={hint ? hintId : undefined} value={body} onChange={(e) => (setBody(e.target.value), setPosted(false))} rows={4} placeholder="Formatting: **bold**, _italic_, `code`, links, lists, > quotes. HTML is not shown; images appear as links." autoFocus={autoFocus} />
      )}
      <div className="composer-foot">
        <p className={`small ${over ? 'error' : 'muted'}`} data-testid="composer-meta">
          {bytes > COMMENT_MAX_BYTES * 0.8 && `${formatInt(bytes)} / ${formatInt(COMMENT_MAX_BYTES)} bytes · `}costs about <b>{formatCredits(cost, true)}</b> · your balance {balance === null ? '…' : formatCredits(balance)}
        </p>
        <div className="form-actions">
          {onCancel && (
            <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn dh-btn btn-primary dh-btn--primary" disabled={busy || blank || over || poor}>
            {busy ? 'Posting…' : label}
          </button>
        </div>
      </div>
      {poor && <LowBalance what="this comment" balance={balance} needed={required} />}
      {/* the low-balance line above already offers Top up */}
      <WriteError error={error} needsTopUp={needsTopUp && !poor} />
      {posted && !busy && !error && (
        <p className="notice small" role="status" data-testid="composer-posted">
          Posted. There is no need to post it again.
        </p>
      )}
    </form>
  );
}
