import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileSyncStateRepository } from '../../apps/indexer/src/state/fileSyncStateRepository.js';
import type { SyncReport } from '../../apps/indexer/src/jobs/syncReport.js';
import { createLogger, type CommandContext } from '@ehub/shared';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';
import { afterAll, describe, expect, it } from 'vitest';

import { createApiCommands } from '../../apps/api/src/commands/index.js';
import {
  ScriptedChatModel,
  modelAnswer,
} from '../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import {
  API_KEY,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from '../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { FakeEmbeddingService } from '../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';

/*
 * The administration page in a real browser (Chromium through Playwright, when available),
 * served by the real `pnpm api serve` in development with the mock identity and app roles.
 */

interface PlaywrightLike {
  chromium: {
    launch(): Promise<{
      newPage(): Promise<PageLike>;
      close(): Promise<void>;
    }>;
  };
}
interface LocatorLike {
  click(): Promise<void>;
  textContent(): Promise<string | null>;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  first(): LocatorLike;
  last(): LocatorLike;
  getAttribute(name: string): Promise<string | null>;
}
interface PageLike {
  goto(url: string): Promise<unknown>;
  on(
    event: 'console' | 'pageerror',
    listener: (value: { type?: () => string; text?: () => string; message?: string }) => void,
  ): void;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): LocatorLike;
  locator(selector: string): LocatorLike;
  waitForFunction<A>(fn: (arg: A) => boolean, arg: A): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
}

/*
 * Browser-side checks. Playwright serialises these functions into the page, so each is
 * self-contained and takes its input as an argument; string expressions would need eval, which
 * the page's content security policy (correctly) forbids.
 */
interface MiniElement {
  readonly id: string;
  readonly textContent: string | null;
  hasAttribute(name: string): boolean;
}
interface MiniDocument {
  querySelector(selector: string): MiniElement | null;
  readonly activeElement: MiniElement | null;
}
const pageReady = (title: string): boolean => {
  const d = (globalThis as unknown as { document: MiniDocument }).document;
  return (
    d.querySelector('#page-title')?.textContent === title &&
    d.querySelector('#page')?.hasAttribute('aria-busy') === false
  );
};
const textIs = ([selector, expected]: readonly [string, string]): boolean =>
  (globalThis as unknown as { document: MiniDocument }).document.querySelector(selector)
    ?.textContent === expected;
const textStarts = ([selector, expected]: readonly [string, string]): boolean =>
  (globalThis as unknown as { document: MiniDocument }).document
    .querySelector(selector)
    ?.textContent?.startsWith(expected) === true;
const textHas = ([selector, expected]: readonly [string, string]): boolean =>
  (globalThis as unknown as { document: MiniDocument }).document
    .querySelector(selector)
    ?.textContent?.includes(expected) === true;
const exists = (selector: string): boolean =>
  (globalThis as unknown as { document: MiniDocument }).document.querySelector(selector) !== null;

function loadPlaywright(): PlaywrightLike | undefined {
  try {
    return createRequire(import.meta.url)('playwright') as PlaywrightLike;
  } catch {
    return undefined;
  }
}

const playwright = loadPlaywright();
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  return port;
}

async function environment(extra: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ehub-admin-ui-'));
  directories.push(root);
  const state = new FileSyncStateRepository({ directory: join(root, 'sync') });
  await state.saveResource(
    {
      tenantId: TENANT_ID,
      courseId: 12,
      resourceId: '702:file:/Consultation checklist.pdf',
      moduleId: 702,
      status: 'failed',
      failureCategory: 'moodle_unavailable',
      observed: { metadataHash: 'a'.repeat(64) },
      retryCount: 1,
      lastJobId: 'j',
      lastJobType: 'incremental',
      updatedAt: new Date().toISOString(),
    },
    null,
  );
  return {
    root,
    env: {
      NODE_ENV: 'development',
      PORT: String(await freePort()),
      AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
      AZURE_SEARCH_API_KEY: API_KEY,
      AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
      AZURE_TENANT_ID: TENANT_ID,
      AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
      AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
      AZURE_OPENAI_API_KEY: OPENAI_KEY,
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
      AZURE_OPENAI_EMBEDDING_DIMENSIONS: String(TEST_DIMENSIONS),
      SYNC_COURSE_IDS: '12',
      SYNC_STATE_DIR: join(root, 'sync'),
      ADMIN_UI_ENABLED: 'true',
      ADMIN_STATE_DIR: join(root, 'admin'),
      API_DEV_MOCK_IDENTITY: 'true',
      API_DEV_MOCK_COURSE_IDS: '12',
      ...extra,
    },
  };
}

async function serve(
  env: Record<string, string>,
  during: (url: string) => Promise<void>,
): Promise<{ exitCode: number | undefined; output: string }> {
  const { client } = await seededSearch();
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: TEST_DIMENSIONS });
  const output: string[] = [];
  const context: CommandContext = {
    args: [],
    logger: createLogger({ service: 'test', level: 'silent' }),
    stdout: (text) => output.push(text),
  };
  const exitCode = await createApiCommands({
    env,
    serve: {
      env,
      createSearch: () => Promise.resolve(client),
      createChat: () => Promise.resolve(new ScriptedChatModel([modelAnswer()])),
      createEmbedder: (settings) => createEmbeddingProvider(settings, { fetch: embeddings.fetch }),
      admin: {
        runJob: (_services, _job, jobId): Promise<SyncReport> =>
          Promise.resolve({
            jobId,
            jobType: 'course',
            dryRun: false,
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
            counts: { processed: 1, skipped: 0, updated: 1, removed: 0, failed: 0 },
            breakdown: {} as SyncReport['breakdown'],
            courses: [],
            resources: [],
            warnings: [],
          }),
        openSyncServices: () => Promise.resolve({} as never),
      },
      waitForShutdown: (server) => during(server.url),
    },
  })['serve']?.run(context);
  return { exitCode, output: output.join('\n') };
}

describe.skipIf(playwright === undefined)('administration page in a browser', () => {
  it('lets a content administrator see content pages and re-index after confirming', async () => {
    const { root, env } = await environment({ API_DEV_MOCK_ROLES: 'EHub.ContentAdministrator' });
    const problems: string[] = [];
    const result = await serve(env, async (url) => {
      const browser = await playwright!.chromium.launch();
      try {
        const page = await browser.newPage();
        page.on('console', (message) => {
          if (message.type?.() === 'error') {
            problems.push(message.text?.() ?? 'console error');
          }
        });
        page.on('pageerror', (error) => problems.push(error.message ?? 'page error'));
        await page.goto(`${url}/admin/#dashboard`);
        await page.waitForFunction(pageReady, 'Dashboard');
        await page.waitForFunction(exists, '.cards');
        expect(await page.locator('#mode-banner').textContent()).toContain('Development mode');
        const nav = await page.locator('#nav').textContent();
        expect(nav).toContain('Courses');
        expect(nav).not.toContain('Identity mappings');
        expect(nav).not.toContain('Audit trail');
        expect(
          await page.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current'),
        ).toBe('page');
        expect(await page.locator('.cards').textContent()).toContain('Processing failures');

        await page.getByRole('link', { name: 'Courses' }).click();
        await page.waitForFunction(textIs, ['#page table caption', 'Courses'] as const);
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { document: MiniDocument }).document.activeElement?.id,
          ),
        ).toBe('page-title');
        await page.getByRole('button', { name: 'Re-index' }).click();
        const dialog = page.getByRole('dialog', { name: 'Re-index course' });
        expect(await dialog.isVisible()).toBe(true);
        // Escape cancels: nothing is started.
        await page.keyboard.press('Escape');
        await page.waitForFunction(textIs, ['#status', 'Re-index cancelled.'] as const);
        await page.getByRole('button', { name: 'Re-index' }).click();
        await page.getByRole('button', { name: 'Re-index', exact: true }).last().click();
        await page.waitForFunction(textStarts, ['#status', 'Job started'] as const);

        await page.getByRole('link', { name: 'Failures' }).click();
        await page.waitForFunction(pageReady, 'Failures');
        await page.waitForFunction(textIs, [
          '#page table caption',
          'Resources that failed processing',
        ] as const);
        expect(await page.locator('#page table').textContent()).toContain('moodle_unavailable');

        // A page the role cannot use falls back to the first allowed one.
        await page.goto(`${url}/admin/#identity`);
        await page.waitForFunction(pageReady, 'Dashboard');
      } finally {
        await browser.close();
      }
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('/admin (DEVELOPMENT MOCK IDENTITY)');
    expect(problems).toEqual([]);
    const audit = readdirSync(join(root, 'admin', 'audit'));
    expect(audit).toHaveLength(1);
    const lines = readFileSync(join(root, 'admin', 'audit', audit[0] ?? ''), 'utf8')
      .trim()
      .split('\n');
    expect(
      lines.map((line) => (JSON.parse(line) as { action: string; outcome: string }).action),
    ).toEqual(['course.reindex']);
  });

  it('shows an auditor read-only pages with no action buttons, and errors accessibly', async () => {
    const { env } = await environment({ API_DEV_MOCK_ROLES: 'EHub.Auditor' });
    const result = await serve(env, async (url) => {
      const browser = await playwright!.chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${url}/admin/#courses`);
        await page.waitForFunction(textIs, ['#page table caption', 'Courses'] as const);
        expect(await page.getByRole('button', { name: 'Re-index' }).count()).toBe(0);
        await page.getByRole('link', { name: 'Audit trail' }).click();
        await page.waitForFunction(pageReady, 'Audit trail');
        // A forged request from the page context is still refused by the server.
        const status = await page.evaluate(() =>
          fetch('/admin/api/actions/incremental-sync', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-ehub-mock-identity': 'dev-mock-user',
            },
            body: '{}',
          }).then((response) => response.status),
        );
        expect(status).toBe(403);
        await page.getByRole('link', { name: 'Identity mappings' }).click();
        await page.waitForFunction(textHas, ['#page', 'not configured'] as const);
      } finally {
        await browser.close();
      }
    });
    expect(result.exitCode, result.output).toBe(0);
  });
});

describe('administration area setup', () => {
  it('refuses production without the admin page registration', async () => {
    const { env } = await environment({
      NODE_ENV: 'production',
      ENTRA_API_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
      ENTRA_ALLOWED_CLIENT_APP_IDS: '44444444-4444-4444-8444-444444444444',
      MOODLE_TOKEN: 'moodle-token-0123456789abcdef',
      MOODLE_BASE_URL: 'https://ehub.example.test',
      API_DEV_MOCK_IDENTITY: 'false',
    });
    const missing = await serve(env, () => Promise.resolve());
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('ADMIN_SPA_CLIENT_ID');
    const unlisted = await serve(
      { ...env, ADMIN_SPA_CLIENT_ID: '55555555-5555-4555-8555-555555555555' },
      () => Promise.resolve(),
    );
    expect(unlisted.exitCode).toBe(1);
    expect(unlisted.output).toContain('ENTRA_ALLOWED_CLIENT_APP_IDS');
  });

  it('serves no admin routes unless enabled', async () => {
    const { env } = await environment({ ADMIN_UI_ENABLED: 'false' });
    const result = await serve(env, async (url) => {
      expect((await fetch(`${url}/admin`)).status).toBe(404);
      expect((await fetch(`${url}/admin/api/client-config`)).status).toBe(404);
    });
    expect(result.exitCode).toBe(0);
  });
});
