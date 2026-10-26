import { createLogger, registerSecretValue, type Logger } from '@ehub/shared';

import type { NormalizedMoodleBaseUrl } from './baseUrl.js';
import {
  MoodleApiError,
  MoodleTransportError,
  MoodleValidationError,
  isMoodleError,
  type MoodleError,
} from './errors.js';
import {
  createRequestSignals,
  errorFromHttpStatus,
  errorFromNetworkFailure,
  moodleExceptionFromBody,
  readBodyWithLimit,
  type ErrorContext,
  type FetchFn,
} from './http.js';
import { encodeMoodleParams, type MoodleParams } from './params.js';
import {
  DEFAULT_RETRY_POLICY,
  defaultSleep,
  parseRetryAfter,
  runWithRetries,
  type RandomSource,
  type RetryPolicy,
  type Sleep,
} from './retry.js';

export const SUPPORTED_MOODLE_FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_course_get_courses',
  'core_course_get_contents',
  'core_enrol_get_enrolled_users',
  'core_enrol_get_users_courses',
  'core_user_get_users_by_field',
] as const;
export type MoodleFunctionName = (typeof SUPPORTED_MOODLE_FUNCTIONS)[number];

export interface MoodleCallOptions {
  readonly signal?: AbortSignal;
}

/** Calls one Moodle web-service function and returns its decoded JSON result. */
export interface MoodleTransport {
  call(
    functionName: MoodleFunctionName,
    params: MoodleParams,
    options?: MoodleCallOptions,
  ): Promise<unknown>;
}

export interface HttpMoodleTransportOptions {
  readonly baseUrl: NormalizedMoodleBaseUrl;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly retryPolicy?: RetryPolicy;
  /** Upper bound on a single JSON response. Course contents for large courses run to MBs. */
  readonly maxResponseBytes?: number;
  readonly fetch?: FetchFn;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly userAgent?: string;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const RESERVED_PARAMETERS: ReadonlySet<string> = new Set([
  'wstoken',
  'wsfunction',
  'moodlewsrestformat',
]);

const silentLogger = createLogger({ service: 'moodle-client', level: 'silent' });

/**
 * REST transport over HTTPS. Requests are POSTed as form data so the token travels in the
 * request body, never in a URL that proxies, access logs or error messages might record.
 */
export class HttpMoodleTransport implements MoodleTransport {
  readonly #token: string;
  readonly #options: HttpMoodleTransportOptions;
  readonly #fetch: FetchFn;
  readonly #logger: Logger;
  readonly #retryPolicy: RetryPolicy;
  readonly #sleep: Sleep;
  readonly #random: RandomSource;

  constructor(options: HttpMoodleTransportOptions) {
    if (options.token.trim() === '') {
      throw new MoodleValidationError('A Moodle token is required.', { code: 'missing_token' });
    }
    this.#token = options.token;
    // Defence in depth: whatever path an error or log line takes, the token is scrubbed.
    registerSecretValue(options.token);
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#logger = (options.logger ?? silentLogger).child({ component: 'moodle-transport' });
    this.#retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async call(
    functionName: MoodleFunctionName,
    params: MoodleParams,
    options: MoodleCallOptions = {},
  ): Promise<unknown> {
    for (const name of Object.keys(params)) {
      if (RESERVED_PARAMETERS.has(name.toLowerCase())) {
        throw new MoodleValidationError('Reserved web-service parameter supplied.', {
          code: 'reserved_parameter',
          functionName,
        });
      }
    }
    // Encode once up front so invalid parameters fail before any network traffic.
    const encodedParams = encodeMoodleParams(params);

    const started = Date.now();
    const result = await runWithRetries(
      () => this.#attempt(functionName, encodedParams, options.signal),
      {
        policy: this.#retryPolicy,
        sleep: this.#sleep,
        random: this.#random,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        normalizeError: (error) =>
          isMoodleError(error)
            ? error
            : new MoodleApiError('Unexpected failure while calling Moodle.', {
                code: 'unexpected_error',
                functionName,
              }),
        cancelledError: () =>
          new MoodleTransportError('Moodle request was cancelled.', {
            code: 'aborted',
            functionName,
          }),
        onFailure: ({ error, attempt, durationMs, willRetry }) => {
          this.#logger.warn('Moodle call failed.', {
            functionName,
            attempt: attempt + 1,
            durationMs,
            category: error.category,
            code: error.code,
            httpStatus: error.httpStatus,
            willRetry,
            // Parameter names only: values can include user e-mail addresses.
            parameterNames: Object.keys(params),
          });
        },
      },
    );
    this.#logger.debug('Moodle call succeeded.', {
      functionName,
      durationMs: Date.now() - started,
    });
    return result;
  }

  async #attempt(
    functionName: MoodleFunctionName,
    encodedParams: URLSearchParams,
    callerSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const context: ErrorContext = { functionName, operation: 'request' };
    const body = new URLSearchParams({
      wstoken: this.#token,
      wsfunction: functionName,
      moodlewsrestformat: 'json',
    });
    for (const [key, value] of encodedParams) {
      body.append(key, value);
    }

    const signals = createRequestSignals(this.#options.requestTimeoutMs, callerSignal);
    let response: Response;
    let raw: Uint8Array;
    try {
      response = await this.#fetch(this.#options.baseUrl.restEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          'user-agent': this.#options.userAgent ?? 'ehub-teams-assistant',
        },
        body: body.toString(),
        // The REST endpoint never legitimately redirects; following one could resend the token.
        redirect: 'manual',
        signal: signals.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new MoodleTransportError('Moodle REST endpoint returned an unexpected redirect.', {
          code: 'unexpected_redirect',
          httpStatus: response.status,
          functionName,
        });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw errorFromHttpStatus(
          response.status,
          context,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      raw = await readBodyWithLimit(
        response,
        this.#options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        () =>
          new MoodleValidationError('Moodle response exceeded the size limit.', {
            code: 'response_too_large',
            functionName,
          }),
      );
    } catch (error) {
      if (isMoodleError(error)) {
        throw error;
      }
      throw errorFromNetworkFailure(error, context, signals);
    }

    return this.#decode(raw, response, functionName, context);
  }

  #decode(
    raw: Uint8Array,
    response: Response,
    functionName: MoodleFunctionName,
    context: ErrorContext,
  ): unknown {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      const contentType = response.headers.get('content-type') ?? '';
      const html = contentType.includes('text/html') || /^\s*</.test(text);
      throw new MoodleApiError(
        html
          ? 'Moodle returned an HTML page instead of JSON (maintenance mode, login page or proxy error).'
          : 'Moodle returned a response that is not valid JSON.',
        { code: html ? 'unexpected_html_response' : 'invalid_json', functionName },
      );
    }

    const exception: MoodleError | undefined = moodleExceptionFromBody(decoded, context, [
      this.#token,
    ]);
    if (exception !== undefined) {
      throw exception;
    }
    return decoded;
  }
}
