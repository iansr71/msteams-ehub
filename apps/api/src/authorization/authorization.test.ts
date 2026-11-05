import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COURSE_A,
  COURSE_B,
  FakeMoodle,
  TENANT,
  USER_A,
  USER_B,
  captureLogger,
  caller,
  moodleUser,
} from './__fixtures__/fakeMoodle.js';
import { InMemoryAuthorizationCache } from './authorizationCache.js';
import { AuthorizedCourseService, claimsOf } from './authorizedCourseService.js';
import { EnrolmentSyncJob } from './enrolmentSyncJob.js';
import { AuthorizationUnavailableError, IdentityNotMappedError } from './errors.js';
import { FileIdentityMappingRepository } from './fileIdentityMappingRepository.js';
import {
  IdentityStateCorruptError,
  InMemoryIdentityMappingRepository,
  MAX_FAILURE_RECORDS,
  type IdentityMappingRepository,
} from './identityMappingRepository.js';
import { MoodleEnrollmentService } from './moodleEnrollmentService.js';
import { MoodleIdentityResolver } from './moodleIdentityResolver.js';

const KEY_A = { tenantId: TENANT, objectId: USER_A };
const KEY_B = { tenantId: TENANT, objectId: USER_B };
const T0 = Date.parse('2026-11-05T08:00:00.000Z');

function resolverWith(
  moodle: FakeMoodle,
  repository: IdentityMappingRepository = new InMemoryIdentityMappingRepository(),
  options: Partial<{
    emailMatching: boolean;
    upnRule: 'none' | 'upn' | 'upn-local-part';
    upnDomains: string[];
  }> = {},
) {
  const { logger, lines } = captureLogger();
  const resolver = new MoodleIdentityResolver({
    moodle,
    repository,
    emailMatching: options.emailMatching ?? true,
    upnRule: options.upnRule ?? 'none',
    upnDomains: options.upnDomains ?? [],
    logger,
    now: () => new Date(T0),
  });
  return { resolver, repository, lines };
}

const claims = (...args: Parameters<typeof caller>) => claimsOf(caller(...args));

describe('Moodle identity mapping', () => {
  it('uses an administrator-approved mapping first, confirmed with Moodle', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(7), moodleUser(8, { email: 'thandi@example.test' })];
    const repository = new InMemoryIdentityMappingRepository();
    await repository.saveMapping({
      ...KEY_A,
      moodleUserId: 7,
      approvedBy: 'Dep',
      approvedAt: new Date(T0).toISOString(),
    });
    const { resolver } = resolverWith(moodle, repository);
    // The email would match account 8; the explicit mapping wins and nothing else is tried.
    expect(await resolver.resolve(claims(USER_A, { email: 'thandi@example.test' }))).toEqual({
      status: 'mapped',
      moodleUserId: 7,
      method: 'explicit',
    });
    expect(moodle.lookups).toEqual([{ field: 'id', values: ['7'] }]);
  });

  it('denies an explicit mapping to an account Moodle no longer has, without falling back', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(8, { email: 'thandi@example.test' })];
    const repository = new InMemoryIdentityMappingRepository();
    await repository.saveMapping({
      ...KEY_A,
      moodleUserId: 7,
      approvedBy: 'Dep',
      approvedAt: new Date(T0).toISOString(),
    });
    const { resolver } = resolverWith(moodle, repository);
    expect(await resolver.resolve(claims(USER_A, { email: 'thandi@example.test' }))).toEqual({
      status: 'denied',
      reason: 'mapped_user_not_found',
      method: 'explicit',
    });
  });

  it('maps a verified email to exactly one Moodle account, matching case-insensitively', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(5, { email: 'Thandi@Example.test' })];
    const { resolver } = resolverWith(moodle);
    expect(
      await resolver.resolve(
        claims(USER_A, { email: 'thandi@example.test', emailAsIssued: 'Thandi@Example.test' }),
      ),
    ).toEqual({ status: 'mapped', moodleUserId: 5, method: 'email' });
    // Both forms are sent so a case-sensitive database still finds the issued form.
    expect(moodle.lookups[0]).toEqual({
      field: 'email',
      values: ['thandi@example.test', 'Thandi@Example.test'],
    });
  });

  it('denies an ambiguous email match and records an audit entry, without trying the UPN', async () => {
    const moodle = new FakeMoodle();
    moodle.caseInsensitive = true;
    moodle.users = [
      moodleUser(5, { email: 'shared@example.test', username: 'thandi' }),
      moodleUser(6, { email: 'SHARED@example.test' }),
    ];
    const { resolver, repository, lines } = resolverWith(moodle, undefined, {
      upnRule: 'upn-local-part',
      upnDomains: ['skinrenewal.example'],
    });
    expect(
      await resolver.resolve(
        claims(USER_A, { email: 'shared@example.test', upn: 'thandi@skinrenewal.example' }),
      ),
    ).toEqual({ status: 'denied', reason: 'ambiguous_email', method: 'email', candidates: 2 });
    expect(moodle.lookups.map((entry) => entry.field)).toEqual(['email']);
    expect(await repository.listFailures()).toEqual([
      expect.objectContaining({ ...KEY_A, reason: 'ambiguous_email', candidates: 2 }),
    ]);
    expect(lines.join('\n')).not.toContain('shared@');
  });

  it.each([
    [{ suspended: true }, 'moodle_user_suspended'],
    [{ auth: 'nologin' }, 'moodle_user_suspended'],
    [{ confirmed: false }, 'moodle_user_suspended'],
    [{ suspended: undefined }, 'moodle_status_unknown'],
  ] as const)('denies an account that is not confirmed active (%o)', async (overrides, reason) => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(5, { email: 'thandi@example.test', ...overrides })];
    const { resolver } = resolverWith(moodle);
    expect(await resolver.resolve(claims(USER_A, { email: 'thandi@example.test' }))).toMatchObject({
      status: 'denied',
      reason,
    });
  });

  it('applies the UPN rule only to members, the upn claim and listed domains', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(9, { username: 'thandi', email: 'other@example.test' })];
    const { resolver } = resolverWith(moodle, undefined, {
      upnRule: 'upn-local-part',
      upnDomains: ['skinrenewal.example'],
    });
    expect(
      await resolver.resolve(
        claims(USER_A, { email: 'nomatch@example.test', upn: 'Thandi@SkinRenewal.example' }),
      ),
    ).toEqual({ status: 'mapped', moodleUserId: 9, method: 'upn_username' });
    expect(moodle.lookups.at(-1)).toEqual({ field: 'username', values: ['thandi'] });

    for (const variant of [
      { upn: 'thandi@skinrenewal.example', upnSource: 'preferred_username' as const },
      { upn: 'thandi@other.example' },
      { upn: 'thandi_gmail.com#EXT#@skinrenewal.example' },
      { upn: 'thandi@skinrenewal.example', accountType: 'guest' as const },
    ]) {
      expect(await resolver.resolve(claims(USER_A, variant))).toMatchObject({
        status: 'denied',
        reason: 'no_usable_claims',
      });
    }
    const off = resolverWith(moodle).resolver;
    expect(await off.resolve(claims(USER_A, { upn: 'thandi@skinrenewal.example' }))).toMatchObject({
      reason: 'no_usable_claims',
    });
    const whole = resolverWith(moodle, undefined, {
      upnRule: 'upn',
      upnDomains: ['skinrenewal.example'],
    }).resolver;
    await whole.resolve(claims(USER_A, { upn: 'Thandi@skinrenewal.example' }));
    expect(moodle.lookups.at(-1)).toEqual({
      field: 'username',
      values: ['thandi@skinrenewal.example'],
    });
  });

  it('denies when nothing matches, and when the token has nothing to match on', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [moodleUser(5)];
    const { resolver } = resolverWith(moodle);
    expect(await resolver.resolve(claims(USER_A, { email: 'nobody@example.test' }))).toEqual({
      status: 'denied',
      reason: 'no_match',
    });
    expect(await resolver.resolve(claims(USER_A))).toEqual({
      status: 'denied',
      reason: 'no_usable_claims',
    });
    const emailOff = resolverWith(moodle, undefined, { emailMatching: false }).resolver;
    expect(await emailOff.resolve(claims(USER_A, { email: 'user5@example.test' }))).toMatchObject({
      reason: 'no_usable_claims',
    });
  });

  it('treats a value Moodle rejects as no match, but an outage as an error', async () => {
    const moodle = new FakeMoodle();
    const { resolver } = resolverWith(moodle);
    expect(await resolver.resolve(claims(USER_A, { email: 'rejected.name@example.test' }))).toEqual(
      {
        status: 'denied',
        reason: 'no_match',
      },
    );
    moodle.failLookups = true;
    await expect(
      resolver.resolve(claims(USER_A, { email: 'thandi@example.test' })),
    ).rejects.toMatchObject({
      name: 'AuthorizationUnavailableError',
      reason: 'moodle_unavailable',
    });
  });

  it('fails closed when the mapping store cannot be read', async () => {
    const repository = new InMemoryIdentityMappingRepository();
    repository.getMapping = () => Promise.reject(new IdentityStateCorruptError('test'));
    const { resolver } = resolverWith(new FakeMoodle(), repository);
    await expect(resolver.resolve(claims(USER_A))).rejects.toMatchObject({
      reason: 'identity_store_unavailable',
    });
  });

  it('records the claims used, and writes nothing on an admin dry run', async () => {
    const moodle = new FakeMoodle();
    const { resolver, repository } = resolverWith(moodle);
    await resolver.resolve(claims(USER_B, { email: 'x@example.test' }), { audit: false });
    expect(await repository.listObservations()).toEqual([]);
    expect(await repository.listFailures()).toEqual([]);
    await resolver.resolve(claims(USER_B, { email: 'x@example.test', accountType: 'guest' }));
    expect(await repository.getObservation(KEY_B)).toMatchObject({
      email: 'x@example.test',
      accountType: 'guest',
    });
    expect(await repository.listFailures({ key: KEY_B })).toHaveLength(1);
  });
});

describe('Moodle enrolments', () => {
  it('returns visible courses with active enrolments only, sorted', async () => {
    const moodle = new FakeMoodle();
    moodle.users = [
      moodleUser(5, {
        courses: [
          { id: 30, visible: 1 },
          { id: 10, visible: 1 },
          { id: 20, visible: 0 },
          { id: 40 },
        ],
      }),
    ];
    expect(await new MoodleEnrollmentService(moodle).coursesFor(5)).toEqual({
      courseIds: [10, 30],
      hiddenCourseCount: 2,
    });
  });

  it('fails closed when Moodle cannot answer, or answers with too many courses', async () => {
    const moodle = new FakeMoodle();
    moodle.failCourses = true;
    await expect(new MoodleEnrollmentService(moodle).coursesFor(5)).rejects.toBeInstanceOf(
      AuthorizationUnavailableError,
    );
    moodle.failCourses = false;
    moodle.users = [
      moodleUser(5, {
        courses: Array.from({ length: 1_001 }, (_, index) => ({
          id: index + 1,
          visible: 1 as const,
        })),
      }),
    ];
    await expect(new MoodleEnrollmentService(moodle).coursesFor(5)).rejects.toMatchObject({
      reason: 'invalid_moodle_response',
    });
  });
});

describe('authorisation cache', () => {
  let clock = T0;
  const now = () => clock;
  beforeEach(() => {
    clock = T0;
  });
  const grant = {
    kind: 'authorized',
    moodleUserId: 5,
    method: 'email',
    courseIds: [COURSE_A],
  } as const;

  function cache(
    options: Partial<ConstructorParameters<typeof InMemoryAuthorizationCache>[0]> = {},
  ) {
    return new InMemoryAuthorizationCache({
      ttlMs: 60_000,
      maxEntries: 10,
      logger: captureLogger().logger,
      now,
      ...options,
    });
  }

  it('serves entries within the TTL, then only within the stale grace when asked', async () => {
    const subject = cache();
    subject.set(KEY_A, grant);
    clock += 59_999;
    expect(await subject.lookup(KEY_A)).toMatchObject({ fresh: true });
    clock += 1;
    expect(await subject.lookup(KEY_A)).toBeUndefined();
    expect(await subject.lookup(KEY_A, { staleGraceMs: 30_000 })).toMatchObject({ fresh: false });
    clock += 30_000;
    expect(await subject.lookup(KEY_A, { staleGraceMs: 30_000 })).toBeUndefined();
  });

  it('keeps denials briefly and never serves them stale', async () => {
    const subject = cache({ deniedTtlMs: 10_000 });
    subject.set(KEY_A, { kind: 'denied', reason: 'no_match' });
    clock += 10_000;
    expect(await subject.lookup(KEY_A, { staleGraceMs: 60_000 })).toBeUndefined();
  });

  it('drops entries on explicit invalidation, for one user or everyone', async () => {
    const subject = cache();
    subject.set(KEY_A, grant);
    subject.set(KEY_B, grant);
    subject.invalidate(KEY_A);
    expect(await subject.lookup(KEY_A)).toBeUndefined();
    expect(await subject.lookup(KEY_B)).toBeDefined();
    subject.invalidateAll();
    expect(await subject.lookup(KEY_B, { staleGraceMs: 600_000 })).toBeUndefined();
    expect(subject.size).toBe(0);
  });

  it('applies invalidations written by other processes, even within the stale grace', async () => {
    const repository = new InMemoryIdentityMappingRepository({ now: () => new Date(clock) });
    const subject = cache({ invalidations: repository, invalidationPollMs: 1_000 });
    subject.set(KEY_A, grant);
    subject.set(KEY_B, grant);
    clock += 10;
    await repository.addInvalidation({
      scope: KEY_A,
      at: new Date(clock).toISOString(),
      reason: 'admin',
    });
    expect(await subject.lookup(KEY_A, { staleGraceMs: 600_000 })).toBeUndefined();
    expect(await subject.lookup(KEY_B)).toBeDefined();
    // A newer entry for the same user is valid again.
    clock += 1_001;
    subject.set(KEY_A, grant);
    clock += 1;
    expect(await subject.lookup(KEY_A)).toBeDefined();
    await repository.addInvalidation({
      scope: 'all',
      at: new Date(clock).toISOString(),
      reason: 'admin',
    });
    clock += 1_001;
    expect(await subject.lookup(KEY_A)).toBeUndefined();
    expect(await subject.lookup(KEY_B)).toBeUndefined();
  });

  it('trusts no cached entry while invalidations cannot be read', async () => {
    const repository = new InMemoryIdentityMappingRepository();
    let broken = false;
    const subject = cache({
      invalidations: {
        listInvalidations: () =>
          broken ? Promise.reject(new Error('store down')) : repository.listInvalidations(),
      },
      invalidationPollMs: 1_000,
    });
    subject.set(KEY_A, grant);
    expect(await subject.lookup(KEY_A)).toBeDefined();
    broken = true;
    clock += 1_000;
    expect(await subject.lookup(KEY_A)).toBeUndefined();
  });

  it('evicts the oldest entries beyond the size limit', async () => {
    const subject = cache({ maxEntries: 2 });
    subject.set(KEY_A, grant);
    subject.set(KEY_B, grant);
    subject.set({ tenantId: TENANT, objectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, grant);
    expect(subject.size).toBe(2);
    expect(await subject.lookup(KEY_A)).toBeUndefined();
  });
});

describe('authorised course service', () => {
  let clock = T0;
  beforeEach(() => {
    clock = T0;
  });

  function service(options: { staleGraceMs?: number; nodeEnv?: string } = {}) {
    const moodle = new FakeMoodle();
    moodle.users = [
      moodleUser(5, {
        email: 'a@example.test',
        courses: [{ id: COURSE_A, visible: 1 }],
      }),
      moodleUser(6, { email: 'b@example.test', courses: [{ id: COURSE_B, visible: 1 }] }),
    ];
    const repository = new InMemoryIdentityMappingRepository({ now: () => new Date(clock) });
    const { logger, lines } = captureLogger();
    const cache = new InMemoryAuthorizationCache({
      ttlMs: 60_000,
      maxEntries: 100,
      invalidations: repository,
      invalidationPollMs: 0,
      logger,
      now: () => clock,
    });
    const subject = new AuthorizedCourseService({
      resolver: new MoodleIdentityResolver({
        moodle,
        repository,
        emailMatching: true,
        upnRule: 'none',
        upnDomains: [],
        logger,
      }),
      enrolments: new MoodleEnrollmentService(moodle),
      cache,
      staleGraceMs: options.staleGraceMs ?? 0,
      mockCourseIds: [999],
      nodeEnv: options.nodeEnv ?? 'test',
      logger,
    });
    return { subject, moodle, repository, cache, lines };
  }

  it('authorises each user for their own courses only, and caches the result', async () => {
    const { subject, moodle } = service();
    expect(await subject.resolve(caller(USER_A, { email: 'a@example.test' }))).toEqual([COURSE_A]);
    expect(await subject.resolve(caller(USER_B, { email: 'b@example.test' }))).toEqual([COURSE_B]);
    expect(await subject.resolve(caller(USER_A, { email: 'a@example.test' }))).toEqual([COURSE_A]);
    expect(moodle.courseCalls).toEqual([5, 6]);
  });

  it('asks Moodle again after the TTL and after invalidation, seeing revoked enrolments', async () => {
    const { subject, moodle } = service();
    const user = caller(USER_A, { email: 'a@example.test' });
    await subject.resolve(user);
    moodle.setCourses(5, []);
    expect(await subject.resolve(user)).toEqual([COURSE_A]);
    subject.invalidate(KEY_A);
    expect(await subject.resolve(user)).toEqual([]);
    moodle.setCourses(5, [{ id: COURSE_A, visible: 1 }]);
    clock += 60_000;
    expect(await subject.resolve(user)).toEqual([COURSE_A]);
  });

  it('throws IdentityNotMappedError for an unmapped user', async () => {
    const { subject } = service();
    await expect(
      subject.resolve(caller(USER_A, { email: 'nobody@example.test' })),
    ).rejects.toBeInstanceOf(IdentityNotMappedError);
  });

  it('fails closed when Moodle is down, with no stale access beyond the policy', async () => {
    const strict = service();
    const user = caller(USER_A, { email: 'a@example.test' });
    await strict.subject.resolve(user);
    clock += 60_000;
    strict.moodle.failCourses = true;
    await expect(strict.subject.resolve(user)).rejects.toBeInstanceOf(
      AuthorizationUnavailableError,
    );

    clock = T0;
    const lenient = service({ staleGraceMs: 30_000 });
    await lenient.subject.resolve(user);
    lenient.moodle.failLookups = true;
    clock += 60_000 + 29_999;
    expect(await lenient.subject.resolve(user)).toEqual([COURSE_A]);
    expect(lenient.lines.join('\n')).toContain('recently expired authorisation');
    clock += 1;
    await expect(lenient.subject.resolve(user)).rejects.toBeInstanceOf(
      AuthorizationUnavailableError,
    );
  });

  it('never uses an invalidated grant under the stale policy', async () => {
    const { subject, moodle, repository } = service({ staleGraceMs: 600_000 });
    const user = caller(USER_A, { email: 'a@example.test' });
    await subject.resolve(user);
    clock += 10;
    await repository.addInvalidation({
      scope: KEY_A,
      at: new Date(clock).toISOString(),
      reason: 'admin',
    });
    moodle.failLookups = true;
    clock += 60_000;
    await expect(subject.resolve(user)).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });

  it('reports an outage, not a denial, when only a stale denial is cached', async () => {
    const moodle = new FakeMoodle();
    moodle.failLookups = true;
    const { logger } = captureLogger();
    const subject = new AuthorizedCourseService({
      resolver: new MoodleIdentityResolver({
        moodle,
        repository: new InMemoryIdentityMappingRepository(),
        emailMatching: true,
        upnRule: 'none',
        upnDomains: [],
        logger,
      }),
      enrolments: new MoodleEnrollmentService(moodle),
      cache: {
        lookup: (_key, options = {}) =>
          Promise.resolve(
            options.staleGraceMs === undefined
              ? undefined
              : { value: { kind: 'denied', reason: 'no_match' }, fresh: false, ageMs: 1 },
          ),
        set: () => undefined,
        invalidate: () => undefined,
        invalidateAll: () => undefined,
        size: 0,
      },
      staleGraceMs: 60_000,
      nodeEnv: 'test',
      logger,
    });
    await expect(
      subject.resolve(caller(USER_A, { email: 'a@example.test' })),
    ).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });

  it('gives the mock identity its courses in development only', async () => {
    const mock = { ...caller(USER_A), mock: true };
    expect(await service({ nodeEnv: 'development' }).subject.resolve(mock)).toEqual([999]);
    expect(await service({ nodeEnv: 'production' }).subject.resolve(mock)).toEqual([]);
  });

  it('asks Moodle once for concurrent requests from the same user', async () => {
    const { subject, moodle } = service();
    const user = caller(USER_A, { email: 'a@example.test' });
    await Promise.all([subject.resolve(user), subject.resolve(user), subject.resolve(user)]);
    expect(moodle.courseCalls).toEqual([5]);
  });

  it('reports current access without caching or auditing', async () => {
    const { subject, repository, cache } = service();
    expect(
      await subject.current(claimsOf(caller(USER_A, { email: 'a@example.test' }))),
    ).toMatchObject({
      kind: 'authorized',
      courseIds: [COURSE_A],
    });
    expect(cache.size).toBe(0);
    expect(await repository.listObservations()).toEqual([]);
  });
});

describe('enrolment sync job', () => {
  it('invalidates users whose access changed and leaves the rest alone', async () => {
    let clock = T0;
    const moodle = new FakeMoodle();
    moodle.users = [
      moodleUser(5, { email: 'a@example.test', courses: [{ id: COURSE_A, visible: 1 }] }),
      moodleUser(6, { email: 'b@example.test', courses: [{ id: COURSE_B, visible: 1 }] }),
    ];
    const repository = new InMemoryIdentityMappingRepository({ now: () => new Date(clock) });
    const { logger } = captureLogger();
    const resolver = new MoodleIdentityResolver({
      moodle,
      repository,
      emailMatching: true,
      upnRule: 'none',
      upnDomains: [],
      logger,
    });
    await resolver.resolve(claims(USER_A, { email: 'a@example.test' }));
    await resolver.resolve(claims(USER_B, { email: 'b@example.test' }));
    const job = new EnrolmentSyncJob({
      repository,
      resolver,
      enrolments: new MoodleEnrollmentService(moodle),
      logger,
      now: () => new Date(clock),
    });

    expect(await job.run()).toEqual({ users: 2, changed: 2, unchanged: 0, denied: 0, errors: 0 });
    clock += 1_000;
    expect(await job.run()).toMatchObject({ changed: 0, unchanged: 2 });

    // User A loses course A; user B's Moodle account is suspended.
    moodle.users = [
      moodleUser(5, { email: 'a@example.test', courses: [] }),
      moodleUser(6, { email: 'b@example.test', suspended: true }),
    ];
    clock += 1_000;
    const before = (await repository.listInvalidations()).length;
    expect(await job.run()).toEqual({ users: 2, changed: 2, unchanged: 0, denied: 1, errors: 0 });
    const latest = (await repository.listInvalidations()).slice(before);
    expect(latest.map((entry) => entry.scope)).toEqual(expect.arrayContaining([KEY_A, KEY_B]));
    expect(await repository.getSnapshot(KEY_B)).toBeUndefined();

    moodle.failLookups = true;
    expect(await job.run()).toMatchObject({ errors: 2, changed: 0 });
  });
});

describe('file identity store', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ehub-identity-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists every record type, privately, and survives concurrent writers', async () => {
    const first = new FileIdentityMappingRepository({ directory });
    const second = new FileIdentityMappingRepository({ directory });
    const at = new Date().toISOString();
    await Promise.all([
      first.saveMapping({ ...KEY_A, moodleUserId: 7, approvedBy: 'Dep', approvedAt: at }),
      second.recordFailure({ ...KEY_B, at, reason: 'ambiguous_email', candidates: 2 }),
      first.recordObservation({ ...KEY_B, email: 'b@example.test', lastSeenAt: at }),
      second.addInvalidation({ scope: 'all', at, reason: 'admin' }),
      first.saveSnapshot({ ...KEY_A, courseIds: [COURSE_A], syncedAt: at }),
    ]);
    const reader = new FileIdentityMappingRepository({ directory });
    expect(await reader.getMapping(KEY_A)).toMatchObject({ moodleUserId: 7 });
    expect(await reader.listFailures()).toHaveLength(1);
    expect(await reader.getObservation(KEY_B)).toMatchObject({ email: 'b@example.test' });
    expect(await reader.listInvalidations()).toHaveLength(1);
    expect(await reader.getSnapshot(KEY_A)).toMatchObject({ courseIds: [COURSE_A] });
    expect(await reader.deleteMapping(KEY_A)).toBe(true);
    expect(await reader.deleteMapping(KEY_A)).toBe(false);
    expect(statSync(join(directory, 'identity-state.json')).mode & 0o077).toBe(0);
  });

  it('refuses invalid records and reports a damaged file instead of starting empty', async () => {
    const repository = new FileIdentityMappingRepository({ directory });
    await expect(
      repository.saveMapping({
        ...KEY_A,
        moodleUserId: -1,
        approvedBy: 'Dep',
        approvedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    writeFileSync(join(directory, 'identity-state.json'), '{"version":1,"mappings":"x"}');
    await expect(repository.getMapping(KEY_A)).rejects.toBeInstanceOf(IdentityStateCorruptError);
  });

  it('keeps a bounded audit trail and drops old invalidations', async () => {
    let clock = T0;
    const repository = new InMemoryIdentityMappingRepository({ now: () => new Date(clock) });
    for (let index = 0; index < MAX_FAILURE_RECORDS + 5; index += 1) {
      await repository.recordFailure({
        ...KEY_A,
        at: new Date(T0 + index).toISOString(),
        reason: 'no_match',
      });
    }
    const failures = await repository.listFailures({ limit: 5_000 });
    expect(failures).toHaveLength(MAX_FAILURE_RECORDS);
    expect(failures[0]?.at).toBe(new Date(T0 + MAX_FAILURE_RECORDS + 4).toISOString());
    await repository.addInvalidation({
      scope: KEY_A,
      at: new Date(clock).toISOString(),
      reason: 'admin',
    });
    clock += 2 * 60 * 60_000 + 1;
    expect(await repository.listInvalidations()).toEqual([]);
  });
});
