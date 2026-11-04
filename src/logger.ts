/**
 * Minimal JSON-lines logger. Log order_id, never full GPS trails or token values.
 */
type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...meta });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (scope: string, msg: string, meta?: Record<string, unknown>) =>
    process.env.LOG_LEVEL === "debug" && write("debug", scope, msg, meta),
  info: (scope: string, msg: string, meta?: Record<string, unknown>) => write("info", scope, msg, meta),
  warn: (scope: string, msg: string, meta?: Record<string, unknown>) => write("warn", scope, msg, meta),
  error: (scope: string, msg: string, meta?: Record<string, unknown>) => write("error", scope, msg, meta),
};
