import { describe, expect, it } from 'vitest';

import { getCorrelationId } from '../correlation/correlation.js';
import { createLogger } from '../logging/logger.js';
import { clearRegisteredSecretValues, registerSecretValue } from '../logging/redaction.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  runCommandLine,
  type CommandDefinition,
} from './runCommandLine.js';

function harness(commands: Record<string, CommandDefinition>, argv: string[]) {
  const stdout: string[] = [];
  const logLines: string[] = [];
  const logger = createLogger({
    service: 'cli-test',
    level: 'debug',
    sink: { write: (line) => logLines.push(line) },
  });
  const run = () =>
    runCommandLine({
      programName: 'test-cli',
      commands,
      argv,
      logger,
      stdout: (text) => stdout.push(text),
    });
  return { run, stdout, logLines };
}

const ok: CommandDefinition = {
  description: 'Succeeds.',
  run: ({ stdout }) => {
    stdout('done');
    return Promise.resolve(EXIT_OK);
  },
};

describe('runCommandLine', () => {
  it('prints usage and returns a usage error when no command is given', async () => {
    const { run, stdout } = harness({ ok }, []);
    expect(await run()).toBe(EXIT_USAGE);
    expect(stdout.join('\n')).toContain('Usage: test-cli <command>');
    expect(stdout.join('\n')).toContain('ok');
  });

  it('prints usage successfully for help', async () => {
    const { run } = harness({ ok }, ['--help']);
    expect(await run()).toBe(EXIT_OK);
  });

  it('rejects unknown commands, including prototype keys', async () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
      const { run, stdout } = harness({ ok }, [name]);
      expect(await run()).toBe(EXIT_USAGE);
      expect(stdout[0]).toContain('Unknown command');
    }
  });

  it('runs a command inside a fresh correlation context and passes arguments', async () => {
    let seenId: string | undefined;
    let seenArgs: readonly string[] = [];
    const { run, logLines } = harness(
      {
        capture: {
          description: 'Captures context.',
          run: ({ args }) => {
            seenId = getCorrelationId();
            seenArgs = args;
            return Promise.resolve(EXIT_OK);
          },
        },
      },
      ['capture', '--flag', 'value'],
    );

    expect(await run()).toBe(EXIT_OK);
    expect(seenId).toBeDefined();
    expect(seenArgs).toEqual(['--flag', 'value']);
    expect(getCorrelationId()).toBeUndefined();
    const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.every((record) => record['correlationId'] === seenId)).toBe(true);
    expect(records.every((record) => record['command'] === 'capture')).toBe(true);
  });

  it('converts thrown errors into a redacted log and a sanitized result', async () => {
    const secret = 'fake-moodle-token-0123456789abcdef';
    registerSecretValue(secret);
    try {
      const { run, stdout, logLines } = harness(
        {
          explode: {
            description: 'Throws.',
            run: () => Promise.reject(new Error(`request failed: ?wstoken=${secret}`)),
          },
        },
        ['explode'],
      );

      expect(await run()).toBe(EXIT_FAILURE);
      const output = [...stdout, ...logLines].join('\n');
      expect(output).not.toContain(secret);
      expect(JSON.parse(stdout[0]!)).toMatchObject({ status: 'error' });
      expect(logLines.some((line) => line.includes('Command failed.'))).toBe(true);
    } finally {
      clearRegisteredSecretValues();
    }
  });
});
