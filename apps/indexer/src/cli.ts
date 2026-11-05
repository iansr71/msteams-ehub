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

import { createIndexerCommands } from './commands/index.js';
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

const telemetry = await startTelemetryFromEnv({
  serviceName: SERVICE_NAME,
  version: readPackageVersion(new URL('../package.json', import.meta.url)),
  env: process.env,
  logger,
});

process.exitCode = await runCommandLine({
  programName: 'pnpm indexer',
  commands: createIndexerCommands(),
  argv: process.argv.slice(2),
  logger,
  stdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});

// Flush spans and metrics before a short-lived command exits.
await telemetry.shutdown();
