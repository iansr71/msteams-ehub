import { createLogger } from '@ehub/shared';
import { SearchScopeError, buildSearchRequest } from '@ehub/shared/search';
import { describe, expect, it } from 'vitest';

import { placeholderVector } from '../../../../packages/shared/src/search/__fixtures__/documents.js';
import {
  SECRET_SENTENCE,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from './__fixtures__/corpus.js';
import { RetrievalDiagnostics, sanitizeExcerpt } from './retrievalDiagnostics.js';
import { RetrievalRequestError, RetrievalService } from './retrievalService.js';
import { SearchQueryBuilder, retrievalRequestSchema } from './searchQueryBuilder.js';
import type { RetrievalSettings } from './settings.js';

const settings: RetrievalSettings = {
  topK: 8,
  maxChunksPerResource: 3,
  candidateCount: 24,
  semanticRanking: true,
  minScore: undefined,
  minRerankerScore: undefined,
};

const base = { tenantId: TENANT_ID, authorizedCourseIds: [12] };

function build(
  request: Parameters<typeof retrievalRequestSchema.parse>[0],
  overrides: Partial<RetrievalSettings> = {},
) {
  const built = new SearchQueryBuilder({ ...settings, ...overrides }).build(
    retrievalRequestSchema.parse(request),
  );
  return {
    ...built,
    plan: buildSearchRequest(built.query, {
      vectorDimensions: TEST_DIMENSIONS,
      semanticEnabled: true,
    }),
  };
}

describe('SearchQueryBuilder', () => {
  it('builds a keyword query with every restriction in the filter', () => {
    const { mode, topK, plan } = build({
      ...base,
      authorizedCourseIds: [12, 13],
      courseIds: [13],
      resourceTypes: ['pdf', 'moodle-page'],
      question: '  What   SPF?  ',
    });
    expect(mode).toBe('keyword');
    expect(topK).toBe(8);
    expect(plan.body).toMatchObject({
      search: 'What SPF?',
      top: 24,
      queryType: 'semantic',
      semanticConfiguration: 'ehub-semantic',
      filter: `tenantId eq '${TENANT_ID}' and isActive eq true and (courseId eq 13) and search.in(resourceType, 'pdf,moodle-page', ',')`,
    });
    expect(plan.body).not.toHaveProperty('vectorQueries');
  });

  it('builds hybrid and vector queries when a vector is supplied', () => {
    const vector = placeholderVector('q', TEST_DIMENSIONS);
    const hybrid = build({ ...base, question: 'peel', queryVector: vector });
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.plan.body).toMatchObject({
      search: 'peel',
      vectorFilterMode: 'preFilter',
      vectorQueries: [expect.objectContaining({ k: 24, fields: 'contentVector' })],
    });
    const vectorOnly = build({ ...base, question: 'peel', queryVector: vector, mode: 'vector' });
    expect(vectorOnly.plan.body).not.toHaveProperty('search');
    expect(vectorOnly.plan.semantic).toBe(false);
    expect(() =>
      retrievalRequestSchema.parse({ ...base, question: 'peel', mode: 'hybrid' }),
    ).toThrow(/needs a query vector/);
  });

  it('honours top K, candidate count and the semantic setting', () => {
    expect(build({ ...base, question: 'x', topK: 40 }).plan.body['top']).toBe(40);
    expect(build({ ...base, question: 'x' }, { candidateCount: 8 }).plan.body['top']).toBe(8);
    expect(
      build({ ...base, question: 'x' }, { semanticRanking: false }).plan.body['queryType'],
    ).toBe('simple');
  });

  it('removes control and bidirectional characters from the question', () => {
    const { plan } = build({ ...base, question: 'peel\u0000\u001b[31m\u202eaftercare\n' });
    expect(plan.body['search']).toBe('peel [31m aftercare');
  });

  it('rejects unsupported filter values before they reach an expression', () => {
    for (const bad of [
      { ...base, question: 'x', resourceTypes: ["pdf') or true or ('"] },
      { ...base, question: 'x', authorizedCourseIds: [0] },
      { ...base, question: 'x', authorizedCourseIds: [1.5] },
      { ...base, question: 'x', authorizedCourseIds: [] },
      { ...base, question: '   ' },
      { ...base, question: 'x'.repeat(1001) },
      { ...base, question: 'x', topK: 51 },
      { ...base, question: 'x', extra: true },
    ]) {
      expect(retrievalRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(() => build({ ...base, tenantId: "t' or '1", question: 'x' })).toThrow(/tenant ID/);
    expect(() => build({ ...base, courseIds: [13], question: 'x' })).toThrow(SearchScopeError);
  });
});

describe('RetrievalService', () => {
  it('never returns another course, even when it matches the question better', async () => {
    const { client } = await seededSearch();
    const service = new RetrievalService({ search: client, settings });
    const result = await service.retrieve({
      ...base,
      question: 'What laser eye protection goggles are required?',
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(new Set(result.chunks.map((chunk) => chunk.courseId))).toEqual(new Set([12]));
    expect(result.chunks.map((chunk) => chunk.resourceId)).not.toContain('801:chapter:3');

    const authorized = await service.retrieve({
      ...base,
      authorizedCourseIds: [12, 13],
      question: 'What laser eye protection goggles are required?',
    });
    expect(authorized.chunks[0]?.resourceId).toBe('801:chapter:3');
  });

  it('refuses a selected course outside the authorised set, before searching', async () => {
    const { client, service: fake } = await seededSearch();
    const service = new RetrievalService({ search: client, settings });
    const before = fake.requests.length;
    await expect(
      service.retrieve({ ...base, courseIds: [13], question: 'laser' }),
    ).rejects.toMatchObject({ code: 'course_not_authorized' });
    await expect(
      service.retrieve({ ...base, authorizedCourseIds: [], question: 'laser' }),
    ).rejects.toBeInstanceOf(RetrievalRequestError);
    expect(fake.requests.length).toBe(before);
  });

  it('never returns inactive content or another tenant', async () => {
    const { client } = await seededSearch();
    const service = new RetrievalService({ search: client, settings });
    const result = await service.retrieve({
      ...base,
      question: 'withdrawn other tenant sunscreen peel',
    });
    expect(result.chunks.map((chunk) => chunk.resourceId)).not.toContain('704:page');
    expect(result.chunks.map((chunk) => chunk.resourceId)).not.toContain('705:page');
  });

  it('caps chunks per resource and renumbers ranks', async () => {
    const { client } = await seededSearch();
    const service = new RetrievalService({ search: client, settings });
    const result = await service.retrieve({ ...base, question: 'sunscreen peel' });
    const fromAftercare = result.chunks.filter((chunk) => chunk.resourceId === '701:chapter:11');
    expect(fromAftercare).toHaveLength(3);
    expect(result.droppedByResourceCap).toBe(2);
    expect(result.chunks.map((chunk) => chunk.rank)).toEqual(
      result.chunks.map((_chunk, index) => index + 1),
    );
    const one = new RetrievalService({
      search: client,
      settings: { ...settings, maxChunksPerResource: 1, topK: 1 },
    });
    expect((await one.retrieve({ ...base, question: 'sunscreen peel' })).chunks).toHaveLength(1);
  });

  it('applies score and reranker thresholds', async () => {
    const { client } = await seededSearch();
    const strict = new RetrievalService({ search: client, settings: { ...settings, minScore: 3 } });
    const result = await strict.retrieve({ ...base, question: 'sunscreen peel exfoliation' });
    expect(result.chunks.map((chunk) => chunk.chunkNumber)).toEqual([3]);
    expect(result.droppedBelowThreshold).toBe(result.candidates - 1);
    const reranked = new RetrievalService({
      search: client,
      settings: { ...settings, minRerankerScore: 2.85 },
    });
    const top = await reranked.retrieve({ ...base, question: 'sunscreen peel' });
    expect(top.chunks.every((chunk) => (chunk.rerankerScore ?? 0) >= 2.85)).toBe(true);
    expect(top.chunks.length).toBe(2);
  });

  it('keeps question text and content out of logs and request errors', async () => {
    const { client } = await seededSearch();
    const lines: string[] = [];
    const service = new RetrievalService({
      search: client,
      settings,
      logger: createLogger({
        service: 'test',
        level: 'trace',
        sink: { write: (line) => lines.push(line) },
      }),
    });
    await service.retrieve({ ...base, question: 'confidential-question sunscreen' });
    expect(lines.join('\n')).not.toContain('confidential-question');
    expect(lines.join('\n')).not.toContain(SECRET_SENTENCE);
    const failure = await service
      .retrieve({ ...base, question: 'confidential-question', resourceTypes: ['nope' as 'pdf'] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetrievalRequestError);
    expect((failure as Error).message).not.toContain('confidential-question');
  });
});

describe('RetrievalDiagnostics', () => {
  it('prints metadata and scores but no content unless excerpts are requested', async () => {
    const { client } = await seededSearch();
    const result = await new RetrievalService({ search: client, settings }).retrieve({
      ...base,
      question: 'sunscreen peel',
    });
    const plain = new RetrievalDiagnostics();
    for (const output of [plain.renderText(result), plain.renderJson(result)]) {
      expect(output).not.toContain(SECRET_SENTENCE);
      expect(output).toContain('701:chapter:11');
      expect(output).toContain('reranker');
    }
    const json = JSON.parse(plain.renderJson(result)) as { results: Record<string, unknown>[] };
    expect(json.results[0]).toMatchObject({ rank: 1, courseId: 12, title: 'Sun protection' });
    expect(json.results[0]).not.toHaveProperty('excerpt');
    expect(json.results[0]).not.toHaveProperty('content');

    const withExcerpts = new RetrievalDiagnostics({ excerpts: true }).renderText(result);
    expect(withExcerpts).toContain('excerpt (untrusted source text)');
  });

  it('sanitises and bounds excerpts', () => {
    const excerpt = sanitizeExcerpt(
      `Line one\u001b[2J\n\u202eevil Bearer abc.def.ghi https://x.test/f?token=sekret ${'y'.repeat(500)}`,
    );
    expect(Array.from(excerpt).some((character) => character < ' ' || character === '\u202e')).toBe(
      false,
    );
    expect(excerpt).not.toContain('abc.def.ghi');
    expect(excerpt).not.toContain('sekret');
    expect(excerpt.length).toBeLessThanOrEqual(160);
  });
});
