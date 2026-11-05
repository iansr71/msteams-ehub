#!/usr/bin/env node
import {
  createLogger,
  isLogLevelSetting,
  loadLocalEnvFile,
  readPackageVersion,
  runCommandLine,
  startTelemetryFromEnv,
  stderrSink,
} from '@ehub/shared';

import { createIdentityCommands } from './commands/authorizationCommands.js';
import { SERVICE_NAME } from './commands/health.js';

loadLocalEnvFile();

const requestedLevel = process.env['LOG_LEVEL'] ?? '';

const logger = createLogger({
  service: SERVICE_NAME,
  level: isLogLevelSetting(requestedLevel) ? requestedLevel : 'info',
  sink: stderrSink,
});

const telemetry = await startTelemetryFromEnv({
  serviceName: SERVICE_NAME,
  version: readPackageVersion(new URL('../package.json', import.meta.url)),
  env: process.env,
  logger,
});

process.exitCode = await runCommandLine({
  programName: 'pnpm identity',
  commands: createIdentityCommands({ env: process.env }),
  argv: process.argv.slice(2),
  logger,
  stdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});

// Flush spans and metrics before a short-lived command exits.
await telemetry.shutdown();
