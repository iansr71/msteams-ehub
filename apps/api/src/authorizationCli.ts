#!/usr/bin/env node
import {
  createLogger,
  isLogLevelSetting,
  loadLocalEnvFile,
  runCommandLine,
  stderrSink,
} from '@ehub/shared';

import { createAuthorizationCommands } from './commands/authorizationCommands.js';
import { SERVICE_NAME } from './commands/health.js';

loadLocalEnvFile();

const requestedLevel = process.env['LOG_LEVEL'] ?? '';

const logger = createLogger({
  service: SERVICE_NAME,
  level: isLogLevelSetting(requestedLevel) ? requestedLevel : 'info',
  sink: stderrSink,
});

process.exitCode = await runCommandLine({
  programName: 'pnpm authorization',
  commands: createAuthorizationCommands({ env: process.env }),
  argv: process.argv.slice(2),
  logger,
  stdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});
