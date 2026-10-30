import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createLogger, type CommandContext } from '@ehub/shared';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';
import { describe, expect, it } from 'vitest';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import {
  ScriptedChatModel,
  modelAnswer,
  type ScriptedStep,
} from '../rag/__fixtures__/scriptedChatModel.js';
import { INSUFFICIENT_EVIDENCE_MESSAGE } from '../rag/answerSchema.js';
import { AnswerEvaluationRunner, type Answerer } from '../rag/answerEvaluationRunner.js';
import type { RagAnswer } from '../rag/ragService.js';
import {
  API_KEY,
  SECRET_SENTENCE,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from '../retrieval/__fixtures__/corpus.js';
import { parseEvaluationFile } from '../retrieval/evaluationCases.js';
import { createEvaluationCommands } from './index.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const template = readFileSync(
  join(repoRoot, 'tests', 'evaluation', 'retrieval-cases.json'),
  'utf8',
);
const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';

const env = {
  AZURE_SEARCH_ENDPOINT: 'https://search.example.test',
  AZURE_SEARCH_API_KEY: API_KEY,
  AZURE_SEARCH_VECTOR_DIMENSIONS: String(TEST_DIMENSIONS),
  AZURE_TENANT_ID: TENANT_ID,
  AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com',
  AZURE_OPENAI_CHAT_DEPLOYMENT: 'chat',
  AZURE_OPENAI_API_KEY: OPENAI_KEY,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: String(TEST_DIMENSIONS),
  CITATION_ALLOWED_HOSTS: 'ehub.example.test',
};

const laserAnswer = modelAnswer({
  answer: 'Laser treatments require eye protection goggles rated for the laser wavelength.',
  claims: [{ text: 'Laser treatments require eye protection goggles.', sourceIds: ['S1'] }],
});
const insufficient = modelAnswer({ answer: 'n/a', claims: [], insufficientEvidence: true });

async function run(
  args: string[],
  steps: ScriptedStep[],
  files: Record<string, string> = { '/work/cases.json': template },
) {
  const { client } = await seededSearch();
  const model = new ScriptedChatModel(steps);
  const embeddings = new FakeEmbeddingService({ apiKey: OPENAI_KEY, dimensions: TEST_DIMENSIONS });
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
  const command = createEvaluationCommands({
    env,
    ask: {
      env,
      cwd: '/work',
      createSearch: () => Promise.resolve(client),
      createChat: () => Promise.resolve(model),
      createEmbedder: (settings) => createEmbeddingProvider(settings, { fetch: embeddings.fetch }),
      readTextFile: (path) => {
        const text = files[path];
        return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
      },
    },
  })['answers'];
  if (command === undefined) {
    throw new Error('missing command');
  }
  const exitCode = await command.run(context);
  const stdout = output.join('\n');
  for (const text of [stdout, logs.join('\n')]) {
    expect(text).not.toContain(SECRET_SENTENCE);
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain('How often should a client reapply sunscreen');
  }
  return { exitCode, stdout };
}

describe('pnpm evaluation answers', () => {
  it('passes the template when answers cite the expected sources and leak checks hold', async () => {
    const result = await run(['--file', 'cases.json'], [modelAnswer(), insufficient, laserAnswer]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS case-001 answered cites [1] 701:chapter:11');
    expect(result.stdout).toContain('PASS case-002 insufficient_evidence');
    expect(result.stdout).toContain('PASS case-003 answered cites [1] 801:chapter:3');
    expect(result.stdout).toContain('Answers without a valid source: 0 (must be 0)');
  });

  it('fails a case whose expected answer is refused, and supports --case and --json', async () => {
    const result = await run(
      ['--file', 'cases.json', '--case', 'case-001', '--json'],
      [insufficient],
    );
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      summary: { cases: number; failed: number };
      cases: { failures: string[] }[];
    };
    expect(parsed.summary).toMatchObject({ cases: 1, failed: 1 });
    expect(parsed.cases[0]?.failures).toEqual(['unexpected_insufficient_evidence']);
  });

  it('fails a case that expected insufficient evidence but got an answer', async () => {
    const cases = JSON.stringify([
      {
        id: 'unanswerable',
        question: 'sunscreen peel',
        authorizedCourseIds: ['12'],
        expectInsufficientEvidence: true,
      },
    ]);
    const result = await run(['--file', 'u.json'], [modelAnswer()], { '/work/u.json': cases });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAIL unanswerable answered (expected_insufficient_evidence)');
  });
});

describe('AnswerEvaluationRunner source assertion', () => {
  const [testCase] = parseEvaluationFile(
    JSON.stringify([
      { id: 'x', question: 'q', authorizedCourseIds: ['12'], forbiddenResourceIds: ['801'] },
    ]),
  );
  const base: RagAnswer = {
    status: 'answered',
    answer: 'An answer.',
    claims: [{ text: 'An answer.', citationIds: [1], chunkIds: ['a'] }],
    citations: [],
    removedClaims: 0,
    insufficientEvidence: false,
    conflictingSources: false,
    warnings: [],
    modelWarnings: [],
    sources: [],
    model: 'm',
    generationAttempts: 1,
    durationMs: 1,
  };
  const answerer = (answer: RagAnswer): Answerer => ({ ask: () => Promise.resolve(answer) });

  it('fails any answer without a valid source unless it is the explicit insufficient response', async () => {
    if (testCase === undefined) {
      throw new Error('fixture');
    }
    const noSource = await new AnswerEvaluationRunner({
      answerer: answerer(base),
      tenantId: TENANT_ID,
    }).run([testCase]);
    expect(noSource.cases[0]?.failures).toEqual(['no_valid_source']);
    expect(noSource.summary.answersWithoutValidSource).toBe(1);

    const disguised = await new AnswerEvaluationRunner({
      answerer: answerer({
        ...base,
        status: 'insufficient_evidence',
        insufficientEvidence: true,
        claims: [],
        answer: 'I think so.',
      }),
      tenantId: TENANT_ID,
    }).run([testCase]);
    expect(disguised.cases[0]?.failures).toEqual(['no_valid_source']);

    const explicit = await new AnswerEvaluationRunner({
      answerer: answerer({
        ...base,
        status: 'insufficient_evidence',
        insufficientEvidence: true,
        claims: [],
        answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      }),
      tenantId: TENANT_ID,
    }).run([testCase]);
    expect(explicit.cases[0]?.passed).toBe(true);
  });

  it('fails citations of unauthorised courses or forbidden resources', async () => {
    if (testCase === undefined) {
      throw new Error('fixture');
    }
    const citation = {
      citationId: 1,
      chunkId: 'a',
      courseId: 13,
      courseName: 'Laser Safety',
      sectionName: 's',
      moduleId: 801,
      resourceId: '801:chapter:3',
      resourceName: 'r',
      resourceType: 'moodle-book-chapter',
      pageNumber: undefined,
      pageNumberEnd: undefined,
      slideNumber: undefined,
      sourceUrl: undefined,
      excerpt: 'e',
    };
    const report = await new AnswerEvaluationRunner({
      answerer: answerer({ ...base, citations: [citation] }),
      tenantId: TENANT_ID,
    }).run([testCase]);
    expect(report.cases[0]?.failures).toEqual([
      'unauthorized_citation',
      'forbidden_resource_cited',
    ]);
  });
});
