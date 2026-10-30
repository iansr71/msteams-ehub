import type {
  ChatCompletion,
  ChatCompletionRequest,
  ChatModelProvider,
} from '../chatModelProvider.js';

/** A step: model output text (optionally truncated), an error to throw, or a function of the request. */
export type ScriptedStep =
  | string
  | { readonly content: string; readonly finishReason?: ChatCompletion['finishReason'] }
  | Error
  | ((request: ChatCompletionRequest) => string);

/** Test double for the chat model: replies from a script and records every request. */
export class ScriptedChatModel implements ChatModelProvider {
  readonly requests: ChatCompletionRequest[] = [];
  readonly #steps: ScriptedStep[];

  constructor(steps: readonly ScriptedStep[]) {
    this.#steps = [...steps];
  }

  getModelName(): string {
    return 'scripted-model';
  }

  complete(request: ChatCompletionRequest): Promise<ChatCompletion> {
    this.requests.push(request);
    const step = this.#steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error('The scripted model has no more replies.'));
    }
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    const resolved = typeof step === 'function' ? step(request) : step;
    const content = typeof resolved === 'string' ? resolved : resolved.content;
    const finishReason = typeof resolved === 'string' ? 'stop' : (resolved.finishReason ?? 'stop');
    return Promise.resolve({
      content,
      finishReason,
      model: 'scripted-model',
      promptTokens: 100,
      completionTokens: 50,
    });
  }
}

export function modelAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answer: 'Reapply sunscreen every two hours after a peel.',
    claims: [
      { text: 'Sunscreen should be reapplied every two hours after a peel.', sourceIds: ['S1'] },
    ],
    insufficientEvidence: false,
    conflictingSources: false,
    warnings: [],
    ...overrides,
  });
}
