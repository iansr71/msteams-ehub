import { createHash } from 'node:crypto';

import type { Logger } from '@ehub/shared';
import type { FeedbackRating } from '@ehub/shared/answers';

export interface FeedbackEvent {
  readonly answerId: string;
  readonly rating: FeedbackRating;
  readonly userId: string;
  readonly receivedAt: string;
}

/** Where answer feedback goes: logged, and stored for the administration dashboard when enabled. */
export interface FeedbackRecorder {
  record(event: FeedbackEvent): Promise<void>;
}

/** Hashes the user so feedback logs can be grouped per user without naming anyone. */
export function pseudonymousUserKey(userId: string): string {
  return createHash('sha256').update(`ehub-feedback:${userId}`).digest('hex').slice(0, 16);
}

/** Writes one structured log event per rating: IDs and the rating only. */
export class LoggingFeedbackRecorder implements FeedbackRecorder {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger.child({ component: 'feedback' });
  }

  record(event: FeedbackEvent): Promise<void> {
    this.#logger.info('Answer feedback received.', {
      answerId: event.answerId,
      rating: event.rating,
      userKey: pseudonymousUserKey(event.userId),
      receivedAt: event.receivedAt,
    });
    return Promise.resolve();
  }
}
