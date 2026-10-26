import { getCorrelationId } from '../correlation/correlation.js';
import { redact, redactString } from './redaction.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_LEVEL_SETTINGS = [...LOG_LEVELS, 'silent'] as const;
export type LogLevelSetting = (typeof LOG_LEVEL_SETTINGS)[number];

const LEVEL_VALUES: Readonly<Record<LogLevelSetting, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  isLevelEnabled(level: LogLevel): boolean;
  /** Returns a logger that adds `bindings` to every record. */
  child(bindings: LogFields): Logger;
}

export interface LogSink {
  write(line: string): void;
}

export const stdoutSink: LogSink = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

/** CLI commands keep stdout for machine-readable results and log to stderr. */
export const stderrSink: LogSink = {
  write: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export interface LoggerOptions {
  readonly service: string;
  readonly level?: LogLevelSetting;
  readonly bindings?: LogFields;
  readonly sink?: LogSink;
  readonly clock?: () => Date;
}

// Fields that callers and bindings cannot overwrite, so a record's level, time, origin and
// correlation can always be trusted.
const RESERVED_FIELDS = ['time', 'level', 'service', 'correlationId', 'msg'] as const;

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  return new StructuredLogger(
    options.service,
    LEVEL_VALUES[level],
    options.bindings ?? {},
    options.sink ?? stdoutSink,
    options.clock ?? (() => new Date()),
  );
}

class StructuredLogger implements Logger {
  constructor(
    private readonly service: string,
    private readonly threshold: number,
    private readonly bindings: LogFields,
    private readonly sink: LogSink,
    private readonly clock: () => Date,
  ) {}

  trace(message: string, fields?: LogFields): void {
    this.write('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.write('fatal', message, fields);
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_VALUES[level] >= this.threshold;
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger(
      this.service,
      this.threshold,
      { ...this.bindings, ...bindings },
      this.sink,
      this.clock,
    );
  }

  private write(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const merged: Record<string, unknown> = { ...this.bindings, ...fields };
    for (const reserved of RESERVED_FIELDS) {
      Reflect.deleteProperty(merged, reserved);
    }

    const correlationId = getCorrelationId();
    const record: Record<string, unknown> = {
      time: this.clock().toISOString(),
      level,
      service: this.service,
      ...(correlationId === undefined ? {} : { correlationId }),
      msg: redactString(message),
      ...(redact(merged) as Record<string, unknown>),
    };

    this.sink.write(safeStringify(record));
  }
}

function safeStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // redact() already produces JSON-safe output; this guards against exotic toJSON() throws.
    return JSON.stringify({
      time: record['time'],
      level: record['level'],
      service: record['service'],
      msg: 'Log record could not be serialised.',
    });
  }
}

export function isLogLevelSetting(value: string): value is LogLevelSetting {
  return (LOG_LEVEL_SETTINGS as readonly string[]).includes(value);
}
