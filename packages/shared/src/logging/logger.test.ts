import { afterEach, describe, expect, it } from 'vitest';

import { runWithCorrelationId } from '../correlation/correlation.js';
import { createLogger, type LogSink } from './logger.js';
import { REDACTED, clearRegisteredSecretValues, registerSecretValue } from './redaction.js';

function memorySink(): LogSink & { records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  return {
    write: (line) => lines.push(line),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const fixedClock = (): Date => new Date('2026-01-01T00:00:00.000Z');

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('createLogger', () => {
  it('writes one JSON object per record with standard fields', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'test-service', sink, clock: fixedClock });

    logger.info('Hello.', { courseId: '42' });

    expect(sink.records()).toEqual([
      {
        time: '2026-01-01T00:00:00.000Z',
        level: 'info',
        service: 'test-service',
        msg: 'Hello.',
        courseId: '42',
      },
    ]);
  });

  it('filters records below the configured level', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 's', level: 'warn', sink });

    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    expect(sink.records().map((record) => record['level'])).toEqual(['warn', 'error']);
    expect(logger.isLevelEnabled('info')).toBe(false);
  });

  it('writes nothing when silent', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 's', level: 'silent', sink });
    logger.fatal('nothing');
    expect(sink.records()).toEqual([]);
  });

  it('adds the active correlation ID automatically', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 's', sink });

    runWithCorrelationId('corr-123', () => {
      logger.info('inside');
    });
    logger.info('outside');

    const [inside, outside] = sink.records();
    expect(inside?.['correlationId']).toBe('corr-123');
    expect(outside).not.toHaveProperty('correlationId');
  });

  it('redacts sensitive fields, bindings and message text automatically', () => {
    const sink = memorySink();
    const secret = 'fake-moodle-token-0123456789abcdef';
    registerSecretValue(secret);
    const logger = createLogger({ service: 's', sink }).child({ authorization: 'Bearer abc' });

    logger.error(`call failed for ?wstoken=${secret}`, {
      token: 'x',
      accessToken: 'x',
      refreshToken: 'x',
      clientSecret: 'x',
      apiKey: 'x',
      MOODLE_TOKEN: secret,
      cookie: 'x',
      request: { headers: { Authorization: 'Bearer abc' } },
    });

    const [record] = sink.records();
    const line = JSON.stringify(record);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('Bearer abc');
    expect(record).toMatchObject({
      authorization: REDACTED,
      token: REDACTED,
      accessToken: REDACTED,
      refreshToken: REDACTED,
      clientSecret: REDACTED,
      apiKey: REDACTED,
      MOODLE_TOKEN: REDACTED,
      cookie: REDACTED,
      request: { headers: { Authorization: REDACTED } },
    });
  });

  it('prevents fields from overriding reserved record properties', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'real', sink, clock: fixedClock });

    runWithCorrelationId('real-correlation', () => {
      logger.info('real message', {
        level: 'fatal',
        service: 'spoofed',
        msg: 'spoofed',
        time: 'spoofed',
        correlationId: 'spoofed',
      });
    });

    expect(sink.records()[0]).toEqual({
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      service: 'real',
      correlationId: 'real-correlation',
      msg: 'real message',
    });
  });

  it('merges child bindings, with call fields taking precedence', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 's', sink, bindings: { component: 'root' } })
      .child({ job: 'sync' })
      .child({ job: 'sync-course' });

    logger.info('m', { component: 'override' });

    expect(sink.records()[0]).toMatchObject({ component: 'override', job: 'sync-course' });
  });

  it('serialises errors passed as fields', () => {
    const sink = memorySink();
    const logger = createLogger({ service: 's', sink });

    logger.error('boom', { err: new TypeError('bad input') });

    expect(sink.records()[0]?.['err']).toMatchObject({ name: 'TypeError', message: 'bad input' });
  });

  it('keeps log injection inside a single JSON line', () => {
    const sink = memorySink();
    const lines: string[] = [];
    const logger = createLogger({
      service: 's',
      sink: {
        write: (line) => {
          lines.push(line);
          sink.write(line);
        },
      },
    });

    logger.info('first\n{"level":"fatal","msg":"forged"}');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
  });
});
