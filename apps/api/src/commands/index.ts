import type { CommandDefinition, EnvironmentSource } from '@ehub/shared';

import { createAnswerEvaluationCommand } from './answerEvaluationCommand.js';
import { createAskCommand, type AskCommandDependencies } from './askCommand.js';
import { createHealthCommand } from './health.js';
import {
  createRetrievalEvaluationCommand,
  createRetrieveCommand,
  type RetrievalCommandDependencies,
} from './retrievalCommands.js';

export interface ApiCommandDependencies {
  readonly env?: EnvironmentSource;
  readonly retrieval?: RetrievalCommandDependencies;
  readonly ask?: AskCommandDependencies;
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
