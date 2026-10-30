import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from '../retrieval/retrievalResultMapper.js';
import { formatAnswerAsText, formatCitationLine } from './answerFormatter.js';
import { INSUFFICIENT_EVIDENCE_MESSAGE, type ModelAnswer } from './answerSchema.js';
import { AnswerSupportChecker, answerHasValidSources } from './answerSupportChecker.js';
import { selectExcerpt } from './citationBuilder.js';
import { approvedSourceUrl, resolveAllowedHosts, type CitationScope } from './citationValidator.js';
import { ClaimSupportValidator } from './claimSupportValidator.js';
import type { PromptSource } from './promptBuilder.js';

function chunk(id: string, overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    rank: 1,
    chunkId: id.repeat(64).slice(0, 64),
    courseId: 12,
    courseName: 'Consultation Skills',
    sectionId: 1,
    sectionName: 'Aftercare',
    moduleId: 701,
    moduleName: 'Aftercare handbook',
    resourceId: '701:file:/Aftercare.pdf',
    resourceName: 'Aftercare.pdf',
    resourceType: 'pdf',
    title: 'Sun protection',
    headingPath: ['Sun protection'],
    pageNumber: 3,
    pageNumberEnd: 4,
    slideNumber: undefined,
    chunkNumber: 1,
    chunkCount: 1,
    sourceUrl: 'https://ehub.example.test/pluginfile.php/1/mod_resource/content/1/Aftercare.pdf',
    moduleUrl: 'https://ehub.example.test/mod/resource/view.php?id=701',
    modifiedAt: undefined,
    score: 1,
    rerankerScore: 3,
    content:
      'Clients must reapply SPF 50 sunscreen every two hours after a chemical peel. Avoid direct sun for 7 days.',
    ...overrides,
  };
}

const s1 = chunk('a');
const s2 = chunk('b', {
  resourceId: '702:page',
  resourceName: 'Laser aftercare',
  resourceType: 'moodle-page',
  moduleId: 702,
  pageNumber: undefined,
  pageNumberEnd: undefined,
  sourceUrl: undefined,
  moduleUrl: 'https://ehub.example.test/mod/page/view.php?id=702',
  title: 'Cooling',
  content:
    'After laser treatment, apply a cool compress for 10 minutes. Do not use retinol for 5 days.',
});
const slides = chunk('c', {
  resourceId: '703:file:/Induction.pptx',
  resourceName: 'Induction.pptx',
  resourceType: 'pptx',
  moduleId: 703,
  pageNumber: undefined,
  pageNumberEnd: undefined,
  slideNumber: 6,
  title: 'Hygiene',
  content: 'Wash hands before and after every treatment.',
});
const otherCourse = chunk('d', {
  courseId: 13,
  courseName: 'Laser Safety',
  content: 'Restricted laser calibration settings for senior therapists only.',
});

const sources: PromptSource[] = [
  { sourceId: 'S1', chunk: s1 },
  { sourceId: 'S2', chunk: s2 },
  { sourceId: 'S3', chunk: slides },
  { sourceId: 'S4', chunk: otherCourse },
];

const scope: CitationScope = {
  tenantId: 'tenant-1',
  courseIds: new Set([12]),
  allowedHosts: new Set(['ehub.example.test']),
};

function model(
  claims: ModelAnswer['claims'],
  answer = 'Reapply SPF 50 sunscreen every two hours after a peel.',
): ModelAnswer {
  return { answer, claims, insufficientEvidence: false, conflictingSources: false, warnings: [] };
}

const checker = new AnswerSupportChecker({ excerptChars: 120 });

describe('citation validation', () => {
  it('builds a valid citation from retrieval metadata', () => {
    const result = checker.check(
      model([
        { text: 'Reapply SPF 50 sunscreen every two hours after a peel.', sourceIds: ['S1'] },
      ]),
      sources,
      scope,
    );
    expect(result.insufficientEvidence).toBe(false);
    expect(result.answer).toBe('Reapply SPF 50 sunscreen every two hours after a peel.');
    expect(result.citations).toEqual([
      {
        citationId: 1,
        chunkId: s1.chunkId,
        courseId: 12,
        courseName: 'Consultation Skills',
        sectionName: 'Aftercare',
        moduleId: 701,
        resourceId: '701:file:/Aftercare.pdf',
        resourceName: 'Aftercare.pdf',
        resourceType: 'pdf',
        pageNumber: 3,
        pageNumberEnd: 4,
        slideNumber: undefined,
        sourceUrl: 'https://ehub.example.test/mod/resource/view.php?id=701',
        excerpt: 'Clients must reapply SPF 50 sunscreen every two hours after a chemical peel.',
      },
    ]);
    expect(result.claims).toEqual([
      {
        text: 'Reapply SPF 50 sunscreen every two hours after a peel.',
        citationIds: [1],
        chunkIds: [s1.chunkId],
      },
    ]);
    expect(answerHasValidSources(result)).toBe(true);
  });

  it('rejects an invented source ID', () => {
    const result = checker.check(
      model([{ text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S9'] }]),
      sources,
      scope,
    );
    expect(result).toMatchObject({
      insufficientEvidence: true,
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
      citations: [],
    });
    expect(result.warnings).toContain('no_supported_claims');
    expect(result.issues).toEqual({ no_valid_citation: 1 });
  });

  it('rejects an altered URL', () => {
    const result = checker.check(
      model([
        { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] },
        {
          text: 'See https://ehub.example.test/mod/resource/view.php?id=799 for sunscreen.',
          sourceIds: ['S1'],
        },
      ]),
      sources,
      scope,
    );
    expect(result.removedClaims).toBe(1);
    expect(result.issues).toMatchObject({ fabricated_url: 1 });
    expect(result.answer).not.toContain('id=799');
  });

  it('rejects an incorrect page or slide number and accepts a correct one', () => {
    const validator = new ClaimSupportValidator();
    expect(validator.check('Reapply sunscreen every two hours (page 7).', [s1]).issues).toEqual([
      'fabricated_page',
    ]);
    expect(validator.check('Reapply sunscreen every two hours (pages 3-4).', [s1]).supported).toBe(
      true,
    );
    expect(validator.check('Reapply sunscreen every two hours (p. 4).', [s1]).supported).toBe(true);
    expect(
      validator.check('Wash hands before every treatment (slide 6).', [slides]).supported,
    ).toBe(true);
    expect(
      validator.check('Wash hands before every treatment (slide 9).', [slides]).issues,
    ).toEqual(['fabricated_slide']);
    expect(validator.check('Apply a cool compress (page 2).', [s2]).issues).toEqual([
      'fabricated_page',
    ]);
  });

  it('rejects fabricated document names and unsupported numbers', () => {
    const validator = new ClaimSupportValidator();
    expect(validator.check('Reapply sunscreen as Aftercare.pdf says.', [s1]).supported).toBe(true);
    expect(validator.check('Reapply sunscreen as Peel-Protocol.docx says.', [s1]).issues).toEqual([
      'fabricated_document',
    ]);
    expect(validator.check('Reapply SPF 30 sunscreen.', [s1]).issues).toEqual([
      'unsupported_number',
    ]);
    expect(validator.check('Reapply sunscreen every 2 hours.', [s1]).supported).toBe(true);
    expect(validator.check('Avoid the sun for 7 days.', [s1]).supported).toBe(true);
    expect(validator.check('Book a follow-up consultation.', [s1]).issues).toEqual(['no_overlap']);
  });

  it('never cites or excerpts a chunk from an unauthorised course', () => {
    const result = checker.check(
      model([
        { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1', 'S4'] },
        { text: 'Use the restricted laser calibration settings.', sourceIds: ['S4'] },
      ]),
      sources,
      scope,
    );
    expect(result.citations.map((citation) => citation.courseId)).toEqual([12]);
    expect(JSON.stringify(result)).not.toContain('Restricted laser calibration');
    expect(result.warnings).toContain('citation_rejected');
    expect(result.removedClaims).toBe(1);
  });

  it('cites a source once even when several claims (or one claim twice) reference it', () => {
    const result = checker.check(
      model(
        [
          { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1', 'S1'] },
          {
            text: 'Apply a cool compress for 10 minutes after laser treatment.',
            sourceIds: ['S2'],
          },
          { text: 'Avoid direct sun for 7 days after a peel.', sourceIds: ['S1'] },
        ],
        'Reapply SPF 50 every two hours, use a cool compress for 10 minutes, and avoid direct sun for 7 days.',
      ),
      sources,
      scope,
    );
    expect(result.citations.map((citation) => citation.citationId)).toEqual([1, 2]);
    expect(result.citations.map((citation) => citation.chunkId)).toEqual([s1.chunkId, s2.chunkId]);
    expect(result.claims.map((claim) => claim.citationIds)).toEqual([[1], [2], [1]]);
  });

  it('numbers citations by first use, regardless of retrieval rank', () => {
    const result = checker.check(
      model(
        [
          {
            text: 'Apply a cool compress for 10 minutes after laser treatment.',
            sourceIds: ['S2'],
          },
          { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] },
        ],
        'Apply a cool compress for 10 minutes; reapply SPF 50 every two hours.',
      ),
      sources,
      scope,
    );
    expect(result.citations.map((citation) => [citation.citationId, citation.chunkId])).toEqual([
      [1, s2.chunkId],
      [2, s1.chunkId],
    ]);
  });

  it('returns no substantive answer when no claim has a source', () => {
    for (const claims of [[{ text: 'Reapply sunscreen.', sourceIds: [] }], []]) {
      const result = checker.check(model(claims), sources, scope);
      expect(result).toMatchObject({
        insufficientEvidence: true,
        answer: INSUFFICIENT_EVIDENCE_MESSAGE,
        claims: [],
      });
      expect(answerHasValidSources(result)).toBe(true);
    }
  });

  it('keeps the supported part of a partially supported answer, rebuilt from its claims', () => {
    const result = checker.check(
      model(
        [
          { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] },
          {
            text: 'Apply a cool compress for 10 minutes after laser treatment.',
            sourceIds: ['S2'],
          },
          { text: 'Microneedling costs R1500 per session.', sourceIds: ['S1'] },
        ],
        'Reapply SPF 50 every two hours, use a cool compress, and microneedling costs R1500.',
      ),
      sources,
      scope,
    );
    expect(result.insufficientEvidence).toBe(false);
    expect(result.removedClaims).toBe(1);
    expect(result.answer).toBe(
      'Reapply SPF 50 sunscreen every two hours. [1]\nApply a cool compress for 10 minutes after laser treatment. [2]',
    );
    expect(result.answer).not.toContain('R1500');
    expect(result.warnings).toEqual(
      expect.arrayContaining(['unsupported_claims_removed', 'answer_rebuilt_from_claims']),
    );
  });

  it('refuses a fully unsupported answer, and one where most claims are unsupported', () => {
    const fully = checker.check(
      model([{ text: 'Microneedling costs R1500 per session.', sourceIds: ['S1'] }]),
      sources,
      scope,
    );
    expect(fully).toMatchObject({
      insufficientEvidence: true,
      answer: INSUFFICIENT_EVIDENCE_MESSAGE,
    });
    const mostly = checker.check(
      model([
        { text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] },
        { text: 'Microneedling costs R1500 per session.', sourceIds: ['S1'] },
        { text: 'Botox lasts 9 months.', sourceIds: ['S2'] },
      ]),
      sources,
      scope,
    );
    expect(mostly).toMatchObject({ insufficientEvidence: true, removedClaims: 2 });
  });

  it('replaces prose that mentions a fabricated reference even when every claim is valid', () => {
    const result = checker.check(
      model(
        [{ text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] }],
        'Reapply SPF 50 every two hours, as stated on page 12 of Peel-Guide.docx.',
      ),
      sources,
      scope,
    );
    expect(result.answer).toBe('Reapply SPF 50 sunscreen every two hours. [1]');
    expect(result.warnings).toContain('answer_rebuilt_from_claims');
  });
});

describe('citation links and excerpts', () => {
  it('shows links only for approved https hosts without credentials or tokens', () => {
    const hosts = new Set(['ehub.example.test']);
    expect(
      approvedSourceUrl(
        { moduleUrl: 'https://ehub.example.test/mod/page/view.php?id=1', sourceUrl: undefined },
        hosts,
      ),
    ).toBe('https://ehub.example.test/mod/page/view.php?id=1');
    for (const url of [
      'https://evil.example/mod/page/view.php?id=1',
      'http://ehub.example.test/mod/page/view.php?id=1',
      'https://user:pw@ehub.example.test/x',
      'https://ehub.example.test/webservice/pluginfile.php/1/x.pdf?token=abc',
      'https://ehub.example.test.evil.example/x',
      'not a url',
    ]) {
      expect(
        approvedSourceUrl({ moduleUrl: url, sourceUrl: undefined }, hosts),
        url,
      ).toBeUndefined();
    }
    // Falls back to the file link when the activity link is not approved.
    expect(
      approvedSourceUrl(
        {
          moduleUrl: 'https://evil.example/x',
          sourceUrl: 'https://ehub.example.test/pluginfile.php/1/a.pdf',
        },
        hosts,
      ),
    ).toBe('https://ehub.example.test/pluginfile.php/1/a.pdf');
  });

  it('withholds unapproved links and warns', () => {
    const result = checker.check(
      model([{ text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] }]),
      sources,
      { ...scope, allowedHosts: new Set() },
    );
    expect(result.citations[0]?.sourceUrl).toBeUndefined();
    expect(result.warnings).toContain('source_link_withheld');
  });

  it('resolves allowed hosts from configuration or the Moodle URL', () => {
    expect([...resolveAllowedHosts(['A.example', 'b.example'], undefined)]).toEqual([
      'a.example',
      'b.example',
    ]);
    expect([...resolveAllowedHosts(undefined, 'https://ehub.skinrenewal.co.za/')]).toEqual([
      'ehub.skinrenewal.co.za',
    ]);
    expect(resolveAllowedHosts(undefined, undefined).size).toBe(0);
  });

  it('picks the best matching sentence and bounds and cleans the excerpt', () => {
    expect(selectExcerpt(s2.content, ['Do not use retinol for 5 days.'], 200)).toBe(
      'Do not use retinol for 5 days.',
    );
    const excerpt = selectExcerpt(
      `Line\u001b[2J with Bearer abc.def.ghi ${'x'.repeat(400)}`,
      [],
      120,
    );
    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(excerpt).not.toContain('\u001b');
    expect(excerpt).not.toContain('abc.def.ghi');
  });

  it('formats citations from trusted metadata', () => {
    const result = checker.check(
      model([{ text: 'Reapply SPF 50 sunscreen every two hours.', sourceIds: ['S1'] }]),
      sources,
      scope,
    );
    const [citation] = result.citations;
    if (citation === undefined) {
      throw new Error('missing citation');
    }
    expect(formatCitationLine(citation)).toBe(
      '[1] Aftercare.pdf, pages 3-4 — Consultation Skills > Aftercare (https://ehub.example.test/mod/resource/view.php?id=701)',
    );
    expect(formatAnswerAsText(result, { excerpts: true })).toContain(
      '"Clients must reapply SPF 50 sunscreen every two hours after a chemical peel."',
    );
  });
});

describe('answerHasValidSources', () => {
  it('accepts only cited answers or the explicit insufficient-evidence response', () => {
    const citations = [{ citationId: 1 }];
    expect(
      answerHasValidSources({
        insufficientEvidence: false,
        answer: 'x',
        claims: [{ citationIds: [1] }],
        citations,
      }),
    ).toBe(true);
    expect(
      answerHasValidSources({
        insufficientEvidence: false,
        answer: 'x',
        claims: [{ citationIds: [] }],
        citations,
      }),
    ).toBe(false);
    expect(
      answerHasValidSources({
        insufficientEvidence: false,
        answer: 'x',
        claims: [{ citationIds: [2] }],
        citations,
      }),
    ).toBe(false);
    expect(
      answerHasValidSources({
        insufficientEvidence: false,
        answer: 'x',
        claims: [],
        citations: [],
      }),
    ).toBe(false);
    expect(
      answerHasValidSources({
        insufficientEvidence: true,
        answer: 'Something else',
        claims: [],
        citations: [],
      }),
    ).toBe(false);
    expect(
      answerHasValidSources({
        insufficientEvidence: true,
        answer: INSUFFICIENT_EVIDENCE_MESSAGE,
        claims: [],
        citations: [],
      }),
    ).toBe(true);
  });
});
