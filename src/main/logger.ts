import {appendFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

import type {LogLevel} from '../shared/ipc';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

/** Keys whose values must never reach disk; TRD §18.3 forbids logging diagram contents. */
const REDACTED_KEYS = new Set(['contents', 'data', 'body', 'payload']);

function redact(context: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    safe[key] = REDACTED_KEYS.has(key) ? '[redacted]' : value;
  }
  return safe;
}

/**
 * Append-only local file logger (TRD §21.1). There is no network transport and
 * no crash reporter: nothing leaves the machine (NFR-SEC-09, NFR-SEC-10).
 *
 * Writes are serialised through a promise chain so concurrent callers cannot
 * interleave partial lines.
 */
export class FileLogger {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly file: string,
    private readonly minimum: LogLevel
  ) {}

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(dirname(this.file), {recursive: true}).then(() => undefined);
    return this.ready;
  }

  write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minimum]) {
      return;
    }

    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(context ? {context: redact(context)} : {})
    };

    this.queue = this.queue
      .then(() => this.ensureDir())
      .then(() => appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch((cause: unknown) => {
        // A failing log sink must not take the app down, but it must not be
        // invisible either: fall back to the only other sink we have.
        console.error('[logger] failed to append record', {level, message, cause});
      });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  /** Resolves once every queued record has been flushed. */
  flush(): Promise<void> {
    return this.queue;
  }
}
