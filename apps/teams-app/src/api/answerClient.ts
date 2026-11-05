import { CORRELATION_ID_HEADER, getTelemetry, type Logger } from '@ehub/shared';
import {
  ANSWER_API_PATHS,
  MOCK_IDENTITY_HEADER,
  answerResponseSchema,
  apiErrorResponseSchema,
  type AnswerRequest,
  type AnswerResponse,
  type ApiErrorCode,
  type FeedbackRequest,
} from '@ehub/shared/answers';

import type { CallerCredential } from '../conversation/identity.js';

export type AnswerClientErrorKind =
  /** No response within the timeout. */
  | 'timeout'
  /** Connection refused, DNS, 5xx. */
  | 'unavailable'
  /** A response that is not the contract. */
  | 'bad_response'
  /** The API refused the request (4xx, or 503 when sign-in is not configured). */
  | 'rejected';

export class AnswerClientError extends Error {
  constructor(
    readonly kind: AnswerClientErrorKind,
    readonly details: {
      readonly status?: number;
      readonly code?: ApiErrorCode;
      readonly retryAfterMs?: number;
    } = {},
  ) {
    super(
      `Answer API request failed: ${kind}${details.code === undefined ? '' : ` (${details.code})`}.`,
    );
    this.name = 'AnswerClientError';
  }
}

export interface RequestContext {
  readonly correlationId: string;
  readonly credential: CallerCredential;
  readonly signal?: AbortSignal;
}

/** The answer API as the conversation layer sees it. */
export interface AnswerClient {
  ask(request: AnswerRequest, context: RequestContext): Promise<AnswerResponse>;
  sendFeedback(request: FeedbackRequest, context: RequestContext): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Responses are small JSON documents; anything larger is refused unread. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FEEDBACK_TIMEOUT_MS = 5_000;

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new AnswerClientError('bad_response', { status: response.status });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new AnswerClientError('bad_response', { status: response.status });
  }
  return text;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * HTTP client for apps/api. Sends the correlation ID so a Teams turn and its API request share
 * one ID in the logs. Holds no Moodle or Azure credentials: it forwards the user's Entra ID
 * token from Teams SSO (or, in development, names the mock user). Headers are never logged.
 */
export class HttpAnswerClient implements AnswerClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #logger: Logger;

  constructor(options: {
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly logger: Logger;
    readonly fetch?: FetchLike;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#logger = options.logger.child({ component: 'answer-client' });
  }

  async ask(request: AnswerRequest, context: RequestContext): Promise<AnswerResponse> {
    const text = await this.#post(ANSWER_API_PATHS.answers, request, context, this.#timeoutMs);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AnswerClientError('bad_response', { status: 200 });
    }
    const parsed = answerResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger.warn('Answer API response did not match the contract.', {
        issuePaths: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].slice(
          0,
          10,
        ),
      });
      throw new AnswerClientError('bad_response', { status: 200 });
    }
    return parsed.data;
  }

  async sendFeedback(request: FeedbackRequest, context: RequestContext): Promise<void> {
    await this.#post(
      ANSWER_API_PATHS.feedback,
      request,
      context,
      Math.min(this.#timeoutMs, FEEDBACK_TIMEOUT_MS),
    );
  }

  async #post(
    path: string,
    body: unknown,
    context: RequestContext,
    timeoutMs: number,
  ): Promise<string> {
    const signals = [
      AbortSignal.timeout(timeoutMs),
      ...(context.signal === undefined ? [] : [context.signal]),
    ];
    const started = Date.now();
    let response: Response;
    try {
      response = await getTelemetry().span(
        'answer_api.request',
        async (span) => {
          // W3C trace context, so the API's spans join this trace (alongside the correlation ID).
          const traceHeaders: Record<string, string> = {};
          getTelemetry().inject(traceHeaders);
          const result = await this.#fetch(`${this.#baseUrl}${path}`, {
            method: 'POST',
            headers: {
              ...traceHeaders,
              'content-type': 'application/json',
              accept: 'application/json',
              [CORRELATION_ID_HEADER]: context.correlationId,
              // The token is passed through unread; the API validates it.
              ...(context.credential.kind === 'user-token'
                ? { authorization: `Bearer ${context.credential.token}` }
                : { [MOCK_IDENTITY_HEADER]: context.credential.userId }),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any(signals),
            redirect: 'error',
          });
          span.set({ 'http.response.status_code': result.status });
          if (result.status >= 500) {
            span.fail('server_error');
          }
          return result;
        },
        {
          kind: 'client',
          attributes: {
            'ehub.dependency': 'answer_api',
            'ehub.operation': path === '/v1/answers' ? 'answers' : 'feedback',
          },
        },
      );
    } catch (error) {
      const kind = isTimeout(error) ? 'timeout' : 'unavailable';
      this.#logger.warn('Answer API request failed.', {
        path,
        kind,
        durationMs: Date.now() - started,
      });
      throw new AnswerClientError(kind);
    }
    let text: string;
    try {
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof AnswerClientError) {
        throw error;
      }
      throw new AnswerClientError(isTimeout(error) ? 'timeout' : 'unavailable', {
        status: response.status,
      });
    }
    this.#logger.info('Answer API responded.', {
      path,
      status: response.status,
      durationMs: Date.now() - started,
    });
    if (response.ok) {
      return text;
    }
    let code: ApiErrorCode | undefined;
    let retryAfterMs: number | undefined;
    try {
      const parsed = apiErrorResponseSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        code = parsed.data.error.code;
        retryAfterMs = parsed.data.retryAfterMs;
      }
    } catch {
      // Not JSON: classified by status alone.
    }
    const details = {
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
    if (response.status === 504 || code === 'timeout') {
      throw new AnswerClientError('timeout', details);
    }
    if (response.status >= 500 && code !== 'authentication_not_configured') {
      throw new AnswerClientError('unavailable', details);
    }
    throw new AnswerClientError('rejected', details);
  }
}
