import type { CommandDefinition } from '@ehub/shared';

import { createHealthCommand } from './health.js';

export function createIndexerCommands(): Readonly<Record<string, CommandDefinition>> {
  return {
    health: createHealthCommand(),
  };
}
