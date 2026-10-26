import { MoodleValidationError } from './errors.js';

export interface NormalizedMoodleBaseUrl {
  /** Scheme, host and optional port, e.g. `https://ehub.example.test`. */
  readonly origin: string;
  /** Lower-case `host[:port]`, used for allowlist comparisons. */
  readonly host: string;
  readonly protocol: 'http:' | 'https:';
  /** Sub-directory Moodle is installed under, without a trailing slash (`''` at the root). */
  readonly pathPrefix: string;
  /** Normalised base, e.g. `https://ehub.example.test/moodle`. */
  readonly href: string;
  /** `<base>/webservice/rest/server.php`. */
  readonly restEndpoint: string;
}

// Administrators often paste a page URL instead of the site root; these suffixes are removed.
const STRIPPABLE_SUFFIXES = ['/webservice/rest/server.php', '/login/index.php', '/index.php'];

function invalid(message: string): MoodleValidationError {
  return new MoodleValidationError(`Invalid Moodle base URL: ${message}`, {
    code: 'invalid_base_url',
  });
}

/**
 * Parses and normalises the configured Moodle base URL. Rejects credentials, query strings,
 * fragments, encoded path separators and (unless `allowHttp`) plain http.
 */
export function normalizeMoodleBaseUrl(
  raw: string,
  options: { readonly allowHttp: boolean },
): NormalizedMoodleBaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw invalid('not an absolute URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalid('protocol must be http or https.');
  }
  if (parsed.protocol === 'http:' && !options.allowHttp) {
    throw invalid('https is required.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalid('must not contain credentials.');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw invalid('must not contain a query string or fragment.');
  }
  if (/%2f|%5c/i.test(parsed.pathname) || parsed.pathname.includes('\\')) {
    throw invalid('must not contain encoded or backslash path separators.');
  }

  let path = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  for (const suffix of STRIPPABLE_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      break;
    }
  }

  const origin = parsed.origin;
  const href = `${origin}${path}`;
  return {
    origin,
    host: parsed.host.toLowerCase(),
    protocol: parsed.protocol,
    pathPrefix: path,
    href,
    restEndpoint: `${href}/webservice/rest/server.php`,
  };
}
