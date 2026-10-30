import { z } from 'zod';

import type { ResponseSchema } from './chatModelProvider.js';

/** The exact reply when the authorised content does not support an answer. */
export const INSUFFICIENT_EVIDENCE_MESSAGE =
  'I could not find enough information in the authorised E-Hub content to answer that reliably.';

export const MAX_CLAIMS = 30;
export const MAX_MODEL_WARNINGS = 10;

/** What the model must return. Lengths are checked here; the JSON schema cannot express them. */
export const modelAnswerSchema = z.strictObject({
  answer: z.string(),
  claims: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(1_000),
        sourceIds: z.array(z.string().regex(/^S\d{1,3}$/)).max(10),
      }),
    )
    .max(MAX_CLAIMS),
  insufficientEvidence: z.boolean(),
  conflictingSources: z.boolean(),
  warnings: z.array(z.string().max(300)).max(MAX_MODEL_WARNINGS),
});
export type ModelAnswer = z.output<typeof modelAnswerSchema>;

/**
 * The same shape as a JSON Schema for structured outputs: every property required,
 * `additionalProperties: false`, and only supported keywords (no length limits).
 */
export const MODEL_ANSWER_RESPONSE_SCHEMA: ResponseSchema = {
  name: 'ehub_grounded_answer',
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            sourceIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'sourceIds'],
          additionalProperties: false,
        },
      },
      insufficientEvidence: { type: 'boolean' },
      conflictingSources: { type: 'boolean' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['answer', 'claims', 'insufficientEvidence', 'conflictingSources', 'warnings'],
    additionalProperties: false,
  },
};
