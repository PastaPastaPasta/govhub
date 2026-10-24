// JSON-lines logger on stderr (plus the tiny errText / nowS helpers). Never pass key material or RPC credentials in `fields`.
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER[(process.env.BRIDGE_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

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

/** Current unix time in whole seconds. */
export const nowS = (): number => Math.floor(Date.now() / 1000);

/** Message text of anything thrown, including evo-sdk's WasmSdkError (not an Error subclass). */
export function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown };
    const m = o.message !== undefined ? String(o.message) : String(e);
    return o.code !== undefined && o.code !== -1 ? `${m} [code ${String(o.code)}]` : m;
  }
  return String(e);
}
