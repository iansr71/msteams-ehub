import {
  EXIT_FAILURE,
  EXIT_OK,
  UsageError,
  parseCommandArgs,
  redactString,
  type CommandDefinition,
} from '@ehub/shared';
import { z } from 'zod';

import {
  AnswerEvaluationRunner,
  renderAnswerEvaluationText,
} from '../rag/answerEvaluationRunner.js';
import { MAX_EVALUATION_FILE_BYTES, parseEvaluationFile } from '../retrieval/evaluationCases.js';
import { describeAskFailure, openRagService, type AskCommandDependencies } from './askCommand.js';
import {
  InputFileError,
  commaList,
  defaultReadTextFile,
  resolveInputPath,
  withErrorHandling,
} from './retrievalCommands.js';

const answerEvaluationArgs = z
  .object({
    file: z.string().min(1),
    case: commaList.pipe(z.array(z.string().min(1).max(64)).min(1).max(2000)).optional(),
    json: z.boolean().optional(),
  })
  .strict();

/**
 * `pnpm evaluation answers`: asks every case through the full answer engine. A case fails if an
 * answer is returned without a valid source (unless it is the explicit insufficient-evidence
 * response), cites an unauthorised course or a forbidden resource, or misses its expectations.
 * Output holds statuses and IDs only, never questions or answers.
 */
export function createAnswerEvaluationCommand(
  dependencies: AskCommandDependencies,
): CommandDefinition {
  return {
    description:
      'Run evaluation cases through the answer engine --file <path> [--case <id[,id]>] [--json]. Exit 1 if any case fails.',
    run: (context) =>
      withErrorHandling(
        context,
        'Answer evaluation',
        async () => {
          const args = parseCommandArgs(
            context.args,
            { file: 'string', case: 'string[]', json: 'boolean' },
            answerEvaluationArgs,
          );
          const text = await (dependencies.readTextFile ?? defaultReadTextFile)(
            resolveInputPath(dependencies, args.file),
            MAX_EVALUATION_FILE_BYTES,
          ).catch((error: unknown) => {
            throw error instanceof InputFileError
              ? error
              : new InputFileError('The file could not be read.');
          });
          let cases = parseEvaluationFile(text);
          if (args.case !== undefined) {
            const wanted = new Set(args.case);
            cases = cases.filter((testCase) => wanted.has(testCase.id));
            if (cases.length === 0) {
              throw new UsageError('--case: no case in the file has that ID.');
            }
          }
          const { rag, tenantId } = await openRagService(dependencies, context.logger);
          const report = await new AnswerEvaluationRunner({
            answerer: rag,
            tenantId,
            describeError: (error) =>
              describeAskFailure(error)?.error.message ?? 'Unexpected error.',
          }).run(cases);
          context.logger.info('Answer evaluation completed.', { ...report.summary });
          context.stdout(
            args.json === true
              ? redactString(JSON.stringify(report, null, 2))
              : renderAnswerEvaluationText(report),
          );
          return report.summary.failed === 0 ? EXIT_OK : EXIT_FAILURE;
        },
        describeAskFailure,
      ),
  };
}
