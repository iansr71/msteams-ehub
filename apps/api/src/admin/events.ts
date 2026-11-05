import { join } from 'node:path';

import { FEEDBACK_RATINGS } from '@ehub/shared/answers';
import { z } from 'zod';

import {
  pseudonymousUserKey,
  type FeedbackEvent,
  type FeedbackRecorder,
} from '../http/feedbackRecorder.js';
import type { Logger } from '@ehub/shared';
import { FileEventStore, type EventStore } from './eventStore.js';

const isoTime = z.iso.datetime();
const correlationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const ADMIN_ACTIONS = [
  'sync.incremental',
  'course.reindex',
  'resource.retry',
  'identity.map',
  'identity.unmap',
  'enrolment.refresh',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * One administrative mutation, attempted or done. IDs, codes and counts only: no names, no
 * email addresses, no document text.
 */
export const auditEventSchema = z.strictObject({
  at: isoTime,
  action: z.enum(ADMIN_ACTIONS),
  /** `accepted` (started or done), `refused` (validation, role or state), `failed`. */
  outcome: z.enum(['accepted', 'refused', 'failed']),
  /** Why it was refused or failed, as a code. */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  actor: z.strictObject({
    objectId: guid,
    roles: z.array(z.string().max(64)).max(10),
    /** `entra-access-token` or `dev-mock`. */
    method: z.string().max(40),
  }),
  target: z
    .strictObject({
      courseId: z.number().int().positive().optional(),
      resourceId: z.string().max(1100).optional(),
      entraObjectId: guid.optional(),
      moodleUserId: z.number().int().positive().optional(),
      scope: z.enum(['user', 'all']).optional(),
      jobId: z.string().max(200).optional(),
    })
    .optional(),
  correlationId,
});
export type AuditEvent = z.output<typeof auditEventSchema>;

/** What happened to a question: the outcome only, never the question or the answer. */
export const answerOutcomeSchema = z.strictObject({
  kind: z.literal('answer'),
  at: isoTime,
  status: z.enum(['answered', 'insufficient_evidence', 'failed']),
  correlationId,
});

export const feedbackRecordSchema = z.strictObject({
  kind: z.literal('feedback'),
  at: isoTime,
  answerId: z.string().max(128),
  rating: z.enum(FEEDBACK_RATINGS),
  /** Pseudonymous: a keyed hash of the Entra object ID. */
  userKey: z.string().regex(/^[0-9a-f]{16}$/),
});

export const usageEventSchema = z.discriminatedUnion('kind', [
  answerOutcomeSchema,
  feedbackRecordSchema,
]);
export type UsageEvent = z.output<typeof usageEventSchema>;

export interface AdminStores {
  readonly audit: EventStore<AuditEvent>;
  readonly usage: EventStore<UsageEvent>;
}

export function fileAdminStores(directory: string): AdminStores {
  return {
    audit: new FileEventStore({
      directory: join(directory, 'audit'),
      schema: auditEventSchema,
      timeOf: (event) => event.at,
    }),
    usage: new FileEventStore({
      directory: join(directory, 'usage'),
      schema: usageEventSchema,
      timeOf: (event) => event.at,
    }),
  };
}

/** Stores feedback for the dashboard and keeps the structured log line from phase 12. */
export class StoringFeedbackRecorder implements FeedbackRecorder {
  readonly #usage: EventStore<UsageEvent>;
  readonly #log: FeedbackRecorder;

  constructor(usage: EventStore<UsageEvent>, log: FeedbackRecorder) {
    this.#usage = usage;
    this.#log = log;
  }

  async record(event: FeedbackEvent): Promise<void> {
    await this.#log.record(event);
    await this.#usage.append({
      kind: 'feedback',
      at: event.receivedAt,
      answerId: event.answerId,
      rating: event.rating,
      userKey: pseudonymousUserKey(event.userId),
    });
  }
}

/** Records answer outcomes; a storage failure is logged and never fails the answer. */
export class AnswerOutcomeRecorder {
  readonly #usage: EventStore<UsageEvent>;
  readonly #logger: Logger;

  constructor(usage: EventStore<UsageEvent>, logger: Logger) {
    this.#usage = usage;
    this.#logger = logger.child({ component: 'usage' });
  }

  async record(outcome: {
    readonly at: string;
    readonly status: 'answered' | 'insufficient_evidence' | 'failed';
    readonly correlationId: string;
  }): Promise<void> {
    try {
      await this.#usage.append({ kind: 'answer', ...outcome });
    } catch (error) {
      this.#logger.warn('Could not record the answer outcome.', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
