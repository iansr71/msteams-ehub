import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SECRET_SENTENCE, TENANT_ID, seededSearch } from './__fixtures__/corpus.js';
import {
  EvaluationFileError,
  parseEvaluationFile,
  type EvaluationCase,
} from './evaluationCases.js';
import { renderEvaluationText } from './evaluationOutput.js';
import {
  EvaluationRunner,
  summarize,
  type CaseResult,
  type Retriever,
} from './evaluationRunner.js';
import type { RetrievedChunk } from './retrievalResultMapper.js';
import type { RetrievalResult } from './retrievalService.js';
import { RetrievalService } from './retrievalService.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const templateFile = join(repoRoot, 'tests', 'evaluation', 'retrieval-cases.json');

const settings = {
  topK: 8,
  maxChunksPerResource: 3,
  candidateCount: 24,
  semanticRanking: true,
  minScore: undefined,
  minRerankerScore: undefined,
};

function file(cases: unknown): string {
  return JSON.stringify(cases);
}

const minimalCase = {
  id: 'case-1',
  question: 'What SPF?',
  authorizedCourseIds: ['12'],
};

describe('evaluation file format', () => {
  it('accepts the shipped template and normalises course IDs to numbers', () => {
    const cases = parseEvaluationFile(readFileSync(templateFile, 'utf8'));
    expect(cases.map((testCase) => testCase.id)).toEqual(['case-001', 'case-002', 'case-003']);
    expect(cases[0]).toMatchObject({ authorizedCourseIds: [12], expectedCourseIds: [12] });
  });

  it('fills defaults and accepts numeric IDs', () => {
    const [testCase] = parseEvaluationFile(file([{ ...minimalCase, authorizedCourseIds: [12] }]));
    expect(testCase).toMatchObject({
      authorizedCourseIds: [12],
      expectedCourseIds: [],
      expectedResourceIds: [],
      forbiddenResourceIds: [],
    });
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['an empty list', '[]', /invalid/],
    ['a duplicate ID', file([minimalCase, minimalCase]), /invalid/],
    [
      'an expected course outside the authorised set',
      file([{ ...minimalCase, expectedCourseIds: ['13'] }]),
      /invalid/,
    ],
    [
      'a selected course outside the authorised set',
      file([{ ...minimalCase, courseIds: ['13'] }]),
      /invalid/,
    ],
    [
      'an expected resource that is also forbidden',
      file([{ ...minimalCase, expectedResourceIds: ['701'], forbiddenResourceIds: ['701'] }]),
      /invalid/,
    ],
    ['an unknown field', file([{ ...minimalCase, authorisedCourseIds: ['12'] }]), /invalid/],
    [
      'a non-numeric course ID',
      file([{ ...minimalCase, authorizedCourseIds: ['12 or 1 eq 1'] }]),
      /invalid/,
    ],
    ['an unsupported resource type', file([{ ...minimalCase, resourceTypes: ['exe'] }]), /invalid/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseEvaluationFile(text)).toThrow(EvaluationFileError);
    expect(() => parseEvaluationFile(text)).toThrow(message);
  });

  it('names the case and field in problems without echoing values', () => {
    try {
      parseEvaluationFile(file([{ ...minimalCase, authorizedCourseIds: ['secret-value'] }]));
    } catch (error) {
      const problems = (error as EvaluationFileError).problems;
      expect(problems[0]).toMatch(/^0\.authorizedCourseIds\.0: /);
      expect(problems.join(' ')).not.toContain('secret-value');
      return;
    }
    throw new Error('expected failure');
  });
});

function chunk(rank: number, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    rank,
    chunkId: 'a'.repeat(64),
    courseId: 12,
    courseName: 'Course',
    sectionId: 1,
    sectionName: 'Section',
    moduleId: 700 + rank,
    moduleName: 'Module',
    resourceId: `${String(700 + rank)}:page`,
    resourceName: 'Resource',
    resourceType: 'moodle-page',
    title: 'Title',
    headingPath: [],
    pageNumber: undefined,
    pageNumberEnd: undefined,
    slideNumber: undefined,
    chunkNumber: 1,
    chunkCount: 1,
    sourceUrl: undefined,
    moduleUrl: undefined,
    modifiedAt: undefined,
    score: 1 / rank,
    rerankerScore: undefined,
    content: SECRET_SENTENCE,
    ...overrides,
  };
}

function stub(chunksFor: (testCase: string) => RetrievedChunk[] | Error): Retriever {
  return {
    retrieve: (request) => {
      const outcome = chunksFor(request.question);
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      const result: RetrievalResult = {
        chunks: outcome,
        mode: 'keyword',
        semanticApplied: false,
        topK: 8,
        candidates: outcome.length,
        droppedBelowThreshold: 0,
        droppedByResourceCap: 0,
        durationMs: 1,
      };
      return Promise.resolve(result);
    },
  };
}

const makeCase = (id: string, overrides: Partial<EvaluationCase> = {}): EvaluationCase => ({
  id,
  question: id,
  authorizedCourseIds: [12],
  expectedCourseIds: [],
  expectedResourceIds: [],
  forbiddenResourceIds: [],
  ...overrides,
});

describe('EvaluationRunner', () => {
  it('scores ranks, matches resource or activity IDs, and computes hit@k and MRR', async () => {
    const cases = [
      makeCase('rank1', { expectedResourceIds: ['701:page'] }),
      makeCase('rank3', { expectedResourceIds: ['703'] }),
      makeCase('rank5', { expectedResourceIds: ['705:page', '799'] }),
      makeCase('missing', { expectedResourceIds: ['999'] }),
      makeCase('unscored'),
    ];
    const retriever = stub(() => [1, 2, 3, 4, 5].map((rank) => chunk(rank)));
    const report = await new EvaluationRunner({ retriever, tenantId: TENANT_ID }).run(cases);
    expect(
      report.cases.map((result) => [result.id, result.passed, result.firstExpectedRank]),
    ).toEqual([
      ['rank1', true, 1],
      ['rank3', true, 3],
      ['rank5', true, 5],
      ['missing', false, undefined],
      ['unscored', true, undefined],
    ]);
    expect(report.summary).toEqual({
      cases: 5,
      passed: 4,
      failed: 1,
      errored: 0,
      scoredCases: 4,
      hitAt1: 0.25,
      hitAt3: 0.5,
      hitAt5: 0.75,
      meanReciprocalRank: Math.round(((1 + 1 / 3 + 1 / 5) / 4) * 10_000) / 10_000,
    });
  });

  it('fails a case on forbidden resources, unauthorised courses and missing expected courses', async () => {
    const retriever = stub((question) =>
      question === 'leak' ? [chunk(1, { courseId: 13 })] : [chunk(1), chunk(2, { moduleId: 801 })],
    );
    const report = await new EvaluationRunner({ retriever, tenantId: TENANT_ID }).run([
      makeCase('forbidden', { forbiddenResourceIds: ['801'] }),
      makeCase('leak'),
      makeCase('course', { authorizedCourseIds: [12, 13], expectedCourseIds: [13] }),
    ]);
    expect(report.cases.map((result) => result.failures)).toEqual([
      ['forbidden_resource'],
      ['unauthorized_course'],
      ['expected_course_missing'],
    ]);
  });

  it('counts errors as failed misses, and stops on fatal errors', async () => {
    const failing = stub(() => new Error('boom'));
    const report = await new EvaluationRunner({ retriever: failing, tenantId: TENANT_ID }).run([
      makeCase('a', { expectedResourceIds: ['701'] }),
    ]);
    expect(report.cases[0]).toMatchObject({ passed: false, failures: ['error'], error: 'Error' });
    expect(report.summary).toMatchObject({
      errored: 1,
      scoredCases: 1,
      hitAt1: 0,
      meanReciprocalRank: 0,
    });

    await expect(
      new EvaluationRunner({ retriever: failing, tenantId: TENANT_ID, isFatal: () => true }).run([
        makeCase('a'),
      ]),
    ).rejects.toThrow('boom');
  });

  it('reports zero metrics when no case has expected resources', () => {
    const results: CaseResult[] = [
      { id: 'x', passed: true, failures: [], firstExpectedRank: undefined, results: [] },
    ];
    expect(summarize(results, [makeCase('x')])).toMatchObject({
      scoredCases: 0,
      hitAt1: 0,
      meanReciprocalRank: 0,
    });
  });

  it('runs the shipped template against the fixture corpus and never prints content', async () => {
    const { client } = await seededSearch();
    const runner = new EvaluationRunner({
      retriever: new RetrievalService({ search: client, settings }),
      tenantId: TENANT_ID,
    });
    const report = await runner.run(parseEvaluationFile(readFileSync(templateFile, 'utf8')));
    expect(
      report.cases.map((result) => [result.id, result.passed, result.firstExpectedRank]),
    ).toEqual([
      ['case-001', true, 1],
      ['case-002', true, undefined],
      ['case-003', true, 1],
    ]);
    expect(report.summary).toMatchObject({ hitAt1: 1, meanReciprocalRank: 1 });
    const text = renderEvaluationText(report);
    expect(text).toContain('Hit@1 100.0% | Hit@3 100.0% | Hit@5 100.0% | MRR 1.000');
    expect(text).not.toContain(SECRET_SENTENCE);
  });
});
