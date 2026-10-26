import { afterEach, describe, expect, it } from 'vitest';

import {
  REDACTED,
  clearRegisteredSecretValues,
  isSensitiveKey,
  redact,
  redactString,
  registerSecretValue,
} from './redaction.js';

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'token',
    'accessToken',
    'refreshToken',
    'clientSecret',
    'apiKey',
    'MOODLE_TOKEN',
    'moodle-token',
    'wstoken',
    'x-api-key',
    'AZURE_CLIENT_SECRET',
    'proxy-authorization',
    'password',
    'APPLICATIONINSIGHTS_CONNECTION_STRING',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['tokenCount', 'maxTokens', 'courseId', 'resourceName', 'contentHash', 'status'])(
    'leaves %s visible',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redact', () => {
  it('masks every required sensitive key at any depth', () => {
    const input = {
      authorization: 'Bearer abc',
      cookie: 'session=1',
      token: 't',
      accessToken: 'a',
      refreshToken: 'r',
      clientSecret: 's',
      apiKey: 'k',
      MOODLE_TOKEN: 'm',
      nested: { deeper: [{ headers: { Authorization: 'x' } }] },
      safe: 'visible',
    };

    expect(redact(input)).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      token: REDACTED,
      accessToken: REDACTED,
      refreshToken: REDACTED,
      clientSecret: REDACTED,
      apiKey: REDACTED,
      MOODLE_TOKEN: REDACTED,
      nested: { deeper: [{ headers: { Authorization: REDACTED } }] },
      safe: 'visible',
    });
  });

  it('masks objects and arrays under a sensitive key without inspecting them', () => {
    expect(redact({ token: { value: 'x', parts: ['a'] } })).toEqual({ token: REDACTED });
  });

  it('does not mutate the input', () => {
    const input = { apiKey: 'k', inner: { token: 't' } };
    redact(input);
    expect(input).toEqual({ apiKey: 'k', inner: { token: 't' } });
  });

  it('scrubs credentials from URL query strings', () => {
    const url =
      'https://ehub.example.test/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=abcdef0123456789';
    expect(redactString(url)).toBe(
      `https://ehub.example.test/webservice/pluginfile.php/1/a.pdf?forcedownload=1&token=${REDACTED}`,
    );
    expect(redactString('https://x.test/webservice/rest/server.php?wstoken=secret123&f=1')).toBe(
      `https://x.test/webservice/rest/server.php?wstoken=${REDACTED}&f=1`,
    );
  });

  it('scrubs URL objects', () => {
    expect(redact(new URL('https://x.test/a?wstoken=abc123'))).toBe(
      `https://x.test/a?wstoken=${REDACTED}`,
    );
  });

  it('scrubs bearer tokens and JWTs embedded in text', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
    expect(redactString(`header was Bearer ${jwt}`)).toBe(`header was Bearer ${REDACTED}`);
    expect(redactString(`raw ${jwt} end`)).toBe(`raw ${REDACTED} end`);
  });

  it('scrubs Application Insights instrumentation keys', () => {
    expect(
      redactString('InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=x'),
    ).toBe(`InstrumentationKey=${REDACTED};IngestionEndpoint=x`);
  });

  it('scrubs registered secret values wherever they appear', () => {
    const secret = 'fake-moodle-token-0123456789abcdef';
    registerSecretValue(secret);

    const output = JSON.stringify(
      redact({ message: `failed calling server with ${secret}`, list: [secret], [secret]: 1 }),
    );

    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED);
  });

  it('ignores very short registered values to avoid masking ordinary words', () => {
    registerSecretValue('abc');
    expect(redactString('abc')).toBe('abc');
  });

  it('serialises errors, including causes and custom properties, with redaction', () => {
    const secret = 'fake-client-secret-value-xyz';
    registerSecretValue(secret);
    const cause = new Error(`inner failure using ${secret}`);
    const error = Object.assign(new Error('outer failure ?token=leaky', { cause }), {
      code: 'E_TEST',
      apiKey: 'should-not-appear',
    });

    const output = redact({ err: error }) as { err: Record<string, unknown> };
    const serialised = JSON.stringify(output);

    expect(output.err['name']).toBe('Error');
    expect(output.err['code']).toBe('E_TEST');
    expect(output.err['apiKey']).toBe(REDACTED);
    expect(output.err['message']).toBe(`outer failure ?token=${REDACTED}`);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('leaky');
    expect(serialised).not.toContain('should-not-appear');
  });

  it('redacts fetch Headers by header name', () => {
    const headers = new Headers({ authorization: 'Bearer x', 'content-type': 'application/json' });
    expect(redact({ headers })).toEqual({
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
    });
  });

  it('summarises binary payloads instead of logging their bytes', () => {
    expect(redact({ body: new Uint8Array([1, 2, 3]) })).toEqual({ body: '[Binary 3 bytes]' });
    expect(redact({ body: Buffer.from('confidential document text') })).toEqual({
      body: '[Binary 26 bytes]',
    });
  });

  it('handles circular references, depth limits and non-JSON values', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    expect(redact(circular)).toEqual({ name: 'loop', self: '[Circular]' });

    expect(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: '[MaxDepth]' } });

    expect(redact({ big: 10n, nan: Number.NaN, fn: () => 1, when: new Date(0) })).toEqual({
      big: '10',
      nan: 'NaN',
      fn: '[Function]',
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  it('keeps shared (non-circular) references visible', () => {
    const shared = { id: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
  });
});
