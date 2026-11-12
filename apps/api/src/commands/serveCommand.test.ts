import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { PRODUCTION_REQUIREMENTS_MESSAGE, createServeCommand } from './serveCommand.js';

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
  it('refuses production without both Entra sign-in and Moodle course authorisation', async () => {
    const entra = {
      ENTRA_API_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
      ENTRA_ALLOWED_CLIENT_APP_IDS: '44444444-4444-4444-8444-444444444444',
    };
    for (const env of [
      { NODE_ENV: 'production' },
      { NODE_ENV: 'production', ...entra },
      { NODE_ENV: 'production', MOODLE_TOKEN: 'moodle-token-0123456789' },
      // A mock identity never substitutes for either.
      {
        NODE_ENV: 'production',
        API_DEV_MOCK_IDENTITY: 'true',
        MOODLE_TOKEN: 'moodle-token-0123456789',
      },
    ]) {
      const result = await run(env);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe(PRODUCTION_REQUIREMENTS_MESSAGE);
    }
  });

  it('refuses to start in production when a production control is wrong', async () => {
    // Entra and Moodle authorisation are configured, so this gets past the first guard and is
    // refused by the production startup validation instead.
    const configured = {
      NODE_ENV: 'production',
      ENTRA_API_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
      ENTRA_API_APP_ID_URI: 'api://33333333-3333-4333-8333-333333333333',
      ENTRA_ALLOWED_CLIENT_APP_IDS: '44444444-4444-4444-8444-444444444444',
      MOODLE_BASE_URL: 'https://ehub.example.test',
      MOODLE_TOKEN: 'moodle-token-0123456789',
      AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
      AZURE_TENANT_ID: '55555555-5555-4555-8555-555555555555',
      AZURE_OPENAI_ENDPOINT: 'https://openai.example.test',
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
      AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
    };
    const unauthenticated = await run({
      ...configured,
      TEAMS_DEV_ALLOW_UNAUTHENTICATED: 'true',
    });
    expect(unauthenticated.exitCode).toBe(1);
    expect(unauthenticated.stdout).toContain('TEAMS_DEV_ALLOW_UNAUTHENTICATED');

    const wrongAudience = await run({
      ...configured,
      TEAMS_SSO_RESOURCE: 'api://someone-else',
    });
    expect(wrongAudience.exitCode).toBe(1);
    expect(wrongAudience.stdout).toContain('entra.ssoResource');
  });

  it('refuses a mock identity without courses or with a real-looking user ID', async () => {
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
