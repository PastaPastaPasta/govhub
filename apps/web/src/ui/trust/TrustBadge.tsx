// The trust badge: a shield whose mark says the level, and the level's word. `size="s"` is the icon alone (cards), still named.
import type { TrustLevel } from '../../verify/aggregate.ts';
import { LEVEL_LABEL } from '../../verify/aggregate.ts';

export function ShieldIcon({ level, size = 18 }: { level: TrustLevel; size?: number }) {
  const outline = 'M12 2.5 4 5.6v6.1c0 4.7 3.3 8.6 8 9.8 4.7-1.2 8-5.1 8-9.8V5.6Z';
  return (
    <svg className={`shield shield-${level}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {level === 'partial' && <path d="M12 2.5 4 5.6v6.1c0 4.7 3.3 8.6 8 9.8Z" className="shield-half" />}
      <path d={outline} className="shield-outline" />
      {level === 'verified' && <path d="m8.2 12.2 2.6 2.6 5-5.4" className="shield-mark" />}
      {level === 'error' && <path d="M12 7.6v5.2M12 16.2v.3" className="shield-mark" />}
      {level === 'failed' && <path d="m9.2 9.2 5.6 5.6m0-5.6-5.6 5.6" className="shield-mark" />}
      {level === 'checking' && <path d="M12 7a5 5 0 0 1 5 5" className="shield-arc" />}
      {level === 'demo' && <path d="M10.2 7.4h3.6M10.9 7.4v3.3l-2.6 4.4a.9.9 0 0 0 .8 1.4h5.8a.9.9 0 0 0 .8-1.4l-2.6-4.4V7.4" className="shield-mark shield-thin" />}
    </svg>
  );
}

export function TrustBadge({ level, reason, onOpen, size = 'm', testId = 'trust-badge' }: { level: TrustLevel; reason: string | null; onOpen?: () => void; size?: 's' | 'm'; testId?: string }) {
  const label = LEVEL_LABEL[level];
  const name = `${label}${reason ? `: ${reason}` : ''}. How do we know?`;
  const body = (
    <>
      <ShieldIcon level={level} size={size === 's' ? 16 : 18} />
      {size === 'm' && <span className="trust-word">{label}</span>}
    </>
  );
  if (!onOpen) {
    return (
      <span className={`trust trust-${level} trust-${size}`} data-testid={testId} data-trust={level} role="img" aria-label={`${label}${reason ? `: ${reason}` : ''}`} title={reason ?? label}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className={`trust trust-${level} trust-${size}`} onClick={onOpen} data-testid={testId} data-trust={level} aria-label={name} title={reason ?? undefined} aria-haspopup="dialog">
      {body}
    </button>
  );
}
