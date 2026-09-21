import pino from 'pino';

import { redactPaths } from './redact';

export type Logger = pino.Logger;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerConfig {
  /** Service name attached to every record, e.g. `web` or `bot`. */
  readonly service: string;
  readonly level: LogLevel;
  /** Pretty-print for a human terminal. Never enable in production. */
  readonly pretty: boolean;
}

/**
 * Build the root logger for a process.
 *
 * Child loggers (`logger.child({ requestId })`) are the intended way to add
 * context; creating a second root would fragment the redaction config and let
 * a secret slip through the gap.
 */
export function createLogger({ service, level, pretty }: LoggerConfig): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    redact: { paths: [...redactPaths], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (!pretty) return pino(options);

  return pino(
    options,
    pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    }),
  );
}

/**
 * A logger that discards everything. Used by tests, and by library code that
 * must accept a logger but has no sensible default of its own.
 */
export const silentLogger: Logger = pino({ level: 'silent' });
