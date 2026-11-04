import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { PRODUCTION_BLOCKED_MESSAGE, createServeCommand } from './serveCommand.js';

async function run(env: Record<string, string>): Promise<{ exitCode: number; stdout: string }> {
  const output: string[] = [];
  const context: CommandContext = {
    args: [],
    logger: createLogger({ service: 'test', level: 'silent' }),
    stdout: (text) => output.push(text),
  };
  const exitCode = await createServeCommand({
    env,
    waitForShutdown: () => Promise.resolve(),
  }).run(context);
  return { exitCode, stdout: output.join('\n') };
}

describe('pnpm api serve', () => {
  it('refuses to run in production until Entra SSO exists', async () => {
    const result = await run({ NODE_ENV: 'production' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(PRODUCTION_BLOCKED_MESSAGE);
  });

  it('refuses the mock identity outside development and without courses', async () => {
    const test = await run({
      NODE_ENV: 'test',
      API_DEV_MOCK_IDENTITY: 'true',
      API_DEV_MOCK_COURSE_IDS: '12',
    });
    expect(test.exitCode).toBe(1);
    expect(test.stdout).toContain('API_DEV_MOCK_IDENTITY');
    const noCourses = await run({ NODE_ENV: 'development', API_DEV_MOCK_IDENTITY: 'true' });
    expect(noCourses.stdout).toContain('API_DEV_MOCK_COURSE_IDS');
    const badUser = await run({
      NODE_ENV: 'development',
      API_DEV_MOCK_IDENTITY: 'true',
      API_DEV_MOCK_COURSE_IDS: '12',
      API_DEV_MOCK_USER_ID: 'real.person@example.com',
    });
    expect(badUser.stdout).toContain('dev-mock-');
  });
});
