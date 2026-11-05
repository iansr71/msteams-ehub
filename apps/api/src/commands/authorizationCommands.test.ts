import type { CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import {
  COURSE_A,
  FakeMoodle,
  TENANT,
  USER_A,
  USER_B,
  captureLogger,
  moodleUser,
} from '../authorization/__fixtures__/fakeMoodle.js';
import { InMemoryIdentityMappingRepository } from '../authorization/identityMappingRepository.js';
import {
  createAuthorizationCommands,
  createIdentityCommands,
  maskAddress,
} from './authorizationCommands.js';

const NOW = new Date('2026-11-05T08:00:00.000Z');
const KEY_A = { tenantId: TENANT, objectId: USER_A };

function setup() {
  const moodle = new FakeMoodle();
  moodle.users = [
    moodleUser(5, {
      email: 'thandi.private@gmail.example',
      fullname: 'Thandi Secretname',
      courses: [{ id: COURSE_A, visible: 1 }],
    }),
    moodleUser(6, { suspended: true }),
  ];
  const repository = new InMemoryIdentityMappingRepository({ now: () => NOW });
  const dependencies = {
    env: { NODE_ENV: 'test', AZURE_TENANT_ID: TENANT },
    moodle,
    identityRepository: repository,
    now: () => NOW,
  };
  const { logger, lines } = captureLogger();
  const run = async (
    group: 'identity' | 'authorization',
    name: string,
    args: string[],
  ): Promise<{ exitCode: number; output: string; json: Record<string, unknown> }> => {
    const output: string[] = [];
    const context: CommandContext = { args, logger, stdout: (text) => output.push(text) };
    const commands =
      group === 'identity'
        ? createIdentityCommands(dependencies)
        : createAuthorizationCommands(dependencies);
    const command = commands[name];
    if (command === undefined) {
      throw new Error(`no command ${name}`);
    }
    const exitCode = await command.run(context);
    const text = output.join('\n');
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Usage errors are plain text.
    }
    return { exitCode, output: text, json };
  };
  return { run, moodle, repository, logs: lines };
}

describe('pnpm identity', () => {
  it('resolves from the claims of the last sign-in, masking them, and records nothing', async () => {
    const { run, repository } = setup();
    await repository.recordObservation({
      ...KEY_A,
      email: 'thandi.private@gmail.example',
      accountType: 'guest',
      lastSeenAt: NOW.toISOString(),
    });
    const result = await run('identity', 'resolve', ['--entra-object-id', USER_A.toUpperCase()]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      entraObjectId: USER_A,
      claimsUsed: { source: 'last-sign-in', email: 't…@gmail.example', accountType: 'guest' },
      result: { status: 'mapped', moodleUserId: 5, method: 'email' },
    });
    expect(result.output).not.toContain('thandi.private');
    expect(result.output).not.toContain('Secretname');
    expect(await repository.listFailures()).toEqual([]);
  });

  it('can check a user before they sign in, and reports when nothing is known', async () => {
    const { run } = setup();
    expect(
      (
        await run('identity', 'resolve', [
          '--entra-object-id',
          USER_B,
          '--email',
          'Thandi.Private@gmail.example',
        ])
      ).json,
    ).toMatchObject({ claimsUsed: { source: 'arguments' }, result: { status: 'mapped' } });
    expect((await run('identity', 'resolve', ['--entra-object-id', USER_B])).json).toMatchObject({
      claimsUsed: { source: 'none' },
      result: { status: 'denied', reason: 'no_usable_claims' },
    });
  });

  it('maps only to an active Moodle account, invalidates cached access, and unmaps', async () => {
    const { run, repository } = setup();
    const refused = await run('identity', 'map', [
      '--entra-object-id',
      USER_A,
      '--moodle-user-id',
      '6',
      '--approved-by',
      'Dep',
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({ status: 'refused', reason: 'moodle_user_suspended' });
    expect(
      (
        await run('identity', 'map', [
          '--entra-object-id',
          USER_A,
          '--moodle-user-id',
          '99',
          '--approved-by',
          'Dep',
        ])
      ).json,
    ).toMatchObject({ reason: 'mapped_user_not_found' });
    expect(await repository.getMapping(KEY_A)).toBeUndefined();

    const mapped = await run('identity', 'map', [
      '--entra-object-id',
      USER_A,
      '--moodle-user-id',
      '5',
      '--approved-by',
      'Dep',
      '--reference',
      'IT-1234',
    ]);
    expect(mapped.json).toEqual({
      status: 'mapped',
      entraObjectId: USER_A,
      moodleUserId: 5,
      replaced: null,
    });
    expect(await repository.getMapping(KEY_A)).toMatchObject({
      approvedBy: 'Dep',
      reference: 'IT-1234',
    });
    expect(await repository.listInvalidations()).toEqual([
      { scope: KEY_A, at: NOW.toISOString(), reason: 'mapping_changed' },
    ]);
    expect((await run('identity', 'resolve', ['--entra-object-id', USER_A])).json).toMatchObject({
      result: { method: 'explicit', moodleUserId: 5 },
    });

    expect((await run('identity', 'unmap', ['--entra-object-id', USER_A])).json).toMatchObject({
      status: 'removed',
    });
    expect((await run('identity', 'unmap', ['--entra-object-id', USER_A])).exitCode).toBe(1);
    expect(await repository.listInvalidations()).toHaveLength(2);
  });

  it('lists the audit trail without personal data', async () => {
    const { run, repository } = setup();
    await repository.recordFailure({
      ...KEY_A,
      at: NOW.toISOString(),
      reason: 'ambiguous_email',
      candidates: 2,
    });
    const result = await run('identity', 'failures', ['--limit', '10']);
    expect(result.json).toMatchObject({
      count: 1,
      failures: [{ objectId: USER_A, reason: 'ambiguous_email', candidates: 2 }],
    });
  });

  it('rejects bad arguments with usage errors', async () => {
    const { run } = setup();
    expect((await run('identity', 'resolve', ['--entra-object-id', 'not-a-guid'])).exitCode).toBe(
      2,
    );
    expect((await run('identity', 'resolve', [])).exitCode).toBe(2);
    expect(
      (await run('identity', 'map', ['--entra-object-id', USER_A, '--moodle-user-id', '5']))
        .exitCode,
    ).toBe(2);
  });
});

describe('pnpm authorization', () => {
  it('shows a user’s current courses from Moodle', async () => {
    const { run } = setup();
    const result = await run('authorization', 'courses', [
      '--entra-object-id',
      USER_A,
      '--email',
      'thandi.private@gmail.example',
    ]);
    expect(result.json).toMatchObject({
      result: 'authorized',
      method: 'email',
      moodleUserId: 5,
      courseIds: [COURSE_A],
    });
    expect(result.output).not.toContain('thandi.private');
    expect(
      (
        await run('authorization', 'courses', [
          '--entra-object-id',
          USER_B,
          '--email',
          'x@example.test',
        ])
      ).json,
    ).toMatchObject({ result: 'denied', reason: 'no_match', courseIds: [] });
  });

  it('writes invalidations for one user or everyone', async () => {
    const { run, repository } = setup();
    expect((await run('authorization', 'invalidate', [])).exitCode).toBe(2);
    expect(
      (await run('authorization', 'invalidate', ['--all', '--entra-object-id', USER_A])).exitCode,
    ).toBe(2);
    expect(
      (await run('authorization', 'invalidate', ['--entra-object-id', USER_A])).json,
    ).toMatchObject({
      status: 'invalidated',
      scope: USER_A,
    });
    await run('authorization', 'invalidate', ['--all']);
    expect((await repository.listInvalidations()).map((entry) => entry.scope)).toEqual([
      KEY_A,
      'all',
    ]);
  });

  it('runs the enrolment sync and fails when Moodle could not be asked', async () => {
    const { run, repository, moodle } = setup();
    await repository.recordObservation({
      ...KEY_A,
      email: 'thandi.private@gmail.example',
      lastSeenAt: NOW.toISOString(),
    });
    expect((await run('authorization', 'sync', [])).json).toMatchObject({
      status: 'ok',
      users: 1,
      changed: 1,
    });
    moodle.failLookups = true;
    const failed = await run('authorization', 'sync', []);
    expect(failed.exitCode).toBe(1);
    expect(failed.json).toMatchObject({ status: 'partial', errors: 1 });
  });

  it('reports Moodle outages as a clear failure', async () => {
    const { run, moodle } = setup();
    moodle.failLookups = true;
    const result = await run('authorization', 'courses', [
      '--entra-object-id',
      USER_A,
      '--email',
      'a@example.test',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ error: { category: 'moodle_unavailable' } });
  });
});

describe('address masking', () => {
  it('keeps the first character and the domain only', () => {
    expect(maskAddress('thandi@skinrenewal.co.za')).toBe('t…@skinrenewal.co.za');
    expect(maskAddress('thandi_gmail.com#EXT#@tenant.onmicrosoft.com')).toBe(
      't…@tenant.onmicrosoft.com',
    );
    expect(maskAddress('nodomain')).toBe('…');
    expect(maskAddress(undefined)).toBeUndefined();
  });
});
