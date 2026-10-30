import { createLogger, type Logger } from '@ehub/shared';

import {
  MODEL_ANSWER_RESPONSE_SCHEMA,
  modelAnswerSchema,
  type ModelAnswer,
} from './answerSchema.js';
import type { ChatMessage, ChatModelProvider } from './chatModelProvider.js';
import type { BuiltPrompt } from './promptBuilder.js';

export type GenerationFailure =
  'invalid_output' | 'truncated_output' | 'unknown_source_ids' | 'answer_too_long';

export type GenerationResult =
  | { readonly kind: 'generated'; readonly answer: ModelAnswer; readonly attempts: number }
  | { readonly kind: 'failed'; readonly reason: GenerationFailure; readonly attempts: number };

export interface GroundedAnswerGeneratorOptions {
  readonly model: ChatModelProvider;
  readonly maxOutputTokens: number;
  readonly maxAnswerChars: number;
  readonly logger?: Logger;
}

const MAX_REPAIR_ECHO_CHARS = 8_000;
const silentLogger = createLogger({ service: 'rag', level: 'silent' });

interface Validation {
  readonly answer?: ModelAnswer;
  readonly failure?: GenerationFailure;
  /** Problems described for the repair request: field paths and rules, never content. */
  readonly problems: readonly string[];
}

/** Removes a Markdown code fence some models wrap JSON in. */
function stripFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Asks the model for a structured answer and validates it with Zod: shape, lengths, and that
 * every cited source ID is one that was provided. One bounded repair attempt is made; after
 * that the caller gets a failure and returns a safe response.
 */
export class GroundedAnswerGenerator {
  readonly #options: GroundedAnswerGeneratorOptions;
  readonly #logger: Logger;

  constructor(options: GroundedAnswerGeneratorOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? silentLogger).child({ component: 'answer-generator' });
  }

  async generate(prompt: BuiltPrompt, signal?: AbortSignal): Promise<GenerationResult> {
    const known = new Set(prompt.sources.map((source) => source.sourceId));
    const first = await this.#options.model.complete({
      messages: prompt.messages,
      responseSchema: MODEL_ANSWER_RESPONSE_SCHEMA,
      maxOutputTokens: this.#options.maxOutputTokens,
      ...(signal === undefined ? {} : { signal }),
    });
    const initial = this.#validate(first.content, first.finishReason === 'length', known);
    if (initial.answer !== undefined) {
      return { kind: 'generated', answer: initial.answer, attempts: 1 };
    }
    this.#logger.warn('Model output was invalid; attempting one repair.', {
      failure: initial.failure,
      problems: initial.problems.length,
    });

    const repairMessages: ChatMessage[] = [
      ...prompt.messages,
      { role: 'assistant', content: first.content.slice(0, MAX_REPAIR_ECHO_CHARS) },
      {
        role: 'user',
        content: [
          'Your previous reply could not be used:',
          ...initial.problems.map((problem) => `- ${problem}`),
          `Reply again with only the JSON object described in the rules. Cite only these source IDs: ${[...known].join(', ')}.`,
        ].join('\n'),
      },
    ];
    const second = await this.#options.model.complete({
      messages: repairMessages,
      responseSchema: MODEL_ANSWER_RESPONSE_SCHEMA,
      maxOutputTokens: this.#options.maxOutputTokens,
      ...(signal === undefined ? {} : { signal }),
    });
    const repaired = this.#validate(second.content, second.finishReason === 'length', known);
    if (repaired.answer !== undefined) {
      return { kind: 'generated', answer: repaired.answer, attempts: 2 };
    }
    this.#logger.warn('Model output was still invalid after repair.', {
      failure: repaired.failure,
    });
    return { kind: 'failed', reason: repaired.failure ?? 'invalid_output', attempts: 2 };
  }

  #validate(content: string, truncated: boolean, known: ReadonlySet<string>): Validation {
    if (truncated) {
      return {
        failure: 'truncated_output',
        problems: ['The reply was cut off. Give a shorter answer.'],
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(stripFence(content));
    } catch {
      return { failure: 'invalid_output', problems: ['The reply was not valid JSON.'] };
    }
    const parsed = modelAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        failure: 'invalid_output',
        problems: parsed.error.issues
          .slice(0, 10)
          .map(
            (issue) =>
              `${issue.path.length === 0 ? '(reply)' : issue.path.join('.')}: ${issue.message}`,
          ),
      };
    }
    const unknown = [
      ...new Set(
        parsed.data.claims.flatMap((claim) => claim.sourceIds).filter((id) => !known.has(id)),
      ),
    ];
    if (unknown.length > 0) {
      return {
        failure: 'unknown_source_ids',
        problems: [`These source IDs were not provided: ${unknown.slice(0, 10).join(', ')}.`],
      };
    }
    if (parsed.data.answer.length > this.#options.maxAnswerChars) {
      return {
        failure: 'answer_too_long',
        problems: [
          `The answer is longer than ${String(this.#options.maxAnswerChars)} characters. Shorten it.`,
        ],
      };
    }
    return { answer: parsed.data, problems: [] };
  }
}
