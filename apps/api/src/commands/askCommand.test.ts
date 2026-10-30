import { createLogger, type CommandContext } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

import {
  ScriptedChatModel,
  modelAnswer,
  type ScriptedStep,
} from '../rag/__fixtures__/scriptedChatModel.js';
import { INSUFFICIENT_EVIDENCE_MESSAGE } from '../rag/answerSchema.js';
import { SAFE_FAILURE_MESSAGE } from '../rag/ragService.js';
import {
  API_KEY,
  SECRET_SENTENCE,
  TENANT_ID,
  TEST_DIMENSIONS,
  seededSearch,
} from '../retrieval/__fixtures__/corpus.js';
import { createEmbeddingProvider } from '@ehub/shared/embeddings';

import { FakeEmbeddingService } from '../../../../packages/shared/src/embeddings/__fixtures__/fakeEmbeddingService.js';
import { createApiCommands } from './index.js';

const OPENAI_KEY = 'fake-openai-key-0123456789abcdef0123';
const QUESTION = 'How often should sunscreen be reapplied after a peel?';

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
};

async function run(
  args: string[],
  options: { steps?: ScriptedStep[]; env?: Record<string, string> } = {},
) {
  const { client, service } = await seededSearch();
  const model = new ScriptedChatModel(options.steps ?? [modelAnswer()]);
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
  const commandEnv = options.env ?? env;
  const command = createApiCommands({
    env: commandEnv,
    ask: {
      env: commandEnv,
      createSearch: () => Promise.resolve(client),
      createChat: () => Promise.resolve(model),
      createEmbedder: (settings) => createEmbeddingProvider(settings, { fetch: embeddings.fetch }),
    },
  })['ask'];
  if (command === undefined) {
    throw new Error('missing command');
  }
  const exitCode = await command.run(context);
  const stdout = output.join('\n');
  const logText = logs.join('\n');
  for (const text of [stdout, logText]) {
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(OPENAI_KEY);
  }
  // The question and source content never reach the logs.
  expect(logText).not.toContain(QUESTION);
  expect(logText).not.toContain(SECRET_SENTENCE);
  return { exitCode, stdout, model, service, embeddings };
}

describe('pnpm api ask', () => {
  it('prints the answer, numbered claims and the sources given to the model', async () => {
    const result = await run(['--question', QUESTION, '--course-id', '12']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Status: answered');
    expect(result.stdout).toContain('Reapply sunscreen every two hours after a peel.');
    expect(result.stdout).toContain(
      '1. Sunscreen should be reapplied every two hours after a peel. [1]',
    );
    expect(result.stdout).toContain('[1] course 12 | Aftercare > Sun protection');
    expect(result.stdout).not.toContain(SECRET_SENTENCE);
  });

  it('outputs JSON for later citation validation', async () => {
    const result = await run(['--question', QUESTION, '--course-id', '12', '--json']);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      claims: { chunkIds: string[] }[];
      sources: { chunkId: string }[];
    };
    expect(parsed.status).toBe('answered');
    expect(parsed.claims[0]?.chunkIds[0]).toBe(parsed.sources[0]?.chunkId);
  });

  it('exits 0 with the fixed message when evidence is insufficient, and 1 on safe failure', async () => {
    // Hybrid retrieval always returns nearest neighbours, so the model decides here.
    const insufficient = await run(
      ['--question', 'quarterly parking allocation', '--course-id', '12'],
      {
        steps: [modelAnswer({ answer: 'n/a', claims: [], insufficientEvidence: true })],
      },
    );
    expect(insufficient.exitCode).toBe(0);
    expect(insufficient.stdout).toContain(INSUFFICIENT_EVIDENCE_MESSAGE);
    expect(insufficient.stdout).toContain('Status: insufficient_evidence');

    const failed = await run(['--question', QUESTION, '--course-id', '12'], {
      steps: ['bad', 'worse'],
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain(SAFE_FAILURE_MESSAGE);
    expect(failed.stdout).toContain('Status: failed (invalid_output)');
  });

  it('refuses a selected course outside the authorised courses', async () => {
    const result = await run([
      '--question',
      QUESTION,
      '--course-id',
      '12',
      '--selected-course-id',
      '13',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Question failed: course_not_authorized');
    expect(result.model.requests).toHaveLength(0);
  });

  it('embeds the question and uses hybrid retrieval', async () => {
    const result = await run(['--question', QUESTION, '--course-id', '12', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({ retrieval: { mode: 'hybrid' } });
    expect(result.embeddings.requests).toHaveLength(1);
    const body = JSON.parse(result.service.requests.at(-1)?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ vectorFilterMode: 'preFilter' });
  });

  it('requires embeddings, because answers use hybrid retrieval', async () => {
    const result = await run(['--question', QUESTION, '--course-id', '12'], {
      env: { ...env, AZURE_OPENAI_EMBEDDING_DEPLOYMENT: '' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('AZURE_OPENAI_EMBEDDING_DEPLOYMENT: Required.');
  });

  it('requires a course and the chat configuration', async () => {
    const noCourse = await run(['--question', QUESTION]);
    expect(noCourse.exitCode).toBe(2);
    expect(noCourse.stdout).toContain('--course-id: is required.');
    const noChat = await run(['--question', QUESTION, '--course-id', '12'], {
      env: { ...env, AZURE_OPENAI_CHAT_DEPLOYMENT: '' },
    });
    expect(noChat.exitCode).toBe(1);
    expect(noChat.stdout).toContain('AZURE_OPENAI_CHAT_DEPLOYMENT: Required.');
  });

  it('rejects an over-long question', async () => {
    const result = await run(['--question', 'x'.repeat(1001), '--course-id', '12']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('invalid_question');
  });
});
