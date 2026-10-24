// JSON-lines logger on stderr. Never pass IP addresses, outpoints, vote hashes, signatures or RPC credentials in `fields`:
// the relay keeps minimal logs on purpose (README "Privacy").
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER[(process.env.RELAY_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  process.stderr.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
  setLevel(level: Level): void {
    threshold = ORDER[level];
  },
};

/** Whole unix seconds. Every time in the relay (DB, API, broadcaster) is an integer number of seconds. */
export type Clock = () => number;
export const nowS: Clock = () => Math.floor(Date.now() / 1000);

export function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown };
    return o.message !== undefined ? String(o.message) : String(e);
  }
  return String(e);
}
