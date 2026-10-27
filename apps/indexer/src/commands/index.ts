import type { CommandDefinition } from '@ehub/shared';

import { createExtractTestCommand } from './extractCommand.js';
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
  const moodle = dependencies.moodle ?? { env };
  return {
    health: createHealthCommand(env),
    ...createMoodleCommands(moodle),
    'extract:test': createExtractTestCommand(moodle),
  };
}
