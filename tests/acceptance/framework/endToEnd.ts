import { createLogger } from '@ehub/shared';
import { apiKeyAuthenticator } from '@ehub/shared/search';
import { AzureOpenAIEmbeddingProvider } from '@ehub/shared/embeddings';
import { RestSearchIndexClient } from '@ehub/shared/search';

import type { ChatCompletionRequest } from '../../../apps/api/src/rag/chatModelProvider.js';
import { AnswerSupportChecker } from '../../../apps/api/src/rag/answerSupportChecker.js';
import { GroundedAnswerGenerator } from '../../../apps/api/src/rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../../../apps/api/src/rag/promptBuilder.js';
import { QuestionNormalizer } from '../../../apps/api/src/rag/questionNormalizer.js';
import { RagService, type RagAnswer } from '../../../apps/api/src/rag/ragService.js';
import { RetrievalOrchestrator } from '../../../apps/api/src/rag/retrievalOrchestrator.js';
import { ScriptedChatModel } from '../../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { RetrievalService } from '../../../apps/api/src/retrieval/retrievalService.js';
import { FIXTURE_BASE_URL } from '../../../apps/indexer/src/moodle/__fixtures__/fixtureClient.js';
import {
  HARNESS_AZURE,
  TENANT_ID,
  createHarness,
  type Harness,
} from '../../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';

/*
 * One stack, end to end: the real indexing pipeline writes to a fake Azure AI Search service,
 * and the real answer engine reads from that same index with the same embedding model. Only
 * Moodle, Search, the embedding service and the chat model are fakes, so a question's answer
 * depends on what the pipeline actually indexed.
 *
 * The chat model quotes the retrieved passages instead of inventing text (`quotingModel`). That
 * makes an answer a faithful window onto the index: if indexed text changed, the answer changes;
 * if a passage is gone, it cannot be quoted. It also means the citation and grounding checks are
 * exercised for real rather than against hand-written model output.
 */

const SOURCE_PATTERN = /<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g;

export interface QuotedSource {
  readonly sourceId: string;
  readonly text: string;
}

/** The passages the prompt put in front of the model, in order. */
export function quotedSources(request: ChatCompletionRequest): QuotedSource[] {
  const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
  return [...user.matchAll(SOURCE_PATTERN)].map((match) => ({
    sourceId: match[1] ?? '',
    text: (match[2] ?? '').trim(),
  }));
}

export interface QuotingModelOptions {
  /** How many passages to quote as claims (default 2). */
  readonly claims?: number;
  readonly maxClaimChars?: number;
  /** Set `conflictingSources` on the reply. */
  readonly conflicting?: boolean;
}

/**
 * A model reply that quotes the passages verbatim. With no passages it returns the
 * insufficient-evidence reply, as a well-behaved model would.
 */
export function quotingModel(options: QuotingModelOptions = {}) {
  const maxChars = options.maxClaimChars ?? 400;
  return (request: ChatCompletionRequest): string => {
    const sources = quotedSources(request).slice(0, options.claims ?? 2);
    if (sources.length === 0) {
      return JSON.stringify({
        answer: '',
        claims: [],
        insufficientEvidence: true,
        conflictingSources: false,
        warnings: [],
      });
    }
    const claims = sources.map((source) => ({
      text: source.text.slice(0, maxChars),
      sourceIds: [source.sourceId],
    }));
    return JSON.stringify({
      answer: claims.map((claim) => claim.text).join(' '),
      claims,
      insufficientEvidence: false,
      conflictingSources: options.conflicting ?? false,
      warnings: [],
    });
  };
}

export interface AskOptions {
  readonly authorizedCourseIds?: readonly number[];
  readonly selectedCourseIds?: readonly number[];
  readonly userId?: string;
  readonly model?: QuotingModelOptions;
  /** Replaces the quoting model, for cases that need specific model output. */
  readonly reply?: string | ((request: ChatCompletionRequest) => string);
}

export interface EndToEndStack {
  readonly harness: Harness;
  readonly tenantId: string;
  readonly moodleBaseUrl: string;
  /** Prompts the chat model received, for prompt-structure assertions. */
  readonly prompts: ChatCompletionRequest[];
  ask(question: string, options?: AskOptions): Promise<RagAnswer>;
}

/** Builds the answer side against the harness's fakes. */
export async function createEndToEndStack(
  options: { readonly logs?: string[] } = {},
): Promise<EndToEndStack> {
  const harness = await createHarness();
  const logs = options.logs;
  const logger = createLogger({
    service: 'acceptance',
    level: 'trace',
    ...(logs === undefined ? {} : { sink: { write: (line: string) => logs.push(line) } }),
    ...(logs === undefined ? { level: 'silent' as const } : {}),
  });

  const search = new RestSearchIndexClient({
    endpoint: HARNESS_AZURE.searchEndpoint,
    indexName: HARNESS_AZURE.indexName,
    vectorDimensions: HARNESS_AZURE.dimensions,
    semanticEnabled: true,
    authenticator: apiKeyAuthenticator(HARNESS_AZURE.searchKey),
    fetch: harness.search.fetch,
    logger,
    sleep: () => Promise.resolve(),
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
  });
  const embedder = new AzureOpenAIEmbeddingProvider({
    endpoint: HARNESS_AZURE.openAiEndpoint,
    deployment: HARNESS_AZURE.embeddingDeployment,
    modelIdentifier: HARNESS_AZURE.embeddingModel,
    embeddingVersion: '1',
    dimensions: HARNESS_AZURE.dimensions,
    sendDimensions: false,
    authenticator: apiKeyAuthenticator(HARNESS_AZURE.openAiKey),
    batchSize: 16,
    maxBatchTokens: 100_000,
    maxInputTokens: 8191,
    maxConcurrency: 1,
    requestsPerMinute: 60_000,
    requestTimeoutMs: 5_000,
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    fetch: harness.embeddings.fetch,
  });
  const prompts: ChatCompletionRequest[] = [];

  const ask = async (question: string, askOptions: AskOptions = {}): Promise<RagAnswer> => {
    const reply = askOptions.reply ?? quotingModel(askOptions.model);
    const model = new ScriptedChatModel([reply, reply, reply]);
    const rag = new RagService({
      normalizer: new QuestionNormalizer(1000),
      orchestrator: new RetrievalOrchestrator({
        retrieval: new RetrievalService({
          search,
          embedder,
          settings: {
            topK: 6,
            maxChunksPerResource: 3,
            candidateCount: 30,
            semanticRanking: false,
            minScore: undefined,
            minRerankerScore: undefined,
          },
          logger,
        }),
        minSupportingChunks: 1,
        minTopRerankerScore: undefined,
      }),
      promptBuilder: new PromptBuilder(12_000),
      generator: new GroundedAnswerGenerator({
        model,
        maxOutputTokens: 1_200,
        maxAnswerChars: 4_000,
        logger,
      }),
      modelName: model.getModelName(),
      supportChecker: new AnswerSupportChecker({ excerptChars: 300 }),
      allowedHosts: new Set([FIXTURE_BASE_URL.host]),
      logger,
    });
    const answer = await rag.ask({
      question,
      user: {
        tenantId: TENANT_ID,
        userId: askOptions.userId ?? 'acceptance-user',
        authorizedCourseIds: [...(askOptions.authorizedCourseIds ?? [12])],
        ...(askOptions.selectedCourseIds === undefined
          ? {}
          : { selectedCourseIds: [...askOptions.selectedCourseIds] }),
      },
    });
    prompts.push(...model.requests);
    return answer;
  };

  return { harness, tenantId: TENANT_ID, moodleBaseUrl: FIXTURE_BASE_URL.href, prompts, ask };
}

/** Every claim's text, for fact assertions. */
export function answerText(answer: RagAnswer): string {
  return [answer.answer, ...answer.claims.map((claim) => claim.text)].join('\n');
}
