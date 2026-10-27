import type { CommandDefinition } from '@ehub/shared';

import { createHealthCommand } from './health.js';
import { createMoodleCommands } from './moodleCommands.js';
import type { MoodleCommandDependencies } from './moodleServices.js';

export interface IndexerCommandDependencies {
  readonly moodle?: MoodleCommandDependencies;
}

export function createIndexerCommands(
  dependencies: IndexerCommandDependencies = {},
): Readonly<Record<string, CommandDefinition>> {
  const env = dependencies.moodle?.env ?? process.env;
  return {
    health: createHealthCommand(env),
    ...createMoodleCommands(dependencies.moodle ?? { env }),
  };
}
