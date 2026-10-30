import { redactString } from '@ehub/shared';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A JSON Schema in the subset Azure OpenAI structured outputs accept. */
export interface ResponseSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ChatCompletionRequest {
  readonly messages: readonly ChatMessage[];
  /** When set, the model is asked for JSON matching this schema. */
  readonly responseSchema?: ResponseSchema;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export type ChatFinishReason = 'stop' | 'length' | 'content_filter' | 'other';

export interface ChatCompletion {
  readonly content: string;
  readonly finishReason: ChatFinishReason;
  /** The model name the service reported, if any. */
  readonly model: string | undefined;
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
}

/** Generates chat completions. Implementations never log prompts or completions. */
export interface ChatModelProvider {
  complete(request: ChatCompletionRequest): Promise<ChatCompletion>;
  /** Deployment or model name, for logs and answer metadata. */
  getModelName(): string;
}

export const CHAT_ERROR_CATEGORIES = [
  'authentication',
  'authorization',
  'not_found',
  'throttled',
  'unavailable',
  'timeout',
  'network',
  'cancelled',
  'invalid_request',
  'invalid_response',
  'content_filter',
] as const;
export type ChatErrorCategory = (typeof CHAT_ERROR_CATEGORIES)[number];

/**
 * Chat failures. Messages carry the category, HTTP status and Azure's error code only, never
 * prompt or completion text.
 */
export class ChatModelError extends Error {
  readonly category: ChatErrorCategory;
  readonly httpStatus: number | undefined;
  readonly serviceCode: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    details: {
      readonly category: ChatErrorCategory;
      readonly httpStatus?: number;
      readonly serviceCode?: string;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
    },
  ) {
    super(redactString(message));
    this.name = 'ChatModelError';
    this.category = details.category;
    this.httpStatus = details.httpStatus;
    this.serviceCode = details.serviceCode;
    this.retryable = details.retryable ?? false;
    this.retryAfterMs = details.retryAfterMs;
  }

  toLogFields(): Readonly<Record<string, unknown>> {
    return {
      category: this.category,
      httpStatus: this.httpStatus,
      serviceCode: this.serviceCode,
      retryable: this.retryable,
    };
  }
}

export function isChatModelError(error: unknown): error is ChatModelError {
  return error instanceof ChatModelError;
}
