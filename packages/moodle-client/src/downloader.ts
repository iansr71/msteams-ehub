import { createLogger, registerSecretValue, type Logger } from '@ehub/shared';

import type { NormalizedMoodleBaseUrl } from './baseUrl.js';
import {
  MoodleApiError,
  MoodleAuthenticationError,
  MoodleTransportError,
  MoodleValidationError,
  isMoodleError,
  type MoodleError,
} from './errors.js';
import { stripCredentialParameters, toMoodleFileSourceUrl } from './fileUrl.js';
import {
  createRequestSignals,
  errorFromHttpStatus,
  errorFromNetworkFailure,
  moodleExceptionFromBody,
  readBodyWithLimit,
  type ErrorContext,
  type FetchFn,
} from './http.js';
import {
  DEFAULT_RETRY_POLICY,
  defaultSleep,
  parseRetryAfter,
  runWithRetries,
  type RandomSource,
  type RetryPolicy,
  type Sleep,
} from './retry.js';

export interface MoodleDownloadOptions {
  /** Lower the configured size limit for this download (it can never be raised). */
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface MoodleDownloadedFile {
  /** The Moodle file URL as supplied, with any credential parameters removed. */
  readonly sourceUrl: string;
  /** The URL the content was finally served from (after approved redirects), credential-free. */
  readonly finalUrl: string;
  readonly redirectCount: number;
  /** Server-declared Content-Type. Untrusted: extraction must detect the real type. */
  readonly contentType: string | undefined;
  readonly lastModified: string | undefined;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export interface MoodleFileDownloader {
  download(fileUrl: string, options?: MoodleDownloadOptions): Promise<MoodleDownloadedFile>;
}

export interface HttpMoodleFileDownloaderOptions {
  readonly baseUrl: NormalizedMoodleBaseUrl;
  readonly token: string;
  readonly downloadTimeoutMs: number;
  readonly maxDownloadBytes: number;
  /**
   * Extra hosts (`host[:port]`, lower case) that downloads may be redirected to, e.g. a
   * storage host Moodle offloads files to. The Moodle host itself is always allowed.
   */
  readonly additionalRedirectHosts?: readonly string[];
  readonly maxRedirects?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly fetch?: FetchFn;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly userAgent?: string;
}

const DEFAULT_MAX_REDIRECTS = 3;
/** A JSON body smaller than this is checked for a Moodle exception (bad token, no access). */
const EXCEPTION_PROBE_BYTES = 64 * 1024;
const silentLogger = createLogger({ service: 'moodle-client', level: 'silent' });

/**
 * Downloads files served by Moodle's pluginfile endpoints.
 *
 * - Only URLs on the configured Moodle host, under `pluginfile.php` or
 *   `webservice/pluginfile.php`, are accepted, so this cannot be used to fetch arbitrary URLs.
 * - The token is added only to the request sent to the Moodle host. It is never stored on the
 *   result, never forwarded across a redirect, and never included in errors or logs.
 * - Redirects are followed manually and only to approved hosts.
 * - Size and time limits apply to the whole download, including redirects.
 */
export class HttpMoodleFileDownloader implements MoodleFileDownloader {
  readonly #token: string;
  readonly #options: HttpMoodleFileDownloaderOptions;
  readonly #fetch: FetchFn;
  readonly #logger: Logger;
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(options: HttpMoodleFileDownloaderOptions) {
    if (options.token.trim() === '') {
      throw new MoodleValidationError('A Moodle token is required.', { code: 'missing_token' });
    }
    this.#token = options.token;
    registerSecretValue(options.token);
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = (options.logger ?? silentLogger).child({ component: 'moodle-downloader' });
    this.#allowedHosts = new Set([
      options.baseUrl.host,
      ...(options.additionalRedirectHosts ?? []).map((host) => host.toLowerCase()),
    ]);
  }

  /**
   * Validates a Moodle file URL and returns it without credential parameters. Exposed so
   * callers can store the canonical source URL without downloading.
   */
  toSourceUrl(fileUrl: string): URL {
    return toMoodleFileSourceUrl(this.#options.baseUrl, fileUrl);
  }

  async download(
    fileUrl: string,
    options: MoodleDownloadOptions = {},
  ): Promise<MoodleDownloadedFile> {
    const sourceUrl = this.toSourceUrl(fileUrl);
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    ) {
      throw new MoodleValidationError('maxBytes must be a positive integer.', {
        code: 'invalid_request',
      });
    }
    const maxBytes = Math.min(
      options.maxBytes ?? this.#options.maxDownloadBytes,
      this.#options.maxDownloadBytes,
    );
    const started = Date.now();

    const file = await runWithRetries(() => this.#attempt(sourceUrl, maxBytes, options.signal), {
      policy: this.#options.retryPolicy ?? DEFAULT_RETRY_POLICY,
      sleep: this.#options.sleep ?? defaultSleep,
      random: this.#options.random ?? Math.random,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      normalizeError: (error) =>
        isMoodleError(error)
          ? error
          : new MoodleApiError('Unexpected failure while downloading a Moodle file.', {
              code: 'unexpected_error',
            }),
      cancelledError: () =>
        new MoodleTransportError('File download was cancelled.', { code: 'aborted' }),
      onFailure: ({ error, attempt, durationMs, willRetry }) => {
        this.#logger.warn('Moodle file download failed.', {
          sourceUrl: sourceUrl.href,
          attempt: attempt + 1,
          durationMs,
          category: error.category,
          code: error.code,
          httpStatus: error.httpStatus,
          willRetry,
        });
      },
    });

    this.#logger.debug('Moodle file downloaded.', {
      sourceUrl: file.sourceUrl,
      byteLength: file.byteLength,
      redirectCount: file.redirectCount,
      durationMs: Date.now() - started,
    });
    return file;
  }

  /** Builds the authenticated URL. Lives only for the duration of one request. */
  #authenticatedUrl(sourceUrl: URL): string {
    const url = new URL(sourceUrl.href);
    const base = this.#options.baseUrl;
    const plainPrefix = `${base.pathPrefix}/pluginfile.php/`;
    if (url.pathname.startsWith(plainPrefix)) {
      // Token authentication is only honoured by the web-service variant of pluginfile.
      url.pathname = `${base.pathPrefix}/webservice/pluginfile.php/${url.pathname.slice(plainPrefix.length)}`;
    }
    url.searchParams.set('token', this.#token);
    return url.href;
  }

  #validateRedirect(location: string | null, current: URL): URL {
    if (location === null || location.trim() === '') {
      throw new MoodleTransportError('File download redirect had no location.', {
        code: 'invalid_redirect',
      });
    }
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new MoodleTransportError('File download redirect location was invalid.', {
        code: 'invalid_redirect',
      });
    }
    const base = this.#options.baseUrl;
    const httpAllowed = base.protocol === 'http:' && target.host.toLowerCase() === base.host;
    if (target.protocol !== 'https:' && !httpAllowed) {
      throw new MoodleTransportError('File download was redirected to an insecure URL.', {
        code: 'unsafe_redirect',
      });
    }
    if (target.username !== '' || target.password !== '') {
      throw new MoodleTransportError('File download redirect contained credentials.', {
        code: 'unsafe_redirect',
      });
    }
    if (!this.#allowedHosts.has(target.host.toLowerCase())) {
      throw new MoodleTransportError('File download was redirected to an unapproved host.', {
        code: 'unsafe_redirect',
      });
    }
    if (
      target.host.toLowerCase() === base.host &&
      target.pathname.startsWith(`${base.pathPrefix}/login/`)
    ) {
      throw new MoodleAuthenticationError(
        'Moodle redirected the download to its login page; the token was not accepted.',
        { code: 'login_redirect' },
      );
    }
    return stripCredentialParameters(target);
  }

  async #attempt(
    sourceUrl: URL,
    maxBytes: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<MoodleDownloadedFile> {
    const context: ErrorContext = { operation: 'download' };
    const signals = createRequestSignals(this.#options.downloadTimeoutMs, callerSignal);
    const maxRedirects = this.#options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    let current = sourceUrl;
    // Only the first request carries the token; redirect targets never receive it.
    let requestUrl = this.#authenticatedUrl(sourceUrl);

    try {
      for (let redirects = 0; ; redirects += 1) {
        const response = await this.#fetch(requestUrl, {
          method: 'GET',
          headers: {
            accept: '*/*',
            'user-agent': this.#options.userAgent ?? 'ehub-teams-assistant',
          },
          redirect: 'manual',
          signal: signals.signal,
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) {
            throw new MoodleTransportError('File download exceeded the redirect limit.', {
              code: 'too_many_redirects',
            });
          }
          current = this.#validateRedirect(response.headers.get('location'), current);
          requestUrl = current.href;
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel();
          throw errorFromHttpStatus(
            response.status,
            context,
            parseRetryAfter(response.headers.get('retry-after')),
          );
        }

        const bytes = await readBodyWithLimit(
          response,
          maxBytes,
          () =>
            new MoodleValidationError('File exceeds the maximum download size.', {
              code: 'file_too_large',
            }),
        );
        const contentType = response.headers.get('content-type') ?? undefined;
        this.#throwIfMoodleException(bytes, contentType, context);

        return {
          sourceUrl: sourceUrl.href,
          finalUrl: current.href,
          redirectCount: redirects,
          contentType,
          lastModified: response.headers.get('last-modified') ?? undefined,
          byteLength: bytes.byteLength,
          bytes,
        };
      }
    } catch (error) {
      if (isMoodleError(error)) {
        throw error;
      }
      throw errorFromNetworkFailure(error, context, signals);
    }
  }

  /** webservice/pluginfile.php reports a bad token or missing access as a small JSON body. */
  #throwIfMoodleException(
    bytes: Uint8Array,
    contentType: string | undefined,
    context: ErrorContext,
  ): void {
    if (
      contentType?.toLowerCase().includes('json') !== true ||
      bytes.byteLength > EXCEPTION_PROBE_BYTES
    ) {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return;
    }
    const exception: MoodleError | undefined = moodleExceptionFromBody(decoded, context, [
      this.#token,
    ]);
    if (exception !== undefined) {
      throw exception;
    }
  }
}
