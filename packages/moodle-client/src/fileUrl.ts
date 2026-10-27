import type { NormalizedMoodleBaseUrl } from './baseUrl.js';
import { MoodleValidationError } from './errors.js';

const CREDENTIAL_PARAMETERS = ['token', 'wstoken'];

function invalidUrl(message: string): MoodleValidationError {
  return new MoodleValidationError(`Rejected Moodle file URL: ${message}`, {
    code: 'invalid_file_url',
  });
}

/** Returns a copy of `url` without token query parameters. */
export function stripCredentialParameters(url: URL): URL {
  const copy = new URL(url.href);
  for (const name of CREDENTIAL_PARAMETERS) {
    copy.searchParams.delete(name);
  }
  return copy;
}

/**
 * Validates that `fileUrl` is a pluginfile URL on the configured Moodle site and returns it
 * without credential parameters or fragment. This is the single rule for which URLs the
 * downloader will fetch; discovery uses it too, so "downloadable" means the same everywhere.
 */
export function toMoodleFileSourceUrl(baseUrl: NormalizedMoodleBaseUrl, fileUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw invalidUrl('not an absolute URL.');
  }
  if (parsed.protocol !== baseUrl.protocol) {
    throw invalidUrl('protocol does not match the Moodle site.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw invalidUrl('URL must not contain credentials.');
  }
  if (parsed.host.toLowerCase() !== baseUrl.host) {
    throw invalidUrl('host is not the configured Moodle site.');
  }
  if (/%2f|%5c/i.test(parsed.pathname) || parsed.pathname.includes('\\')) {
    throw invalidUrl('encoded path separators are not allowed.');
  }
  const allowedPrefixes = [
    `${baseUrl.pathPrefix}/webservice/pluginfile.php/`,
    `${baseUrl.pathPrefix}/pluginfile.php/`,
  ];
  if (!allowedPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    throw invalidUrl('only Moodle pluginfile URLs can be downloaded.');
  }
  parsed.hash = '';
  return stripCredentialParameters(parsed);
}
