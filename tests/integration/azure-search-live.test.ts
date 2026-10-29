import { randomBytes } from 'node:crypto';

import { azureSearchConfigSchema, loadConfig, loadLocalEnvFile } from '@ehub/shared';
import {
  SEARCH_API_VERSION,
  apiKeyAuthenticator,
  createDefaultSearchCredential,
  createSearchIndexClient,
  tokenCredentialAuthenticator,
  type SearchIndexClient,
} from '@ehub/shared/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  makeSearchDocument,
  placeholderVector,
} from '../../packages/shared/src/search/__fixtures__/documents.js';

/*
 * Opt-in test against a real Azure AI Search service. Skipped unless EHUB_LIVE_SEARCH_TESTS=1.
 * Reads .env like the CLIs, then uses AZURE_SEARCH_ENDPOINT plus AZURE_SEARCH_API_KEY (or Entra
 * ID via DefaultAzureCredential) and works only on a throwaway index named ehub-live-test-<random>, which it deletes at the end.
 * It never touches AZURE_SEARCH_INDEX_NAME. Needs a tier with semantic ranking unless
 * AZURE_SEARCH_SEMANTIC_ENABLED=false.
 */

const enabled = process.env['EHUB_LIVE_SEARCH_TESTS'] === '1';
const TEMP_INDEX = `ehub-live-test-${randomBytes(4).toString('hex')}`;
const DIMENSIONS = 16;

const sleep = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

describe.skipIf(!enabled)('Azure AI Search (live)', () => {
  let client: SearchIndexClient;
  let endpoint: string;
  let apiKey: string | undefined;

  beforeAll(async () => {
    loadLocalEnvFile();
    const settings = loadConfig(azureSearchConfigSchema, process.env);
    endpoint = settings.AZURE_SEARCH_ENDPOINT;
    apiKey = settings.AZURE_SEARCH_API_KEY;
    client = await createSearchIndexClient({
      ...settings,
      AZURE_SEARCH_INDEX_NAME: TEMP_INDEX,
      AZURE_SEARCH_VECTOR_DIMENSIONS: DIMENSIONS,
    });
  });

  afterAll(async () => {
    // Only the throwaway index this run created; the guard keeps it that way.
    if (!/^ehub-live-test-[0-9a-f]{8}$/.test(TEMP_INDEX)) {
      return;
    }
    const authenticator =
      apiKey === undefined
        ? tokenCredentialAuthenticator(await createDefaultSearchCredential())
        : apiKeyAuthenticator(apiKey);
    await fetch(`${endpoint}/indexes/${TEMP_INDEX}?api-version=${SEARCH_API_VERSION}`, {
      method: 'DELETE',
      headers: await authenticator.headers(),
    });
  });

  it('creates, validates, indexes, searches within authorised courses and deletes', async () => {
    expect((await client.createOrUpdateIndex()).outcome).toBe('created');
    expect((await client.validateIndexSchema()).status).toBe('match');

    const vector = (text: string) => placeholderVector(text, DIMENSIONS);
    const documents = [
      makeSearchDocument({ seed: 'live-1', contentVector: vector('Aftercare guidance live-1.') }),
      makeSearchDocument({
        seed: 'live-2',
        content: 'Peel aftercare for the user.',
        contentVector: vector('Peel aftercare for the user.'),
      }),
      makeSearchDocument({
        seed: 'live-3',
        content: 'Aftercare in a course the caller is not authorised for.',
        contentVector: vector('Aftercare in a course the caller is not authorised for.'),
        courseId: 99,
      }),
    ];
    const report = await client.uploadChunks(documents);
    expect(report.failed).toEqual([]);

    // Newly indexed documents become searchable after a short delay.
    let hits = 0;
    for (let attempt = 0; attempt < 10 && hits < 2; attempt += 1) {
      await sleep(1000);
      hits = (
        await client.search({
          tenantId: 'tenant-1',
          authorizedCourseIds: [12],
          text: 'aftercare',
          vector: vector('aftercare'),
          top: 10,
        })
      ).hits.length;
    }
    expect(hits).toBe(2);

    const deletion = await client.deleteChunksByResource({
      tenantId: 'tenant-1',
      courseId: 12,
      resourceId: '701:chapter:11',
    });
    expect(deletion.matched).toBe(2);
    expect(deletion.failed).toEqual([]);
    const otherCourse = await client.deleteChunksByCourse({ tenantId: 'tenant-1', courseId: 99 });
    expect(otherCourse.matched).toBe(1);

    const health = await client.healthCheck();
    expect(health.serviceReachable).toBe(true);
  }, 120_000);
});
