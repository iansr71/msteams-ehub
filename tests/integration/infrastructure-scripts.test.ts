import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { findProviderParameters } from '../../infrastructure/scripts/lib/find-provider-params.mjs';

/*
 * Runs the real deployment scripts (bash and PowerShell) against a fake `az` that records every
 * call and answers from a scenario, so the order of operations, the stops and the retries are
 * tested without Azure. PowerShell runs when pwsh is on PATH or EHUB_PWSH points at it.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url));
const scripts = join(repo, 'infrastructure', 'scripts');
const fakeAz = fileURLToPath(new URL('./__fixtures__/fakeAz.mjs', import.meta.url));

function findPwsh(): string | undefined {
  for (const candidate of [process.env['EHUB_PWSH'], 'pwsh']) {
    if (
      candidate !== undefined &&
      spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0']).status === 0
    ) {
      return candidate;
    }
  }
  return undefined;
}
const pwsh = findPwsh();
const bash = spawnSync('bash', ['-c', 'exit 0']).status === 0 ? 'bash' : undefined;

const VALID_ENV: Record<string, string> = {
  EHUB_SUBSCRIPTION_ID: '11111111-2222-4333-8444-555555555555',
  EHUB_RESOURCE_GROUP: 'rg-ehub-test',
  EHUB_LOCATION: 'southafricanorth',
  EHUB_NAME_PREFIX: 'ehub',
  EHUB_OPENAI_ACCOUNT_NAME: 'pilot-openai',
  EHUB_OPENAI_RESOURCE_GROUP: 'rg-ai',
  EHUB_OPENAI_ENDPOINT: 'https://pilot-openai.openai.azure.com',
  EHUB_OPENAI_CHAT_DEPLOYMENT: 'chat',
  EHUB_OPENAI_EMBEDDING_DEPLOYMENT: 'embedding',
  EHUB_EMBEDDING_DIMENSIONS: '1536',
  EHUB_MOODLE_BASE_URL: 'https://ehub.pilot.invalid',
  EHUB_SYNC_COURSE_IDS: '12,15',
  EHUB_ENTRA_API_CLIENT_ID: '22222222-3333-4444-8555-666666666666',
  EHUB_BOT_CLIENT_ID: '33333333-4444-4555-8666-777777777777',
  EHUB_DEPLOYER_OBJECT_ID: '44444444-5555-4666-8777-888888888888',
  EHUB_NODE_IMAGE: 'node:22-bookworm-slim@sha256:abc',
};

const OUTPUTS: Record<string, string> = {
  registryName: 'crehubtestabc',
  registryLoginServer: 'crehubtestabc.azurecr.io',
  keyVaultName: 'kv-ehub-test-abc',
  storageAccountName: 'stehubtestabc',
  apiAppName: 'ca-ehub-test-api',
  botAppName: 'ca-ehub-test-bot',
  botServiceName: 'bot-ehub-test-abc',
  apiUrl: 'https://ca-ehub-test-api.example.azurecontainerapps.io',
  botMessagingEndpoint: 'https://ca-ehub-test-bot.example.azurecontainerapps.io/api/messages',
  outboundIp: 'not fixed (no virtual network)',
};

interface Rule {
  readonly args: readonly string[];
  readonly responses: readonly { stdout?: string; stderr?: string; exit?: number }[];
}

interface Call {
  readonly args: string[];
  readonly env: { EHUB_DEPLOY_APPS: string | null; EHUB_IMAGE_TAG: string | null };
}

const outputRules: Rule[] = Object.entries(OUTPUTS).map(([name, value]) => ({
  args: ['deployment', 'group', 'show', `properties.outputs.${name}.value`],
  responses: [{ stdout: value }],
}));
const ALL_SECRETS: Rule = {
  args: ['keyvault', 'secret', 'list'],
  responses: [{ stdout: 'appinsights-connection-string\nmoodle-token\nteams-bot-client-secret' }],
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function envFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

type Shell = 'bash' | 'pwsh';

function run(
  shell: Shell,
  script: string,
  args: readonly string[],
  options: { rules?: readonly Rule[]; env?: Record<string, string>; envFileText?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ehub-scripts-'));
  directories.push(dir);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(
    join(bin, 'az'),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${fakeAz}" "$@"\n`,
  );
  chmodSync(join(bin, 'az'), 0o755);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ rules: options.rules ?? [] }));
  writeFileSync(join(dir, 'az.log'), '');
  const file = join(dir, 'environment.env');
  writeFileSync(file, options.envFileText ?? envFile({ ...VALID_ENV, ...options.env }));

  const command =
    shell === 'bash'
      ? ['bash', join(scripts, `${script}.sh`), ...args]
      : [
          pwsh ?? 'pwsh',
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(scripts, `${script}.ps1`),
          ...args,
        ];
  const result = spawnSync(command[0] ?? 'bash', command.slice(1), {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      HOME: dir,
      EHUB_ENV_FILE: file,
      FAKE_AZ_SCENARIO: join(dir, 'scenario.json'),
      FAKE_AZ_LOG: join(dir, 'az.log'),
      EHUB_RETRY_DELAY_SECONDS: '0',
    },
  });
  const calls = readFileSync(join(dir, 'az.log'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

const has = (call: Call, ...parts: string[]) => parts.every((part) => call.args.includes(part));
const find = (calls: readonly Call[], ...parts: string[]) =>
  calls.filter((call) => has(call, ...parts));

/** Bash and PowerShell spell options differently; the scenarios are the same. */
const flags = {
  bash: {
    deploy: (env: string, stage: string, tag: string) => [
      env,
      '--stage',
      stage,
      '--image-tag',
      tag,
    ],
    yes: '--yes',
    rollbackTo: (env: string, tag: string) => [env, '--to-tag', tag],
    whatIfApps: (env: string) => [env, '--stage', 'apps'],
  },
  pwsh: {
    deploy: (env: string, stage: string, tag: string) => [
      '-Environment',
      env,
      '-Stage',
      stage,
      '-ImageTag',
      tag,
    ],
    yes: '-Yes',
    rollbackTo: (env: string, tag: string) => ['-Environment', env, '-ToTag', tag],
    whatIfApps: (env: string) => ['-Environment', env, '-Stage', 'apps'],
  },
};

const shells: [Shell, boolean][] = [
  ['bash', bash !== undefined],
  ['pwsh', pwsh !== undefined],
];

for (const [shell, available] of shells) {
  describe.skipIf(!available)(`deployment scripts (${shell})`, () => {
    const f = flags[shell];
    const envArg = (env: string) => (shell === 'bash' ? [env] : ['-Environment', env]);

    it('refuses an environment file that still has placeholder values', () => {
      const text = readFileSync(
        join(repo, 'infrastructure', 'environments', 'test.env.example'),
        'utf8',
      );
      const result = run(shell, 'deploy', f.deploy('test', 'foundation', 'abc'), {
        envFileText: text,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/placeholder value|must be a GUID/);
      expect(result.calls).toEqual([]);
    });

    it('refuses the all-zero placeholder GUID even when everything else is valid', () => {
      const result = run(shell, 'deploy', f.deploy('test', 'foundation', 'abc'), {
        env: { EHUB_SUBSCRIPTION_ID: '00000000-0000-0000-0000-000000000000' },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('EHUB_SUBSCRIPTION_ID is still the placeholder value');
      expect(result.calls).toEqual([]);
    });

    it('refuses a malformed ID and a non-https URL', () => {
      for (const [env, message] of [
        [{ EHUB_BOT_CLIENT_ID: 'not-a-guid' }, 'EHUB_BOT_CLIENT_ID must be a GUID'],
        [
          { EHUB_MOODLE_BASE_URL: 'http://ehub.pilot.invalid' },
          'EHUB_MOODLE_BASE_URL must be an https URL',
        ],
        [{ EHUB_SYNC_COURSE_IDS: '12;15' }, 'EHUB_SYNC_COURSE_IDS must be comma-separated'],
      ] as const) {
        const result = run(shell, 'deploy', f.deploy('test', 'foundation', 'abc'), { env });
        expect(result.status, message).not.toBe(0);
        expect(result.stderr).toContain(message);
      }
    });

    it('never runs anything written in the environment file', () => {
      const marker = join(tmpdir(), `ehub-injection-${String(process.pid)}-${shell}`);
      const text = `${envFile(VALID_ENV)}\nEHUB_RESOURCE_GROUP=$(touch ${marker})\n`;
      run(shell, 'deploy', f.deploy('test', 'foundation', 'abc'), {
        envFileText: text,
        rules: outputRules,
      });
      expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
    });

    it('rejects lines that are not EHUB_ settings', () => {
      const result = run(shell, 'deploy', f.deploy('test', 'foundation', 'abc'), {
        envFileText: `${envFile(VALID_ENV)}\nPATH=/tmp/evil\n`,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected EHUB_NAME=value');
    });

    it('deploys the foundation, builds the image, then the services, in that order', () => {
      const result = run(shell, 'deploy', f.deploy('test', 'all', 'abc123'), {
        rules: [...outputRules, ALL_SECRETS],
      });
      expect(result.stderr).toContain('Deployed.');
      expect(result.status).toBe(0);
      const creates = find(result.calls, 'deployment', 'group', 'create');
      expect(
        creates.map((call) => [
          call.args[call.args.indexOf('--name') + 1],
          call.env.EHUB_DEPLOY_APPS,
          call.env.EHUB_IMAGE_TAG,
        ]),
      ).toEqual([
        ['ehub-test-foundation', 'false', ''],
        ['ehub-test-apps', 'true', 'abc123'],
      ]);
      const order = result.calls.map((call) => call.args.slice(0, 3).join(' '));
      const index = (prefix: string) => order.findIndex((entry) => entry.startsWith(prefix));
      expect(index('group create')).toBeLessThan(index('deployment group create'));
      expect(index('keyvault secret list')).toBeLessThan(index('acr build'));
      expect(index('acr build')).toBeLessThan(order.lastIndexOf('deployment group create'));
      const build = find(result.calls, 'acr', 'build')[0];
      expect(build?.args).toEqual(
        expect.arrayContaining([
          '--registry',
          'crehubtestabc',
          '--image',
          'ehub:abc123',
          'NODE_IMAGE=node:22-bookworm-slim@sha256:abc',
        ]),
      );
      expect(find(result.calls, 'account', 'set')[0]?.args).toContain(
        VALID_ENV['EHUB_SUBSCRIPTION_ID'],
      );
    });

    it('stops before building or deploying services when an operator secret is missing', () => {
      const result = run(shell, 'deploy', f.deploy('test', 'apps', 'abc123'), {
        rules: [
          ...outputRules,
          {
            args: ['keyvault', 'secret', 'list'],
            responses: [{ stdout: 'appinsights-connection-string\nmoodle-token' }],
          },
        ],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('teams-bot-client-secret');
      expect(result.stderr).toContain('--file');
      expect(find(result.calls, 'acr', 'build')).toEqual([]);
      expect(find(result.calls, 'deployment', 'group', 'create')).toEqual([]);
    });

    it('retries the services stage once, and gives up after a second failure', () => {
      const retried = run(shell, 'deploy', f.deploy('test', 'apps', 'abc123'), {
        rules: [
          ...outputRules,
          ALL_SECRETS,
          { args: ['deployment', 'group', 'create'], responses: [{ exit: 1 }, { exit: 0 }] },
        ],
      });
      expect(retried.status).toBe(0);
      expect(find(retried.calls, 'deployment', 'group', 'create')).toHaveLength(2);

      const failed = run(shell, 'deploy', f.deploy('test', 'apps', 'abc123'), {
        rules: [
          ...outputRules,
          ALL_SECRETS,
          { args: ['deployment', 'group', 'create'], responses: [{ exit: 1 }] },
        ],
      });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain('failed twice');
      expect(find(failed.calls, 'deployment', 'group', 'create')).toHaveLength(2);
    });

    it('refuses to change production without confirmation', () => {
      const result = run(shell, 'deploy', f.deploy('prod', 'foundation', 'abc123'), {
        rules: outputRules,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Refusing to deploy to production/);
      expect(find(result.calls, 'group', 'create')).toEqual([]);
      expect(find(result.calls, 'deployment', 'group', 'create')).toEqual([]);
      const confirmed = run(shell, 'deploy', [...f.deploy('prod', 'foundation', 'abc123'), f.yes], {
        rules: outputRules,
      });
      expect(confirmed.status).toBe(0);
    });

    it('rolls back to the most recent different image, including after an earlier rollback', () => {
      const registry = OUTPUTS['registryLoginServer'] ?? '';
      const result = run(shell, 'rollback', envArg('test'), {
        rules: [
          ...outputRules,
          { args: ['containerapp', 'show'], responses: [{ stdout: `${registry}/ehub:aaa` }] },
          {
            args: ['containerapp', 'revision', 'list'],
            // Newest first: current aaa, then bbb, an older aaa (from an earlier rollback) and ccc.
            // The target is bbb: the most recent different image, not the oldest.
            responses: [
              {
                stdout: `${registry}/ehub:aaa\n${registry}/ehub:bbb\n${registry}/ehub:aaa\n${registry}/ehub:ccc`,
              },
            ],
          },
          {
            args: ['containerapp', 'job', 'list'],
            responses: [{ stdout: 'caj-ehub-test-sync\ncaj-ehub-test-enrolments' }],
          },
        ],
      });
      expect(result.stderr).toContain('Target:  crehubtestabc.azurecr.io/ehub:bbb');
      expect(result.status).toBe(0);
      const updates = result.calls.filter((call) => call.args.includes('update'));
      expect(updates.map((call) => call.args[call.args.indexOf('--name') + 1])).toEqual([
        'ca-ehub-test-api',
        'ca-ehub-test-bot',
        'caj-ehub-test-sync',
        'caj-ehub-test-enrolments',
      ]);
      for (const update of updates) expect(update.args).toContain(`${registry}/ehub:bbb`);
    });

    it('refuses a rollback tag that is not in the registry', () => {
      const result = run(shell, 'rollback', f.rollbackTo('test', 'missing'), {
        rules: [
          ...outputRules,
          {
            args: ['containerapp', 'show'],
            responses: [{ stdout: 'crehubtestabc.azurecr.io/ehub:aaa' }],
          },
          { args: ['acr', 'repository', 'show-tags'], responses: [{ stdout: 'aaa\nbbb' }] },
        ],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('missing is not in');
      expect(result.calls.filter((call) => call.args.includes('update'))).toEqual([]);
    });

    it('what-if for the services uses the image the API runs now', () => {
      const result = run(shell, 'what-if', f.whatIfApps('test'), {
        rules: [
          ...outputRules,
          {
            args: ['containerapp', 'show'],
            responses: [{ stdout: 'crehubtestabc.azurecr.io/ehub:live42' }],
          },
        ],
      });
      expect(result.status).toBe(0);
      const whatIf = find(result.calls, 'deployment', 'group', 'what-if');
      expect(whatIf.map((call) => call.env)).toEqual([
        { EHUB_DEPLOY_APPS: 'true', EHUB_IMAGE_TAG: 'live42' },
      ]);
    });

    it('configures SSO with the provider keys the service reports and replaces an old connection', () => {
      const result = run(shell, 'configure-bot-sso', envArg('test'), {
        rules: [
          ...outputRules,
          {
            args: ['account', 'show', 'tenantId'],
            responses: [{ stdout: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
          },
          {
            args: ['bot', 'authsetting', 'list-providers'],
            responses: [
              {
                stdout: JSON.stringify({
                  properties: {
                    parameters: [
                      { name: 'clientId' },
                      { name: 'tenantID' },
                      { name: 'tokenExchangeUrl' },
                    ],
                  },
                }),
              },
            ],
          },
          { args: ['keyvault', 'secret', 'show'], responses: [{ stdout: 'bot-secret-value' }] },
        ],
      });
      expect(result.stderr).toContain('OAuth connection ehub-sso created');
      expect(result.status).toBe(0);
      expect(find(result.calls, 'bot', 'authsetting', 'delete')).toHaveLength(1);
      const create = find(result.calls, 'bot', 'authsetting', 'create')[0];
      expect(create?.args).toEqual(
        expect.arrayContaining([
          '--service',
          'Aadv2',
          '--client-id',
          VALID_ENV['EHUB_BOT_CLIENT_ID'],
          '--provider-scope-string',
          `api://${VALID_ENV['EHUB_ENTRA_API_CLIENT_ID'] ?? ''}/access_as_user`,
          'tenantID=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          `tokenExchangeUrl=api://botid-${VALID_ENV['EHUB_BOT_CLIENT_ID'] ?? ''}`,
        ]),
      );
      expect(result.stdout + result.stderr).not.toContain('bot-secret-value');
    });

    it('stops SSO setup when the provider keys cannot be found', () => {
      const result = run(shell, 'configure-bot-sso', envArg('test'), {
        rules: [
          ...outputRules,
          {
            args: ['account', 'show', 'tenantId'],
            responses: [{ stdout: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
          },
          {
            args: ['bot', 'authsetting', 'list-providers'],
            responses: [
              { stdout: JSON.stringify({ properties: { parameters: [{ name: 'clientId' }] } }) },
            ],
          },
        ],
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('portal');
      expect(find(result.calls, 'bot', 'authsetting', 'create')).toEqual([]);
    });
  });
}

describe('findProviderParameters', () => {
  it.each([
    [{ properties: { parameters: [{ name: 'tenantID' }, { name: 'tokenExchangeUrl' }] } }],
    [[{ properties: { parameters: [{ key: 'TenantId' }, { key: 'TokenExchangeUrl' }] } }]],
    [
      {
        value: {
          serviceProvider: { parameters: [{ name: 'tenant_id' }, { name: 'token-exchange-url' }] },
        },
      },
    ],
  ])('finds the keys in %j', (json) => {
    const found = findProviderParameters(json);
    expect(found.tenant).toMatch(/^tenant/i);
    expect(found.exchange).toMatch(/^token/i);
  });

  it('does not guess from similar names', () => {
    expect(
      findProviderParameters({ parameters: [{ name: 'tenantName' }, { name: 'exchangeToken' }] }),
    ).toEqual({
      tenant: undefined,
      exchange: undefined,
    });
  });
});
