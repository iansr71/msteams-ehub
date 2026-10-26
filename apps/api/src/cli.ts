#!/usr/bin/env node
import {
  createLogger,
  isLogLevelSetting,
  loadLocalEnvFile,
  runCommandLine,
  stderrSink,
} from '@ehub/shared';

import { createApiCommands } from './commands/index.js';
import { SERVICE_NAME } from './commands/health.js';

loadLocalEnvFile();

// Read directly rather than through validated config: the health command must still be able
// to run (and report the problem) when the runtime configuration is invalid.
const requestedLevel = process.env['LOG_LEVEL'] ?? '';

const logger = createLogger({
  service: SERVICE_NAME,
  level: isLogLevelSetting(requestedLevel) ? requestedLevel : 'info',
  sink: stderrSink,
});

process.exitCode = await runCommandLine({
  programName: 'pnpm api',
  commands: createApiCommands(),
  argv: process.argv.slice(2),
  logger,
  stdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});
