import { describe, expect, it } from 'vitest';

import { normalizeMoodleBaseUrl } from './baseUrl.js';
import { MoodleValidationError } from './errors.js';

const https = { allowHttp: false };

describe('normalizeMoodleBaseUrl', () => {
  it.each([
    ['https://ehub.example.test', 'https://ehub.example.test', ''],
    ['https://ehub.example.test/', 'https://ehub.example.test', ''],
    ['  https://EHUB.Example.TEST//  ', 'https://ehub.example.test', ''],
    ['https://ehub.example.test/moodle/', 'https://ehub.example.test/moodle', '/moodle'],
    ['https://ehub.example.test//moodle//', 'https://ehub.example.test/moodle', '/moodle'],
    ['https://ehub.example.test:8443/lms', 'https://ehub.example.test:8443/lms', '/lms'],
    [
      'https://ehub.example.test/moodle/webservice/rest/server.php',
      'https://ehub.example.test/moodle',
      '/moodle',
    ],
    ['https://ehub.example.test/login/index.php', 'https://ehub.example.test', ''],
    ['https://ehub.example.test/a/../moodle', 'https://ehub.example.test/moodle', '/moodle'],
  ])('normalises %s', (input, href, pathPrefix) => {
    const result = normalizeMoodleBaseUrl(input, https);
    expect(result.href).toBe(href);
    expect(result.pathPrefix).toBe(pathPrefix);
    expect(result.restEndpoint).toBe(`${href}/webservice/rest/server.php`);
  });

  it('exposes host and protocol for allowlist checks', () => {
    const result = normalizeMoodleBaseUrl('https://EHub.Example.test:8443/x', https);
    expect(result.host).toBe('ehub.example.test:8443');
    expect(result.protocol).toBe('https:');
    expect(result.origin).toBe('https://ehub.example.test:8443');
  });

  it.each([
    ['not a url'],
    ['ftp://ehub.example.test'],
    ['javascript:alert(1)'],
    ['https://user:pass@ehub.example.test'],
    ['https://ehub.example.test/?wstoken=abc'],
    ['https://ehub.example.test/#x'],
    ['https://ehub.example.test/a%2Fb'],
    ['https://ehub.example.test/a%5cb'],
  ])('rejects %s', (input) => {
    expect(() => normalizeMoodleBaseUrl(input, https)).toThrow(MoodleValidationError);
  });

  it('allows http only when explicitly permitted', () => {
    expect(() => normalizeMoodleBaseUrl('http://localhost:8080', https)).toThrow(
      /https is required/,
    );
    expect(normalizeMoodleBaseUrl('http://localhost:8080', { allowHttp: true }).href).toBe(
      'http://localhost:8080',
    );
  });

  it('never echoes a rejected URL, which may carry a token', () => {
    try {
      normalizeMoodleBaseUrl('https://ehub.example.test/?wstoken=supersecretvalue', https);
    } catch (error) {
      expect(String(error)).not.toContain('supersecretvalue');
      return;
    }
    throw new Error('expected rejection');
  });
});
