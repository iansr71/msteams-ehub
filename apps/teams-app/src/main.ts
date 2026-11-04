#!/usr/bin/env node
import {
  ConfigValidationError,
  createLogger,
  isLogLevelSetting,
  loadLocalEnvFile,
  runWithNewCorrelationId,
  stderrSink,
} from '@ehub/shared';

import { SERVICE_NAME, TeamsStartupError, startTeamsServer } from './server.js';

loadLocalEnvFile();

const requestedLevel = process.env['LOG_LEVEL'] ?? '';
const logger = createLogger({
  service: SERVICE_NAME,
  level: isLogLevelSetting(requestedLevel) ? requestedLevel : 'info',
  sink: stderrSink,
});

await runWithNewCorrelationId(async () => {
  try {
    const server = await startTeamsServer({ env: process.env, logger });
    process.stdout.write(
      `E-Hub Knowledge Assistant bot listening on port ${String(server.port)} (identity: ${server.identityMode}).\n`,
    );
    const stop = (): void => {
      void server.stop().then(() => {
        logger.info('Teams app stopped.');
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    if (error instanceof TeamsStartupError) {
      process.stdout.write(`${error.message}\n`);
    } else if (error instanceof ConfigValidationError) {
      process.stdout.write(
        `Configuration is missing or invalid:\n${error.issues.map((issue) => `  - ${issue.variable}: ${issue.message}`).join('\n')}\n`,
      );
    } else {
      logger.error('Teams app failed to start.', { err: error });
    }
    process.exitCode = 1;
  }
});
