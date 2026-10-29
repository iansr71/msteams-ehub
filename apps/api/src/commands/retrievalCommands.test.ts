import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import { placeholderVector } from '../../../../packages/shared/src/search/__fixtures__/documents.js';
import {
  API_KEY,
  SECRET_SENTENCE,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from '../retrieval/__fixtures__/corpus.js';
import { createApiCommands, createEvaluationCommands } from './index.js';
import type { RetrievalCommandDependencies } from './retrievalCommands.js';

const env = {
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_API_KEY: API_KEY,
  AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
  AZURE_TENANT_ID: TENANT_ID,
};

async function run(
  which: 'retrieve' | 'evaluation',
  args: string[],
  options: {
    env?: Record<string, string>;
    files?: Record<string, string>;
    failSearch?: boolean;
  } = {},
) {
  const { client, service } = await seededSearch();
  if (options.failSearch === true) {
    for (let i = 0; i < 10; i += 1) {
      service.scriptedResponses.push({ status: 401, body: '' });
    }
  }
  const output: string[] = [];
  const logs: string[] = [];
  const context: CommandContext = {
    args,
    logger: createLogger({
      service: 'test',
      level: 'trace',
      sink: { write: (line) => logs.push(line) },
    }),
    stdout: (text) => output.push(text),
  };
  const retrieval: RetrievalCommandDependencies = {
    env: options.env ?? env,
    cwd: '/work',
    createSearch: () => Promise.resolve(client),
    readTextFile: (path) => {
      const text = options.files?.[path];
      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
    },
  };
  const commands =
    which === 'retrieve'
      ? createApiCommands({ env: retrieval.env, retrieval })
      : createEvaluationCommands({ env: retrieval.env, retrieval });
  const command = commands[which === 'retrieve' ? 'retrieve' : 'retrieval'];
  if (command === undefined) {
    throw new Error('missing command');
  }
  const exitCode = await command.run(context);
  const stdout = output.join('\n');
  const logText = logs.join('\n');
  for (const text of [stdout, logText]) {
    expect(text).not.toContain(API_KEY);
  }
  return { exitCode, stdout, logText, service };
}

describe('pnpm api retrieve', () => {
  it('prints ranked metadata and scores, without content', async () => {
    const result = await run('retrieve', ['--question', 'sunscreen peel', '--course-id', '12']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Retrieval: keyword + semantic ranking');
    expect(result.stdout).toContain(' 1. score ');
    expect(result.stdout).toContain('resource 701:chapter:11 (moodle-book-chapter)');
    expect(result.stdout).not.toContain(SECRET_SENTENCE);
    expect(result.logText).not.toContain('sunscreen peel');
  });

  it('prints short sanitised excerpts only with --excerpts, and JSON with --json', async () => {
    const result = await run('retrieve', [
      '--question',
      'sunscreen peel',
      '--course-id',
      '12',
      '--excerpts',
      '--json',
    ]);
    const parsed = JSON.parse(result.stdout) as {
      results: { excerpt?: string; courseId: number }[];
    };
    expect(parsed.results[0]?.excerpt?.length).toBeLessThanOrEqual(160);
    expect(parsed.results.every((entry) => entry.courseId === 12)).toBe(true);
  });

  it('restricts to the given courses and resource types inside the search request', async () => {
    const result = await run('retrieve', [
      '--question',
      'laser eye protection',
      '--course-id',
      '12',
      '--resource-type',
      'moodle-page',
      '--top-k',
      '3',
      '--json',
    ]);
    const parsed = JSON.parse(result.stdout) as { topK: number; results: { resourceId: string }[] };
    expect(parsed.topK).toBe(3);
    expect(parsed.results.map((entry) => entry.resourceId)).toEqual(['703:page']);
    const body = JSON.parse(result.service.requests.at(-1)?.body ?? '{}') as { filter: string };
    expect(body.filter).toBe(
      `tenantId eq '${TENANT_ID}' and isActive eq true and (courseId eq 12) and search.in(resourceType, 'moodle-page', ',')`,
    );
  });

  it('runs hybrid retrieval with a vector file resolved against the caller directory', async () => {
    const vector = JSON.stringify(placeholderVector('laser', TEST_DIMENSIONS));
    const result = await run(
      'retrieve',
      ['--question', 'laser', '--course-id', '12,13', '--vector-file', 'q.json', '--json'],
      { files: { '/work/q.json': vector } },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'hybrid' });
  });

  it.each([
    [['--question', 'x'], '--course-id: is required.'],
    [['--course-id', '12'], '--question: is required.'],
    [['--question', 'x', '--course-id', '0'], '--course-id'],
    [['--question', 'x', '--course-id', '12', '--resource-type', 'exe'], '--resource-type'],
    [['--question', 'x', '--course-id', '12', '--top-k', '99'], '--top-k'],
    [['--question', 'x', '--course-id', '12', '--all'], 'Unknown option: --all'],
  ])('rejects %j with the usage exit code', async (args, message) => {
    const result = await run('retrieve', args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(message);
    expect(
      result.service.requests.filter((request) => request.path.endsWith('/docs/search')),
    ).toHaveLength(0);
  });

  it('requires a vector for vector mode, and the tenant and search configuration', async () => {
    const noVector = await run('retrieve', [
      '--question',
      'x',
      '--course-id',
      '12',
      '--mode',
      'vector',
    ]);
    expect(noVector.exitCode).toBe(1);
    expect(noVector.stdout).toContain('needs a query vector');

    const noTenant = await run('retrieve', ['--question', 'x', '--course-id', '12'], {
      env: { ...env, AZURE_TENANT_ID: '' },
    });
    expect(noTenant.exitCode).toBe(1);
    expect(noTenant.stdout).toContain('AZURE_TENANT_ID: Required.');

    const badVector = await run(
      'retrieve',
      ['--question', 'x', '--course-id', '12', '--vector-file', 'v.json'],
      { files: { '/work/v.json': '[1, "two"]' } },
    );
    expect(badVector.exitCode).toBe(1);
    expect(badVector.stdout).toContain('JSON array of numbers');
  });
});

describe('pnpm evaluation retrieval', () => {
  const cases = JSON.stringify([
    {
      id: 'aftercare',
      question: 'sunscreen after a peel',
      authorizedCourseIds: ['12'],
      expectedResourceIds: ['701:chapter:11'],
    },
    {
      id: 'leak',
      question: 'laser eye protection goggles',
      authorizedCourseIds: ['12'],
      forbiddenResourceIds: ['801'],
    },
  ]);

  it('passes, prints metrics and exits 0', async () => {
    const result = await run('evaluation', ['--file', 'cases.json'], {
      files: { '/work/cases.json': cases },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS aftercare first expected at rank 1');
    expect(result.stdout).toContain('PASS leak');
    expect(result.stdout).toContain('Hit@1 100.0%');
    expect(result.stdout).not.toContain(SECRET_SENTENCE);
  });

  it('exits 1 when a case fails and supports --case and --json', async () => {
    const failing = JSON.stringify([
      {
        id: 'miss',
        question: 'sunscreen',
        authorizedCourseIds: ['12'],
        expectedResourceIds: ['999'],
      },
      { id: 'skip', question: 'sunscreen', authorizedCourseIds: ['12'] },
    ]);
    const result = await run('evaluation', ['--file', 'f.json', '--case', 'miss', '--json'], {
      files: { '/work/f.json': failing },
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { summary: { cases: number; failed: number } };
    expect(parsed.summary).toMatchObject({ cases: 1, failed: 1 });
  });

  it('reports file problems by case and field', async () => {
    const result = await run('evaluation', ['--file', 'bad.json'], {
      files: {
        '/work/bad.json': JSON.stringify([{ id: 'x', question: 'q', authorizedCourseIds: [] }]),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('0.authorizedCourseIds');
    const missing = await run('evaluation', ['--file', 'nope.json']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('could not be read');
  });

  it('stops at the first authentication failure instead of failing every case', async () => {
    const result = await run('evaluation', ['--file', 'cases.json'], {
      files: { '/work/cases.json': cases },
      failSearch: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Retrieval evaluation failed: authentication');
    expect(
      result.service.requests.filter((request) => request.path.endsWith('/docs/search')),
    ).toHaveLength(1);
  });
});
