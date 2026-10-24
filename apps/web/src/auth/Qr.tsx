// QR code as an SVG path (no inline styles or data URLs, so the strict CSP stays as it is).
import { encodeQR } from 'qr';
import { useMemo } from 'react';

export function Qr({ text, label }: { text: string; label: string }) {
  const { d, size } = useMemo(() => {
    const m = encodeQR(text, 'raw', { ecc: 'medium', border: 2 });
    let path = '';
    m.forEach((row, y) => row.forEach((on, x) => on && (path += `M${x} ${y}h1v1h-1z`)));
    return { d: path, size: m.length };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} className="qr-bg" />
      <path d={d} className="qr-fg" />
    </svg>
  );
}
