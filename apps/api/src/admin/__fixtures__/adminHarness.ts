import { InMemorySyncStateRepository, type SyncReport } from '@ehub/indexer';
import { createLogger, type Logger } from '@ehub/shared';

import {
  API_CLIENT_ID,
  AUTHORITY,
  BOT_CLIENT_ID,
  NOW as TOKEN_NOW,
  TENANT as TOKEN_TENANT,
  createTokenKit,
  type TokenKit,
} from '../../auth/__fixtures__/tokens.js';
import { EntraTokenValidator } from '../../auth/entraTokenValidator.js';
import { FakeMoodle, moodleUser } from '../../authorization/__fixtures__/fakeMoodle.js';
import { InMemoryIdentityMappingRepository } from '../../authorization/identityMappingRepository.js';
import { MoodleIdentityResolver } from '../../authorization/moodleIdentityResolver.js';
import type { EntraUserKey } from '../../authorization/records.js';
import { startApiServer, type RunningApiServer } from '../../http/apiServer.js';
import {
  DevMockAuthenticator,
  EntraBearerAuthenticator,
  type RequestAuthenticator,
} from '../../http/authentication.js';
import { InterimCourseAccess } from '../../auth/courseAccess.js';
import { AdminDataService } from '../adminData.js';
import { createAdminHandler, type AdminClientConfig } from '../adminHandler.js';
import { configurationSnapshot } from '../configurationSnapshot.js';
import { auditEventSchema, usageEventSchema, type AuditEvent, type UsageEvent } from '../events.js';
import { InMemoryEventStore } from '../eventStore.js';
import { adminUiDirectory, msalBundlePath } from '../factory.js';
import { AdminJobRunner, type ManualJob } from '../jobRunner.js';

export const SEARCH_TENANT = '00000000-0000-4000-8000-000000000001';
export const ADMIN_OID = 'adadadad-adad-4ada-8ada-adadadadadad';
export const INCLUDED_COURSE = 12;
export const OTHER_COURSE = 77;
export const FAILED_RESOURCE = '702:file:/Consultation checklist.pdf';
export const SECRET_VALUES = {
  MOODLE_TOKEN: 'moodle-secret-token-do-not-show-0123456789',
  AZURE_SEARCH_API_KEY: 'search-secret-key-do-not-show-0123456789',
  AZURE_OPENAI_API_KEY: 'openai-secret-key-do-not-show-0123456789',
};

export interface AdminHarness {
  readonly url: string;
  readonly server: RunningApiServer;
  readonly kit: TokenKit;
  readonly audit: InMemoryEventStore<AuditEvent>;
  readonly usage: InMemoryEventStore<UsageEvent>;
  readonly state: InMemorySyncStateRepository;
  readonly identity: InMemoryIdentityMappingRepository;
  readonly moodle: FakeMoodle;
  readonly runner: AdminJobRunner;
  readonly jobs: ManualJob[];
  readonly invalidated: (EntraUserKey | 'all')[];
  readonly logs: string[];
  /** Releases a held job (when `holdJobs`). */
  release(): void;
  tokenFor(roles: readonly string[]): Promise<string>;
  request(
    path: string,
    options?: {
      readonly method?: string;
      readonly body?: unknown;
      readonly token?: string | null;
      readonly headers?: Record<string, string>;
    },
  ): Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
    readonly headers: Headers;
    readonly text: string;
  }>;
  close(): Promise<void>;
}

function report(jobId: string): SyncReport {
  return {
    jobId,
    jobType: 'incremental',
    dryRun: false,
    status: 'succeeded',
    startedAt: TOKEN_NOW.toISOString(),
    finishedAt: TOKEN_NOW.toISOString(),
    durationMs: 1,
    counts: { processed: 0, skipped: 0, updated: 0, removed: 0, failed: 0 },
    breakdown: {} as SyncReport['breakdown'],
    courses: [],
    resources: [],
    warnings: [],
  };
}

async function seed(state: InMemorySyncStateRepository): Promise<void> {
  const base = {
    tenantId: SEARCH_TENANT,
    moduleId: 702,
    observed: { metadataHash: 'a'.repeat(64) },
    retryCount: 0,
    lastJobId: 'job-1',
    lastJobType: 'incremental' as const,
    updatedAt: TOKEN_NOW.toISOString(),
  };
  await state.saveResource(
    {
      ...base,
      courseId: INCLUDED_COURSE,
      resourceId: '701:chapter:11',
      status: 'indexed',
      lastSuccessfulIndexAt: '2026-11-04T10:00:00.000Z',
    },
    null,
  );
  await state.saveResource(
    {
      ...base,
      courseId: INCLUDED_COURSE,
      resourceId: FAILED_RESOURCE,
      status: 'failed',
      failureCategory: 'moodle_unavailable',
      retryCount: 2,
    },
    null,
  );
  await state.saveResource(
    {
      ...base,
      courseId: INCLUDED_COURSE,
      resourceId: '703:page',
      status: 'quarantined',
      failureCategory: 'encrypted',
    },
    null,
  );
  await state.saveResource(
    {
      ...base,
      courseId: INCLUDED_COURSE,
      resourceId: '704:page',
      status: 'excluded',
      statusReason: 'hidden',
    },
    null,
  );
  await state.saveResource(
    {
      ...base,
      courseId: OTHER_COURSE,
      resourceId: '901:page',
      status: 'removed',
      statusReason: 'course_not_selected',
    },
    null,
  );
  await state.saveJob({
    jobId: 'job-1',
    jobType: 'incremental',
    tenantId: SEARCH_TENANT,
    status: 'succeeded',
    dryRun: false,
    correlationId: 'corr-1',
    startedAt: '2026-11-04T09:00:00.000Z',
    finishedAt: '2026-11-04T09:05:00.000Z',
    courseIds: [INCLUDED_COURSE],
    counts: { processed: 4, skipped: 1, updated: 2, removed: 0, failed: 1 },
  });
}

export async function startAdminHarness(
  options: {
    readonly authenticator?: 'entra' | 'dev-mock';
    readonly mockRoles?: readonly string[];
    readonly holdJobs?: boolean;
    readonly withIdentity?: boolean;
    readonly publicOrigin?: string;
  } = {},
): Promise<AdminHarness> {
  const kit = await createTokenKit();
  const logs: string[] = [];
  const logger: Logger = createLogger({
    service: 'test',
    level: 'trace',
    sink: { write: (line) => logs.push(line) },
  });
  const now = () => TOKEN_NOW;
  const state = new InMemorySyncStateRepository();
  await seed(state);
  const audit = new InMemoryEventStore({ schema: auditEventSchema, timeOf: (e) => e.at, now });
  const usage = new InMemoryEventStore({ schema: usageEventSchema, timeOf: (e) => e.at, now });
  const identity = new InMemoryIdentityMappingRepository({ now });
  const moodle = new FakeMoodle();
  moodle.users = [moodleUser(501), moodleUser(502, { suspended: true })];
  const resolver = new MoodleIdentityResolver({
    moodle,
    repository: identity,
    emailMatching: true,
    upnRule: 'none',
    upnDomains: [],
    logger,
  });
  const jobs: ManualJob[] = [];
  let release: () => void = () => undefined;
  const runner = new AdminJobRunner({
    openServices: () => Promise.resolve({} as never),
    run: async (_services, job, jobId) => {
      jobs.push(job);
      if (options.holdJobs === true) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return report(jobId);
    },
    logger,
    now,
  });
  const authenticator: RequestAuthenticator =
    options.authenticator === 'dev-mock'
      ? new DevMockAuthenticator({
          nodeEnv: 'development',
          userId: 'dev-mock-admin',
          tenantId: TOKEN_TENANT,
          roles: options.mockRoles ?? [],
        })
      : new EntraBearerAuthenticator(
          new EntraTokenValidator({
            allowedTenantIds: [TOKEN_TENANT],
            audiences: [API_CLIENT_ID],
            requiredScope: 'access_as_user',
            allowedClientAppIds: [BOT_CLIENT_ID],
            keys: kit.keys,
            authorityHost: AUTHORITY,
            clockToleranceSeconds: 120,
            currentDate: () => TOKEN_NOW,
          }),
        );
  const invalidated: (EntraUserKey | 'all')[] = [];
  const data = new AdminDataService({
    state,
    selection: {
      tenantId: SEARCH_TENANT,
      courseIds: [INCLUDED_COURSE],
      allCourses: false,
      leaseTtlMs: 1_800_000,
    },
    identity,
    usage,
    audit,
    courseNames: (ids) =>
      Promise.resolve(
        new Map(
          ids.filter((id) => id === INCLUDED_COURSE).map((id) => [id, 'Consultation Skills']),
        ),
      ),
    runner: () => runner.status(),
    logger,
    now,
  });
  const clientConfig: AdminClientConfig =
    options.authenticator === 'dev-mock'
      ? { mode: 'dev-mock', mockUserId: 'dev-mock-admin' }
      : {
          mode: 'msal',
          clientId: BOT_CLIENT_ID,
          authority: `${AUTHORITY}/${TOKEN_TENANT}`,
          scopes: [`api://${API_CLIENT_ID}/access_as_user`],
        };
  const handler = createAdminHandler({
    authenticator,
    data,
    runner,
    ...(options.withIdentity === false
      ? {}
      : {
          identity: {
            repository: identity,
            resolver,
            invalidate: (key) => {
              invalidated.push(key);
            },
            tenantId: TOKEN_TENANT,
          },
        }),
    audit,
    configuration: () =>
      configurationSnapshot({
        NODE_ENV: 'development',
        AZURE_TENANT_ID: SEARCH_TENANT,
        SYNC_COURSE_IDS: String(INCLUDED_COURSE),
        RETRIEVAL_TOP_K: '6',
        ADMIN_UI_ENABLED: 'true',
        ...SECRET_VALUES,
      }),
    clientConfig,
    ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
    authorityOrigin: AUTHORITY,
    uiDirectory: adminUiDirectory(),
    msalBundlePath: msalBundlePath(),
    logger,
    now,
  });
  const server = await startApiServer(
    {
      answerer: { ask: () => Promise.reject(new Error('not used')) },
      authenticator,
      courseAccess: new InterimCourseAccess({
        nodeEnv: 'test',
        mockCourseIds: [],
        devEntraCourseIds: [],
      }),
      feedback: { record: () => Promise.resolve() },
      tenantId: SEARCH_TENANT,
      requestTimeoutMs: 10_000,
      logger,
      service: 'test',
      version: '0.0.0',
      admin: handler,
    },
    { host: '127.0.0.1', port: 0 },
  );
  const tokenFor = (roles: readonly string[]) =>
    kit.sign({ oid: ADMIN_OID, roles: [...roles], name: 'Admin Person' });
  return {
    url: server.url,
    server,
    kit,
    audit,
    usage,
    state,
    identity,
    moodle,
    runner,
    jobs,
    invalidated,
    logs,
    release: () => {
      release();
    },
    tokenFor,
    request: async (path, request = {}) => {
      const token =
        request.token === undefined
          ? await tokenFor(['EHub.ApplicationAdministrator'])
          : request.token;
      const response = await fetch(`${server.url}${path}`, {
        method: request.method ?? (request.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const text = await response.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      return { status: response.status, body, headers: response.headers, text };
    },
    close: async () => {
      release();
      await runner.idle();
      await server.close();
    },
  };
}
