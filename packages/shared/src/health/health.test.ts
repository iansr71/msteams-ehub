import { describe, expect, it } from 'vitest';

import { aggregateHealthStatus, checkConfigFeature, getRuntimeInfo } from './health.js';

describe('aggregateHealthStatus', () => {
  it('returns the worst status', () => {
    expect(aggregateHealthStatus([])).toBe('pass');
    expect(
      aggregateHealthStatus([
        { name: 'a', status: 'pass', detail: '' },
        { name: 'b', status: 'warn', detail: '' },
      ]),
    ).toBe('warn');
    expect(
      aggregateHealthStatus([
        { name: 'a', status: 'fail', detail: '' },
        { name: 'b', status: 'warn', detail: '' },
      ]),
    ).toBe('fail');
  });
});

describe('checkConfigFeature', () => {
  it('passes a valid feature', () => {
    expect(checkConfigFeature({ feature: 'runtime', requirement: 'required' }, {})).toEqual({
      name: 'configuration.runtime',
      status: 'pass',
      detail: 'Configured.',
    });
  });

  it('warns for a missing optional feature with its note', () => {
    const result = checkConfigFeature(
      { feature: 'moodle', requirement: 'optional', missingNote: 'Needed from phase 2.' },
      {},
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toBe('Needed from phase 2.');
    expect(result.items).toEqual(['MOODLE_BASE_URL: Required.', 'MOODLE_TOKEN: Required.']);
  });

  it('fails a missing required feature', () => {
    expect(checkConfigFeature({ feature: 'moodle', requirement: 'required' }, {}).status).toBe(
      'fail',
    );
  });

  it('fails a partially configured optional feature without revealing values', () => {
    const result = checkConfigFeature(
      { feature: 'moodle', requirement: 'optional' },
      { MOODLE_BASE_URL: 'https://ehub.example.test', MOODLE_TOKEN: 'too short' },
    );
    expect(result.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain('too short');
  });
});

describe('checkConfigFeature optional-only features', () => {
  it('says an absent optional-only feature is not configured rather than configured', () => {
    expect(
      checkConfigFeature({ feature: 'observability', requirement: 'optional' }, {}),
    ).toMatchObject({ status: 'pass', detail: 'Not configured (all variables optional).' });
  });
});

describe('getRuntimeInfo', () => {
  it('describes the current process', () => {
    const info = getRuntimeInfo();
    expect(info.nodeVersion).toBe(process.version);
    expect(info.pid).toBe(process.pid);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
