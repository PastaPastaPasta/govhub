// Comment editor: markdown with a live preview, the UTF-8 byte budget (5,000 B), the fee estimate and the balance
// it will be paid from, shown before anything is signed.
import { useState, type FormEvent } from 'react';
import { commentCost, COMMENT_MAX_BYTES, isBlank, upfrontRequired } from '@govhub/forum';
import { useForum } from '../app/forum.tsx';
import { formatCredits, formatInt } from '../lib/format.ts';
import { isShort } from '../voting/funds.ts';
import { Markdown } from './Markdown.tsx';
import { useAction } from './useAction.ts';
import { LowBalance, WriteError } from './WriteError.tsx';

const enc = new TextEncoder();

export function Composer({ onSubmit, onCancel, label, autoFocus = false }: { onSubmit(body: string): Promise<void>; onCancel?: () => void; label: string; autoFocus?: boolean }) {
  const { balance } = useForum();
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
  const poor = isShort(balance, cost);
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
      <div className="composer-tabs" role="group" aria-label="Editor mode">
        <button type="button" className={`btn btn-quiet ${preview ? '' : 'on'}`} aria-pressed={!preview} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" className={`btn btn-quiet ${preview ? 'on' : ''}`} aria-pressed={preview} onClick={() => setPreview(true)} disabled={blank}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="composer-preview">
          <Markdown text={body} />
        </div>
      ) : (
        <textarea aria-label={label} value={body} onChange={(e) => (setBody(e.target.value), setPosted(false))} rows={4} placeholder="Markdown: **bold**, _italic_, `code`, links, lists, > quotes. No HTML, images are shown as links." autoFocus={autoFocus} />
      )}
      <div className="composer-foot">
        <p className={`small ${over ? 'error' : 'muted'}`} data-testid="composer-meta">
          {formatInt(bytes)} / {formatInt(COMMENT_MAX_BYTES)} bytes · costs about <b>{formatCredits(cost, true)}</b> · needs about <b>{formatCredits(required, true)}</b> available · your balance {balance === null ? '…' : formatCredits(balance)}
        </p>
        <div className="form-actions">
          {onCancel && (
            <button type="button" className="btn btn-quiet" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy || blank || over || poor}>
            {busy ? 'Signing and broadcasting…' : label}
          </button>
        </div>
      </div>
      {poor && balance !== null && <LowBalance what="this comment" balance={balance} fee={cost} />}
      <WriteError error={error} needsTopUp={needsTopUp} />
      {posted && !busy && !error && (
        <p className="notice small" role="status" data-testid="composer-posted">
          Posted. It is on Platform and in the discussion; there is no need to post it again.
        </p>
      )}
    </form>
  );
}
