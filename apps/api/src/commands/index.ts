import type { CommandDefinition } from '@ehub/shared';

import { createHealthCommand } from './health.js';

export function createApiCommands(): Readonly<Record<string, CommandDefinition>> {
  return {
    health: createHealthCommand(),
  };
}
