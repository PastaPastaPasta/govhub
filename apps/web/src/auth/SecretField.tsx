// A secret input (recovery phrase, voucher link): masked until "Show". Used by the sign-in sheet and the Recover tool.
import { useState, type ClipboardEvent } from 'react';

/** Masking a textarea needs -webkit-text-security; where it is missing a password input stands in while hidden. */
const TEXT_SECURITY = typeof CSS !== 'undefined' && !!CSS.supports?.('-webkit-text-security', 'disc');

/** A password input drops line breaks from a paste ("word\nword" becomes "wordword"): paste them as spaces instead. */
function pasteOneLine(set: (v: string) => void) {
  return (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const t = e.clipboardData.getData('text').replace(/\s+/g, ' ');
    set(el.value.slice(0, el.selectionStart ?? el.value.length) + t + el.value.slice(el.selectionEnd ?? el.value.length));
  };
}

/** A recovery phrase or voucher link: masked until "Show" (shoulder surfing, screen sharing, screenshots). */
export function SecretField(p: { label: string; what: string; value: string; onChange(v: string): void; testId: string; placeholder?: string; disabled?: boolean }) {
  const [shown, setShown] = useState(false);
  const common = {
    value: p.value, placeholder: p.placeholder, disabled: p.disabled, spellCheck: false, autoComplete: 'off', autoCapitalize: 'none', autoCorrect: 'off', 'data-testid': p.testId, 'data-masked': !shown,
  };
  return (
    <div className="secret-field">
      <label>
        {p.label}
        {shown || TEXT_SECURITY ? (
          <textarea rows={3} className={shown ? undefined : 'masked'} {...common} onChange={(e) => p.onChange(e.target.value)} />
        ) : (
          <input type="password" {...common} onChange={(e) => p.onChange(e.target.value)} onPaste={pasteOneLine(p.onChange)} />
        )}
      </label>
      <button type="button" className="btn btn-quiet" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${p.what}`} onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
