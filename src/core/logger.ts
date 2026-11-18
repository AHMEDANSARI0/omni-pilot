import { redact, safeErrorMessage } from './errors';
import type { Database, NewLogEntry } from './ports';
import type { LogLevel } from './types';

export interface Logger {
  debug(event: string, message?: string, context?: Record<string, unknown>): Promise<void>;
  info(event: string, message?: string, context?: Record<string, unknown>): Promise<void>;
  warn(event: string, message?: string, context?: Record<string, unknown>): Promise<void>;
  error(event: string, message?: string, context?: Record<string, unknown>): Promise<void>;
  withContext(context: Record<string, unknown>): Logger;
}

export type LogFn = (
  level: LogLevel,
  event: string,
  message?: string,
  context?: Record<string, unknown>,
) => Promise<void>;

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (/token|secret|key|password|authorization/i.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = typeof value === 'string' ? redact(value).slice(0, 2000) : value;
  }
  return output;
}

/**
 * Persistent logger. Database write failures never bubble up: logging must not break the
 * pipeline, and the console mirror keeps the information available in `wrangler tail`.
 */
export function createLogger(
  db: Database,
  options: { runId?: string | null; actor?: string; extra?: Record<string, unknown> } = {},
): Logger {
  const actor = options.actor ?? 'system';
  const baseContext = options.extra ?? {};

  const write: LogFn = async (level, event, message, context) => {
    const payload: NewLogEntry = {
      level,
      event,
      message: message ? redact(message).slice(0, 4000) : null,
      context: sanitizeContext({ ...baseContext, ...context }),
      actor,
      runId: options.runId ?? null,
    };
    const line = `[${level}] ${event}${message ? `: ${payload.message}` : ''}`;
    if (level === 'error') console.error(line, payload.context);
    else if (level === 'warn') console.warn(line, payload.context);
    else console.log(line);
    try {
      await db.insertLog(payload);
    } catch (error) {
      console.warn(`[warn] log.persist.failed: ${safeErrorMessage(error)}`);
    }
  };

  return {
    debug: (event, message, context) => write('debug', event, message, context),
    info: (event, message, context) => write('info', event, message, context),
    warn: (event, message, context) => write('warn', event, message, context),
    error: (event, message, context) => write('error', event, message, context),
    withContext: (context) =>
      createLogger(db, { runId: options.runId, actor, extra: { ...baseContext, ...context } }),
  };
}
