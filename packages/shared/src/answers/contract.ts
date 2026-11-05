import { z } from 'zod';

/*
 * The HTTP contract between the answer API (apps/api) and its clients (the Teams app). Both
 * sides validate with these schemas, so a change here is a change to both.
 */

export const ANSWER_API_PATHS = {
  health: '/health',
  answers: '/v1/answers',
  feedback: '/v1/feedback',
} as const;

/**
 * Development only: names the mock user. The API accepts it only when its own mock identity is
 * enabled in development. Real callers send an Entra ID access token (Authorization: Bearer).
 */
export const MOCK_IDENTITY_HEADER = 'x-ehub-mock-identity';

const correlationIdLike = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const courseId = z.number().int().positive().max(2_147_483_647);

export const answerRequestSchema = z.strictObject({
  question: z.string().min(1).max(4_000),
  /** Optional narrowing within the caller's authorised courses. */
  selectedCourseIds: z.array(courseId).min(1).max(50).optional(),
});
export type AnswerRequest = z.output<typeof answerRequestSchema>;

export const ANSWER_STATUSES = ['answered', 'insufficient_evidence', 'failed'] as const;

export const answerCitationSchema = z.strictObject({
  citationId: z.number().int().positive().max(100),
  courseId,
  courseName: z.string().max(500),
  sectionName: z.string().max(500),
  moduleId: z.number().int().positive(),
  resourceName: z.string().max(500),
  resourceType: z.string().max(40),
  pageNumber: z.number().int().positive().optional(),
  pageNumberEnd: z.number().int().positive().optional(),
  slideNumber: z.number().int().positive().optional(),
  /** Approved https link (activity, or file); absent when no approved link exists. */
  sourceUrl: z.string().max(2_048).optional(),
  excerpt: z.string().max(1_000),
});
export type AnswerCitation = z.output<typeof answerCitationSchema>;

export const answerClaimSchema = z.strictObject({
  text: z.string().max(2_000),
  citationIds: z.array(z.number().int().positive().max(100)).max(20),
});

export const answerResponseSchema = z.strictObject({
  /** The request's correlation ID; quoted in feedback and support requests. */
  answerId: correlationIdLike,
  status: z.enum(ANSWER_STATUSES),
  answer: z.string().max(20_000),
  claims: z.array(answerClaimSchema).max(30),
  citations: z.array(answerCitationSchema).max(50),
  conflictingSources: z.boolean(),
  /** Machine-readable codes only. */
  warnings: z.array(z.string().max(80)).max(30),
  /** True when the caller was the development mock identity. */
  mockIdentity: z.boolean(),
});
export type AnswerResponse = z.output<typeof answerResponseSchema>;

export const FEEDBACK_RATINGS = ['useful', 'not_useful'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const feedbackRequestSchema = z.strictObject({
  answerId: correlationIdLike,
  rating: z.enum(FEEDBACK_RATINGS),
});
export type FeedbackRequest = z.output<typeof feedbackRequestSchema>;

export const API_ERROR_CODES = [
  'invalid_request',
  'invalid_question',
  'unsupported_media_type',
  'payload_too_large',
  'not_found',
  'method_not_allowed',
  'unauthenticated',
  'forbidden',
  'authentication_not_configured',
  'authentication_unavailable',
  'no_authorized_courses',
  'course_not_authorized',
  'identity_not_mapped',
  'authorization_unavailable',
  'rate_limited',
  'timeout',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string().max(500),
  }),
  correlationId: correlationIdLike,
  retryAfterMs: z.number().int().nonnegative().optional(),
});
export type ApiErrorResponse = z.output<typeof apiErrorResponseSchema>;

export const apiHealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.string(),
  version: z.string(),
  identityMode: z.enum(['entra', 'dev-mock', 'entra+dev-mock', 'none']),
});
export type ApiHealthResponse = z.output<typeof apiHealthResponseSchema>;
