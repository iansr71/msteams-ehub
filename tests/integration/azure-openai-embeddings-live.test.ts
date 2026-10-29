import { embeddingConfigSchema, loadConfig, loadLocalEnvFile } from '@ehub/shared';
import {
  InMemoryEmbeddingCache,
  createEmbeddingProvider,
  type CachingEmbeddingProvider,
} from '@ehub/shared/embeddings';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * Opt-in test against a real Azure OpenAI embedding deployment. Skipped unless
 * EHUB_LIVE_EMBEDDING_TESTS=1. Reads .env like the CLIs and uses AZURE_OPENAI_* settings (API key
 * or Entra ID). Sends three short, non-sensitive sentences.
 */

const enabled = process.env['EHUB_LIVE_EMBEDDING_TESTS'] === '1';

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((value, index) => {
    const other = b[index] ?? 0;
    dot += value * other;
    normA += value * value;
    normB += other * other;
  });
  return dot / Math.sqrt(normA * normB);
}

describe.skipIf(!enabled)('Azure OpenAI embeddings (live)', () => {
  let provider: CachingEmbeddingProvider;

  beforeAll(async () => {
    loadLocalEnvFile();
    const settings = loadConfig(embeddingConfigSchema, process.env);
    provider = await createEmbeddingProvider(settings, { cache: new InMemoryEmbeddingCache() });
  });

  it('is healthy and returns the configured dimensions', async () => {
    const health = await provider.healthCheck();
    expect(health.problems).toEqual([]);
    expect(health.returnedDimensions).toBe(provider.getDimensions());
  }, 60_000);

  it('embeds a batch, serves repeats from the cache and ranks related text closer', async () => {
    const texts = [
      'Apply sunscreen every two hours after a chemical peel.',
      'Reapply SPF regularly following a skin peel treatment.',
      'The branch closes at five on Saturdays.',
    ];
    const [peel, spf, hours] = await provider.embedBatch(texts);
    if (peel === undefined || spf === undefined || hours === undefined) {
      throw new Error('missing embeddings');
    }
    expect(peel.vector).toHaveLength(provider.getDimensions());
    expect(cosine(peel.vector, spf.vector)).toBeGreaterThan(cosine(peel.vector, hours.vector));
    const again = await provider.embedText(texts[0] ?? '');
    expect(again.cached).toBe(true);
  }, 60_000);
});
