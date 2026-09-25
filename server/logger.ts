import { pino, type Logger } from 'pino';
import type { Env } from './env';

export type { Logger };

/**
 * Structured JSON logs (pino) on stdout. `npm run dev:server` pipes them through pino-pretty;
 * production keeps JSON for journald. (An in-process pino-pretty transport deadlocks on Windows
 * when stdout is a pipe, so pretty-printing stays outside the process.)
 * Secrets that could appear in logged objects are redacted.
 */
export function createLogger(env: Pick<Env, 'logLevel'>): Logger {
  return pino({
    level: env.logLevel,
    redact: {
      paths: [
        'authorization',
        'cookie',
        'password',
        'token',
        '*.authorization',
        '*.cookie',
        '*.password',
        '*.token',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[redacted]',
    },
  });
}
