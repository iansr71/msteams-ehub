import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CORRELATION_ID_HEADER,
  normalizeCorrelationId,
  runWithCorrelationId,
  type Logger,
} from '@ehub/shared';
import {
  ANSWER_API_PATHS,
  answerRequestSchema,
  feedbackRequestSchema,
  type ApiErrorCode,
  type ApiErrorResponse,
  type ApiHealthResponse,
} from '@ehub/shared/answers';
import type { z } from 'zod';

import { QuestionValidationError } from '../rag/questionNormalizer.js';
import {
  RagAuthorizationError,
  RagRateLimitError,
  type RagAnswer,
  type RagRequest,
} from '../rag/ragService.js';
import { toAnswerResponse } from './answerDto.js';
import type { CourseAccessResolver } from '../auth/courseAccess.js';
import { AuthorizationUnavailableError, IdentityNotMappedError } from '../authorization/errors.js';
import type { AuthenticatedCaller, RequestAuthenticator } from './authentication.js';
import type { FeedbackRecorder } from './feedbackRecorder.js';

/** The answer operation the server exposes (RagService in production). */
export interface Answerer {
  ask(request: RagRequest, options?: { readonly signal?: AbortSignal }): Promise<RagAnswer>;
}

export interface ApiServerOptions {
  readonly answerer: Answerer;
  readonly authenticator: RequestAuthenticator;
  readonly courseAccess: CourseAccessResolver;
  /** Named in WWW-Authenticate when a token lacks it. */
  readonly requiredScope?: string;
  readonly feedback: FeedbackRecorder;
  readonly tenantId: string;
  readonly requestTimeoutMs: number;
  readonly logger: Logger;
  readonly service: string;
  readonly version: string;
  readonly clock?: () => Date;
  /** The administration area under /admin (docs/admin.md), when enabled. */
  readonly admin?: (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
  ) => Promise<void>;
  /** Records each answer's outcome (status only) for the administration dashboard. */
  readonly answerOutcomes?: {
    record(outcome: {
      readonly at: string;
      readonly status: 'answered' | 'insufficient_evidence' | 'failed';
      readonly correlationId: string;
    }): Promise<void>;
  };
}

/** Questions are short; anything larger is refused before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-type': 'application/json; charset=utf-8',
} as const;

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  invalid_question: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  not_found: 404,
  method_not_allowed: 405,
  unauthenticated: 401,
  forbidden: 403,
  authentication_not_configured: 503,
  authentication_unavailable: 503,
  no_authorized_courses: 403,
  course_not_authorized: 403,
  identity_not_mapped: 403,
  authorization_unavailable: 503,
  rate_limited: 429,
  timeout: 504,
  internal_error: 500,
};

const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  invalid_request: 'The request is not valid.',
  invalid_question: 'The question is empty or too long.',
  unsupported_media_type: 'Send JSON (Content-Type: application/json).',
  payload_too_large: 'The request is too large.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  unauthenticated: 'The caller could not be authenticated.',
  forbidden: 'The caller is not allowed to use this service.',
  authentication_not_configured:
    'Sign-in is not configured on this server, so no questions can be answered.',
  authentication_unavailable: 'Sign-in cannot be checked right now. Try again shortly.',
  no_authorized_courses: 'You do not have access to any E-Hub courses.',
  course_not_authorized: 'You do not have access to the selected course.',
  identity_not_mapped:
    'Your Microsoft account is not linked to exactly one active E-Hub account. Contact IT.',
  authorization_unavailable: 'Your E-Hub course access cannot be checked right now.',
  rate_limited: 'Too many questions; try again shortly.',
  timeout: 'The answer took too long.',
  internal_error: 'Something went wrong.',
};

class HttpRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    /** WWW-Authenticate value for 401/403 responses (RFC 6750). */
    readonly challenge?: string,
  ) {
    super(code);
    this.name = 'HttpRequestError';
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  correlationId: string,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    [CORRELATION_ID_HEADER]: correlationId,
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function sendError(
  response: ServerResponse,
  code: ApiErrorCode,
  correlationId: string,
  retryAfterMs?: number,
): void {
  const body: ApiErrorResponse = {
    error: { code, message: MESSAGES[code] },
    correlationId,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
  if (retryAfterMs !== undefined) {
    response.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  send(response, STATUS_BY_CODE[code], body, correlationId);
}

async function readJson<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpRequestError('unsupported_media_type');
  }
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpRequestError('payload_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpRequestError('payload_too_large');
    }
    chunks.push(buffer);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpRequestError('invalid_request');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Paths only: Zod messages can quote the question.
    throw new HttpRequestError(
      parsed.error.issues.some((issue) => issue.path[0] === 'question')
        ? 'invalid_question'
        : 'invalid_request',
    );
  }
  return parsed.data;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * The HTTP handler. Every response carries the correlation ID (from x-correlation-id when it
 * is safe, otherwise new) and is JSON. Callers are authenticated by the configured
 * authenticator only; identity fields in the body are not accepted (the schema is strict).
 */
export function createApiRequestHandler(
  options: ApiServerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const logger = options.logger.child({ component: 'http' });
  const clock = options.clock ?? (() => new Date());

  const authenticate = async (request: IncomingMessage): Promise<AuthenticatedCaller> => {
    const result = await options.authenticator.authenticate(request.headers);
    switch (result.kind) {
      case 'authenticated':
        return result.caller;
      case 'not_configured':
        throw new HttpRequestError('authentication_not_configured');
      case 'unavailable':
        logger.error('Authentication unavailable.', { reason: result.reason });
        throw new HttpRequestError('authentication_unavailable');
      case 'unauthenticated':
        // Reason codes only: never the token or the Authorization header.
        logger.warn('Authentication failed.', { reason: result.reason });
        throw new HttpRequestError(
          'unauthenticated',
          result.reason === 'missing_token' ? 'Bearer' : 'Bearer error="invalid_token"',
        );
      case 'forbidden':
        logger.warn('Caller not allowed.', { reason: result.reason });
        throw new HttpRequestError(
          'forbidden',
          result.insufficientScope === undefined
            ? 'Bearer error="insufficient_scope"'
            : `Bearer error="insufficient_scope", scope="${options.requiredScope ?? 'access_as_user'}"`,
        );
    }
  };

  const answers = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
  ): Promise<void> => {
    const caller = await authenticate(request);
    const body = await readJson(request, answerRequestSchema);
    const authorizedCourseIds = await options.courseAccess.resolve(caller);
    logger.info('Caller authenticated.', {
      method: caller.identity.authentication.method,
      accountType: caller.identity.authentication.accountType,
      courses: authorizedCourseIds.length,
    });
    const signal = AbortSignal.timeout(options.requestTimeoutMs);
    const answer = await options.answerer.ask(
      {
        question: body.question,
        user: {
          tenantId: options.tenantId,
          // The validated object ID; never a value from the request.
          userId: caller.identity.objectId,
          authorizedCourseIds: [...authorizedCourseIds],
          ...(body.selectedCourseIds === undefined
            ? {}
            : { selectedCourseIds: body.selectedCourseIds }),
        },
      },
      { signal },
    );
    const answerBody = toAnswerResponse(answer, correlationId, caller.mock);
    await options.answerOutcomes?.record({
      at: clock().toISOString(),
      status: answerBody.status,
      correlationId,
    });
    send(response, 200, answerBody, correlationId);
  };

  const feedback = async (
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
  ): Promise<void> => {
    const caller = await authenticate(request);
    const body = await readJson(request, feedbackRequestSchema);
    await options.feedback.record({
      answerId: body.answerId,
      rating: body.rating,
      userId: caller.identity.objectId,
      receivedAt: clock().toISOString(),
    });
    send(response, 202, { status: 'recorded' }, correlationId);
  };

  return (request, response) => {
    const header = request.headers[CORRELATION_ID_HEADER];
    const correlationId = normalizeCorrelationId(typeof header === 'string' ? header : undefined);
    return runWithCorrelationId(correlationId, async () => {
      const started = Date.now();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const method = request.method ?? 'GET';
      let outcome = 'ok';
      try {
        if (options.admin !== undefined && (path === '/admin' || path.startsWith('/admin/'))) {
          await options.admin(request, response, correlationId);
          outcome = `admin:${String(response.statusCode)}`;
        } else if (path === ANSWER_API_PATHS.health) {
          if (method !== 'GET') {
            throw new HttpRequestError('method_not_allowed');
          }
          const health: ApiHealthResponse = {
            status: options.authenticator.mode === 'none' ? 'degraded' : 'ok',
            service: options.service,
            version: options.version,
            identityMode: options.authenticator.mode,
          };
          send(response, 200, health, correlationId);
        } else if (path === ANSWER_API_PATHS.answers || path === ANSWER_API_PATHS.feedback) {
          if (method !== 'POST') {
            throw new HttpRequestError('method_not_allowed');
          }
          await (path === ANSWER_API_PATHS.answers ? answers : feedback)(
            request,
            response,
            correlationId,
          );
        } else {
          throw new HttpRequestError('not_found');
        }
      } catch (error) {
        let code: ApiErrorCode;
        let retryAfterMs: number | undefined;
        if (error instanceof HttpRequestError) {
          code = error.code;
          if (error.challenge !== undefined && !response.headersSent) {
            response.setHeader('www-authenticate', error.challenge);
          }
        } else if (error instanceof QuestionValidationError) {
          code = 'invalid_question';
        } else if (error instanceof RagAuthorizationError) {
          code = error.code === 'invalid_user_context' ? 'unauthenticated' : error.code;
        } else if (error instanceof IdentityNotMappedError) {
          code = 'identity_not_mapped';
        } else if (error instanceof AuthorizationUnavailableError) {
          code = 'authorization_unavailable';
        } else if (error instanceof RagRateLimitError) {
          code = 'rate_limited';
          retryAfterMs = error.retryAfterMs;
        } else if (isAbort(error)) {
          code = 'timeout';
        } else {
          code = 'internal_error';
          logger.error('Request failed.', { err: error });
        }
        outcome = code;
        if (!response.headersSent) {
          sendError(response, code, correlationId, retryAfterMs);
        }
        // The body may be unread (e.g. too large); drain it so the connection can be reused.
        request.resume();
      }
      // Method, path and outcome only: never bodies or headers.
      logger.info('Request handled.', {
        method,
        path,
        status: response.statusCode,
        outcome,
        durationMs: Date.now() - started,
      });
    });
  };
}

export interface RunningApiServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export async function startApiServer(
  options: ApiServerOptions,
  listen: { readonly host: string; readonly port: number },
): Promise<RunningApiServer> {
  const handler = createApiRequestHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  // Slow-client protection; answers themselves are bounded by requestTimeoutMs.
  server.headersTimeout = 15_000;
  server.requestTimeout = options.requestTimeoutMs + 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${host}:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
