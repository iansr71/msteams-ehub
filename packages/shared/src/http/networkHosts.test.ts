import { describe, expect, it } from 'vitest';

import { isLocalNetworkHost } from './networkHosts.js';

/** As a caller sees it: the WHATWG URL parser normalises the host first. */
const hostOf = (url: string) => new URL(url).hostname;

describe('isLocalNetworkHost', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.8.9.10/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/', // octal
    'http://127.1/',
    'http://0.0.0.0/',
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://localhost/',
    'http://LOCALHOST./',
    'http://app.localhost/',
    'http://metadata.google.internal/',
    'http://metadata/',
  ])('refuses %s', (url) => {
    expect(isLocalNetworkHost(hostOf(url))).toBe(true);
  });

  it.each([
    'https://ehub.example.com/',
    'https://10.1.2.3/', // internal Moodle servers are legitimate
    'https://192.168.1.20/',
    'https://172.16.0.5/',
    'https://128.0.0.1/',
    'https://169.253.1.1/',
    'https://[2001:db8::1]/',
    'https://[fec0::1]/',
    'https://localhost.example.com/',
    'https://notlocalhost/',
  ])('allows %s', (url) => {
    expect(isLocalNetworkHost(hostOf(url))).toBe(false);
  });

  // Callers that pass a host string without going through URL (configuration, redirect host
  // lists) can supply IPv4-mapped addresses in dotted form, which URL would have rewritten.
  it.each(['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1', '[::ffff:127.0.0.1]'])(
    'refuses the raw host %s',
    (host) => {
      expect(isLocalNetworkHost(host)).toBe(true);
    },
  );

  it('allows a raw IPv4-mapped public address', () => {
    expect(isLocalNetworkHost('::ffff:8.8.8.8')).toBe(false);
  });
});
