import {
  SUPPORTED_MOODLE_FUNCTIONS,
  type MoodleCallOptions,
  type MoodleClient,
  type NormalizedMoodleBaseUrl,
} from '@ehub/moodle-client';

export type PingWarning =
  /** The service lacks a function the application calls: later phases will fail. */
  | 'missing_functions'
  /** The service exposes functions the application never calls (not least privilege). */
  | 'unexpected_functions'
  /** "Can download files" is off for the service: no course files can be fetched. */
  | 'file_downloads_disabled'
  /** Moodle's own site URL differs from MOODLE_BASE_URL (proxy or misconfiguration). */
  | 'site_url_mismatch';

export interface PingReport {
  /** `ok`: usable. `incomplete`: connected, but the service is missing something required. */
  readonly status: 'ok' | 'incomplete';
  readonly site: {
    readonly name: string;
    readonly url: string;
    readonly release: string | undefined;
    readonly version: string | undefined;
  };
  readonly serviceAccount: { readonly username: string; readonly userId: number };
  readonly downloadFilesEnabled: boolean | undefined;
  readonly functions: {
    readonly expected: readonly string[];
    readonly missing: readonly string[];
    readonly unexpected: readonly string[];
  };
  readonly warnings: readonly PingWarning[];
}

function sameSite(siteUrl: string, baseUrl: NormalizedMoodleBaseUrl): boolean {
  try {
    const parsed = new URL(siteUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    return parsed.host.toLowerCase() === baseUrl.host && path === baseUrl.pathPrefix;
  } catch {
    return false;
  }
}

/** Calls core_webservice_get_site_info and checks the service matches what the app needs. */
export async function pingMoodle(
  client: MoodleClient,
  baseUrl: NormalizedMoodleBaseUrl,
  options: MoodleCallOptions = {},
): Promise<PingReport> {
  const info = await client.getSiteInfo(options);
  const available = new Set(info.functions.map((fn) => fn.name));
  const expected: readonly string[] = SUPPORTED_MOODLE_FUNCTIONS;
  const missing = expected.filter((name) => !available.has(name));
  const unexpected = [...available].filter((name) => !expected.includes(name)).sort();
  const downloadFilesEnabled =
    info.downloadfiles === undefined ? undefined : info.downloadfiles === 1;

  const warnings: PingWarning[] = [];
  if (missing.length > 0) {
    warnings.push('missing_functions');
  }
  if (unexpected.length > 0) {
    warnings.push('unexpected_functions');
  }
  if (downloadFilesEnabled === false) {
    warnings.push('file_downloads_disabled');
  }
  if (!sameSite(info.siteurl, baseUrl)) {
    warnings.push('site_url_mismatch');
  }

  return {
    status: missing.length > 0 || downloadFilesEnabled === false ? 'incomplete' : 'ok',
    site: { name: info.sitename, url: info.siteurl, release: info.release, version: info.version },
    serviceAccount: { username: info.username, userId: info.userid },
    downloadFilesEnabled,
    functions: { expected, missing, unexpected },
    warnings,
  };
}
