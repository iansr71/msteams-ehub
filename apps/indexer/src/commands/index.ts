import type { CommandDefinition } from '@ehub/shared';

import { createChunkTestCommand } from './chunkCommand.js';
import { createEmbeddingCommands } from './embeddingCommands.js';
import type { EmbeddingCommandDependencies } from './embeddingServices.js';
import { createExtractTestCommand } from './extractCommand.js';
import { createHealthCommand } from './health.js';
import { createMoodleCommands } from './moodleCommands.js';
import type { MoodleCommandDependencies } from './moodleServices.js';
import { createSearchCommands, type SearchCommandDependencies } from './searchCommands.js';
import { createSyncCommands } from './syncCommands.js';
import type { SyncCommandDependencies } from './syncServices.js';

export interface IndexerCommandDependencies {
  readonly moodle?: MoodleCommandDependencies;
  readonly search?: SearchCommandDependencies;
  readonly embeddings?: EmbeddingCommandDependencies;
  readonly sync?: SyncCommandDependencies;
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
    'chunk:test': createChunkTestCommand(moodle, dependencies.embeddings ?? { env }),
    ...createSearchCommands(dependencies.search ?? { env }),
    ...createEmbeddingCommands(dependencies.embeddings ?? { env }),
    ...createSyncCommands(dependencies.sync ?? { env }),
  };
}
