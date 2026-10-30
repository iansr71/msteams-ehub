import {
  EXIT_FAILURE,
  EXIT_OK,
  chatConfigSchema,
  courseIdListSchema,
  loadConfig,
  parseCommandArgs,
  redactString,
  sanitizeText,
  type ChatConfig,
  type CommandDefinition,
  type Logger,
} from '@ehub/shared';
import { z } from 'zod';

import { isChatModelError, type ChatModelProvider } from '../rag/chatModelProvider.js';
import { formatAnswerAsText } from '../rag/answerFormatter.js';
import { AnswerSupportChecker } from '../rag/answerSupportChecker.js';
import { resolveAllowedHosts } from '../rag/citationValidator.js';
import { createChatProvider } from '../rag/factory.js';
import { GroundedAnswerGenerator } from '../rag/groundedAnswerGenerator.js';
import { PromptBuilder } from '../rag/promptBuilder.js';
import { QuestionNormalizer, QuestionValidationError } from '../rag/questionNormalizer.js';
import {
  RagAuthorizationError,
  RagRateLimitError,
  RagService,
  type RagAnswer,
} from '../rag/ragService.js';
import { RetrievalOrchestrator } from '../rag/retrievalOrchestrator.js';
import {
  describeFailure,
  openRetrieval,
  withErrorHandling,
  type FailureReport,
  type RetrievalCommandDependencies,
} from './retrievalCommands.js';

export interface AskCommandDependencies extends RetrievalCommandDependencies {
  readonly createChat?: (settings: ChatConfig, logger: Logger) => Promise<ChatModelProvider>;
}

const askArgs = z
  .object({
    question: z.string(),
    'course-id': courseIdListSchema,
    'selected-course-id': courseIdListSchema.optional(),
    excerpts: z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .strict();

/** The development command's caller; real user identities arrive with Entra SSO (phase 13). */
const CLI_USER_ID = 'cli-operator';

export function describeAskFailure(error: unknown): FailureReport | undefined {
  if (error instanceof RagAuthorizationError) {
    return { status: 'error', error: { category: error.code, message: error.message } };
  }
  if (error instanceof QuestionValidationError) {
    return { status: 'error', error: { category: 'invalid_question', message: error.message } };
  }
  if (error instanceof RagRateLimitError) {
    return { status: 'error', error: { category: 'rate_limited', message: error.message } };
  }
  if (isChatModelError(error)) {
    return {
      status: 'error',
      error: {
        category: error.category,
        message: error.message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
    };
  }
  return describeFailure(error);
}

/**
 * The answer with validated citations: claims carry citation numbers, and sources come only
 * from validated citations (retrieval metadata, approved links). `--excerpts` adds the short
 * sanitised excerpt for each citation.
 */
export function renderAnswerText(answer: RagAnswer, options: { excerpts: boolean }): string {
  const lines = [
    `Status: ${answer.status}${answer.failureReason === undefined ? '' : ` (${answer.failureReason})`}`,
    '',
    formatAnswerAsText(
      { answer: answer.answer, claims: answer.claims, citations: answer.citations },
      options,
    ),
  ];
  if (answer.claims.length > 0) {
    lines.push('', 'Claims:');
    answer.claims.forEach((claim, index) => {
      const refs = claim.citationIds.map((id) => `[${String(id)}]`).join('');
      lines.push(`  ${String(index + 1)}. ${sanitizeText(claim.text, 1_000)} ${refs}`);
    });
  }
  if (answer.removedClaims > 0) {
    lines.push('', `Removed as unsupported: ${String(answer.removedClaims)} claim(s)`);
  }
  const warnings = [...answer.warnings, ...answer.modelWarnings.map((w) => `model: ${w}`)];
  if (warnings.length > 0) {
    lines.push('', `Warnings: ${warnings.map((warning) => sanitizeText(warning, 200)).join('; ')}`);
  }
  lines.push(
    '',
    `Model ${sanitizeText(answer.model, 64)}, ${String(answer.generationAttempts)} attempt(s), ${answer.retrieval === undefined ? 'no retrieval' : `${answer.retrieval.mode} retrieval of ${String(answer.retrieval.returned)} chunks, ${String(answer.sources.length)} given to the model`}, ${String(answer.durationMs)} ms`,
  );
  return redactString(lines.join('\n'));
}

/** Builds the answer engine from validated configuration (variable names only on failure). */
export async function openRagService(
  dependencies: AskCommandDependencies,
  logger: Logger,
): Promise<{ rag: RagService; tenantId: string }> {
  const chatSettings = loadConfig(chatConfigSchema, dependencies.env);
  // Answers always use hybrid retrieval, so embeddings are required here.
  const { service: retrieval, tenantId } = await openRetrieval(dependencies, logger, {
    requireEmbeddings: true,
  });
  const model = await (
    dependencies.createChat ??
    ((settings: ChatConfig, log: Logger) => createChatProvider(settings, { logger: log }))
  )(chatSettings, logger);
  const rag = new RagService({
    normalizer: new QuestionNormalizer(chatSettings.RAG_MAX_QUESTION_CHARS),
    orchestrator: new RetrievalOrchestrator({
      retrieval,
      minSupportingChunks: chatSettings.RAG_MIN_SUPPORTING_CHUNKS,
      minTopRerankerScore: chatSettings.RAG_MIN_TOP_RERANKER_SCORE,
    }),
    promptBuilder: new PromptBuilder(chatSettings.RAG_MAX_CONTEXT_TOKENS),
    generator: new GroundedAnswerGenerator({
      model,
      maxOutputTokens: chatSettings.CHAT_MAX_OUTPUT_TOKENS,
      maxAnswerChars: chatSettings.RAG_MAX_ANSWER_CHARS,
      logger,
    }),
    modelName: model.getModelName(),
    supportChecker: new AnswerSupportChecker({ excerptChars: chatSettings.CITATION_EXCERPT_CHARS }),
    allowedHosts: resolveAllowedHosts(
      chatSettings.CITATION_ALLOWED_HOSTS,
      dependencies.env['MOODLE_BASE_URL'],
    ),
    logger,
  });
  return { rag, tenantId };
}

export function createAskCommand(dependencies: AskCommandDependencies): CommandDefinition {
  return {
    description:
      'Answer a question from authorised E-Hub content with validated citations --question <text> --course-id <id[,id]> [--selected-course-id <id[,id]>] [--excerpts] [--json].',
    run: (context) =>
      withErrorHandling(
        context,
        'Question',
        async () => {
          const args = parseCommandArgs(
            context.args,
            {
              question: 'string',
              'course-id': 'string[]',
              'selected-course-id': 'string[]',
              excerpts: 'boolean',
              json: 'boolean',
            },
            askArgs,
          );
          const { rag, tenantId } = await openRagService(dependencies, context.logger);
          const answer = await rag.ask({
            question: args.question,
            user: {
              tenantId,
              userId: CLI_USER_ID,
              // Development command: the operator states the authorised courses. In the app
              // they come from the user's Moodle enrolments (phase 14).
              authorizedCourseIds: args['course-id'],
              ...(args['selected-course-id'] === undefined
                ? {}
                : { selectedCourseIds: args['selected-course-id'] }),
            },
          });
          context.stdout(
            args.json === true
              ? redactString(JSON.stringify(answer, null, 2))
              : renderAnswerText(answer, { excerpts: args.excerpts === true }),
          );
          return answer.status === 'failed' ? EXIT_FAILURE : EXIT_OK;
        },
        describeAskFailure,
      ),
  };
}
