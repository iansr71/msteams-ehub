import type { CommandDefinition, EnvironmentSource } from '@ehub/shared';

import { createAnswerEvaluationCommand } from './answerEvaluationCommand.js';
import { createAskCommand, type AskCommandDependencies } from './askCommand.js';
import { createDiagnoseCommand, type DiagnoseDependencies } from './diagnoseCommand.js';
import { createHealthCommand } from './health.js';
import { createPreflightCommand, type PreflightDependencies } from './preflightCommand.js';
import { createServeCommand, type ServeCommandDependencies } from './serveCommand.js';
import {
  createRetrievalEvaluationCommand,
  createRetrieveCommand,
  type RetrievalCommandDependencies,
} from './retrievalCommands.js';

export interface ApiCommandDependencies {
  readonly env?: EnvironmentSource;
  readonly retrieval?: RetrievalCommandDependencies;
  readonly ask?: AskCommandDependencies;
  readonly serve?: ServeCommandDependencies;
  readonly diagnose?: DiagnoseDependencies;
  readonly preflight?: PreflightDependencies;
}

export function createApiCommands(
  dependencies: ApiCommandDependencies = {},
): Readonly<Record<string, CommandDefinition>> {
  const env = dependencies.env ?? process.env;
  const retrieval = dependencies.retrieval ?? { env };
  return {
    health: createHealthCommand(env),
    retrieve: createRetrieveCommand(retrieval),
    ask: createAskCommand(dependencies.ask ?? retrieval),
    serve: createServeCommand(dependencies.serve ?? dependencies.ask ?? retrieval),
    diagnose: createDiagnoseCommand(dependencies.diagnose ?? dependencies.ask ?? retrieval),
    preflight: createPreflightCommand(
      dependencies.preflight ?? dependencies.diagnose ?? dependencies.ask ?? retrieval,
    ),
  };
}

/** Commands behind `pnpm evaluation`. */
export function createEvaluationCommands(
  dependencies: ApiCommandDependencies = {},
): Readonly<Record<string, CommandDefinition>> {
  const env = dependencies.env ?? process.env;
  return {
    retrieval: createRetrievalEvaluationCommand(dependencies.retrieval ?? { env }),
    answers: createAnswerEvaluationCommand(dependencies.ask ?? dependencies.retrieval ?? { env }),
  };
}
