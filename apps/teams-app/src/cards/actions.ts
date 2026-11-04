import { FEEDBACK_RATINGS, type FeedbackRating } from '@ehub/shared/answers';
import { z } from 'zod';

import type { ExecuteAction, SubmitAction } from './adaptiveCard.js';

export const FEEDBACK_VERB = 'ehub.feedback';
export const RETRY_VERB = 'ehub.retry';

/** Longest question carried in an "Ask again" button. */
export const MAX_RETRY_QUESTION_CHARS = 1_000;

const answerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/**
 * Data the bot's own buttons send back. It returns from the client, so it is untrusted input
 * and is validated like any other.
 */
export const cardActionDataSchema = z.discriminatedUnion('ehubAction', [
  z.object({
    ehubAction: z.literal('feedback'),
    answerId,
    rating: z.enum(FEEDBACK_RATINGS),
  }),
  z.object({
    ehubAction: z.literal('retry'),
    question: z.string().min(1).max(MAX_RETRY_QUESTION_CHARS),
  }),
]);
export type CardActionData = z.output<typeof cardActionDataSchema>;

function execute(title: string, verb: string, data: Record<string, string>): ExecuteAction {
  // Clients without Universal Actions post the same data back as a message value.
  const fallback: SubmitAction = { type: 'Action.Submit', title, data };
  return { type: 'Action.Execute', title, verb, data, fallback };
}

export function feedbackActions(id: string): ExecuteAction[] {
  const action = (title: string, rating: FeedbackRating): ExecuteAction =>
    execute(title, FEEDBACK_VERB, { ehubAction: 'feedback', answerId: id, rating });
  return [action('👍 Useful', 'useful'), action('👎 Not useful', 'not_useful')];
}

export function retryAction(question: string): ExecuteAction | undefined {
  const points = Array.from(question);
  if (points.length === 0 || points.length > MAX_RETRY_QUESTION_CHARS) {
    return undefined;
  }
  return execute('Ask again', RETRY_VERB, { ehubAction: 'retry', question });
}

/** A suggested question: Teams posts the text into the chat as if the user typed it. */
export function suggestionAction(question: string): SubmitAction {
  return {
    type: 'Action.Submit',
    title: question,
    data: { msteams: { type: 'imBack', value: question } },
  };
}
