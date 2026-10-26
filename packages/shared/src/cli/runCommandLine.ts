import { getCorrelationId, runWithNewCorrelationId } from '../correlation/correlation.js';
import type { Logger } from '../logging/logger.js';

export interface CommandContext {
  readonly args: readonly string[];
  readonly logger: Logger;
  readonly stdout: (text: string) => void;
}

export interface CommandDefinition {
  readonly description: string;
  /** Returns the process exit code. */
  readonly run: (context: CommandContext) => Promise<number>;
}

export interface CommandLineOptions {
  readonly programName: string;
  readonly commands: Readonly<Record<string, CommandDefinition>>;
  readonly argv: readonly string[];
  readonly logger: Logger;
  readonly stdout: (text: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

function usage(options: CommandLineOptions): string {
  const lines = Object.entries(options.commands).map(
    ([name, command]) => `  ${name.padEnd(24)} ${command.description}`,
  );
  return [`Usage: ${options.programName} <command> [options]`, '', 'Commands:', ...lines].join(
    '\n',
  );
}

/**
 * Dispatches a CLI command inside its own correlation context. Unexpected errors are logged
 * through the (redacting) logger and converted to exit code 1; raw error text is never
 * written to stdout.
 */
export async function runCommandLine(options: CommandLineOptions): Promise<number> {
  const [commandName, ...args] = options.argv;

  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    options.stdout(usage(options));
    return commandName === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const command = Object.hasOwn(options.commands, commandName)
    ? options.commands[commandName]
    : undefined;
  if (command === undefined) {
    options.stdout(`Unknown command: ${commandName.slice(0, 64)}\n\n${usage(options)}`);
    return EXIT_USAGE;
  }

  return runWithNewCorrelationId(async () => {
    const logger = options.logger.child({ command: commandName });
    logger.debug('Command started.');
    try {
      const exitCode = await command.run({ args, logger, stdout: options.stdout });
      logger.debug('Command finished.', { exitCode });
      return exitCode;
    } catch (error) {
      logger.error('Command failed.', { err: error });
      options.stdout(
        JSON.stringify({ status: 'error', correlationId: getCorrelationId() ?? null }, null, 2),
      );
      return EXIT_FAILURE;
    }
  });
}
