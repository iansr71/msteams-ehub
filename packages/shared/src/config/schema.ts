import { z } from 'zod';

import { LOG_LEVEL_SETTINGS } from '../logging/logger.js';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Variables whose values are secrets: never printed, always registered for log scrubbing. */
export const SECRET_ENV_KEYS = [
  'MOODLE_TOKEN',
  'AZURE_SEARCH_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_CLIENT_SECRET',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
] as const;

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_ENV_KEYS);

export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY_SET.has(key);
}

const ALLOWED_PROTOCOLS = ['http:', 'https:'] as const;

/**
 * A service base URL: absolute http(s), no embedded credentials, query string or fragment.
 * Credentials must never travel inside a URL that may later be logged.
 */
function serviceUrl(options: { httpsOnly: boolean }) {
  return z
    .string()
    .trim()
    .superRefine((raw, ctx) => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Must be an absolute URL.' });
        return;
      }
      if (!(ALLOWED_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
        ctx.addIssue({ code: 'custom', message: 'Must use http or https.' });
      } else if (options.httpsOnly && parsed.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'Must use https.' });
      }
      if (parsed.username !== '' || parsed.password !== '') {
        ctx.addIssue({ code: 'custom', message: 'Must not contain credentials.' });
      }
      if (parsed.search !== '' || parsed.hash !== '') {
        ctx.addIssue({ code: 'custom', message: 'Must not contain a query string or fragment.' });
      }
    });
}

// Generic messages only: Zod's defaults can echo constraints that hint at a secret's shape.
const secretString = (minLength: number) =>
  z
    .string()
    .min(minLength, { message: `Must be at least ${minLength} characters.` })
    .refine((value) => !/\s/.test(value), { message: 'Must not contain whitespace.' });

const guid = (label: string) => z.guid({ message: `${label} must be a GUID.` });

const azureDeploymentName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    message: 'Must be 1-64 letters, digits, ".", "_" or "-".',
  });

// Azure AI Search index names: lowercase letters, digits and single dashes, 2-128 characters,
// starting and ending with a letter or digit.
const searchIndexName = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,126}[a-z0-9]$/, {
    message:
      'Must be 2-128 lowercase letters, digits or single dashes, starting and ending alphanumerically.',
  });

export const runtimeConfigShape = {
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVEL_SETTINGS).default('info'),
  PORT: z.coerce
    .number({ message: 'Must be a number.' })
    .int({ message: 'Must be an integer.' })
    .min(1, { message: 'Must be between 1 and 65535.' })
    .max(65535, { message: 'Must be between 1 and 65535.' })
    .default(3000),
};

const boundedInteger = (min: number, max: number, fallback: number) =>
  z.coerce
    .number({ message: 'Must be a number.' })
    .int({ message: 'Must be an integer.' })
    .min(min, { message: `Must be between ${min} and ${max}.` })
    .max(max, { message: `Must be between ${min} and ${max}.` })
    .default(fallback);

export const MOODLE_DEFAULTS = {
  requestTimeoutMs: 30_000,
  downloadTimeoutMs: 120_000,
  maxDownloadBytes: 100 * 1024 * 1024,
  maxRetries: 3,
} as const;

export const moodleConfigShape = {
  // http is tolerated for a local Moodle in development; production is enforced to https below.
  MOODLE_BASE_URL: serviceUrl({ httpsOnly: false }),
  MOODLE_TOKEN: secretString(16),
  MOODLE_REQUEST_TIMEOUT_MS: boundedInteger(1_000, 300_000, MOODLE_DEFAULTS.requestTimeoutMs),
  MOODLE_DOWNLOAD_TIMEOUT_MS: boundedInteger(1_000, 1_800_000, MOODLE_DEFAULTS.downloadTimeoutMs),
  MOODLE_MAX_DOWNLOAD_BYTES: boundedInteger(
    1_024,
    2 * 1024 * 1024 * 1024,
    MOODLE_DEFAULTS.maxDownloadBytes,
  ),
  MOODLE_MAX_RETRIES: boundedInteger(0, 10, MOODLE_DEFAULTS.maxRetries),
};

export const SEARCH_DEFAULTS = {
  indexName: 'ehub-course-content-v1',
  vectorDimensions: 1536,
  batchSize: 500,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
} as const;

const booleanFlag = (fallback: boolean) =>
  z
    .enum(['true', 'false'], { message: 'Must be true or false.' })
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

export const azureSearchConfigShape = {
  AZURE_SEARCH_ENDPOINT: serviceUrl({ httpsOnly: true }),
  AZURE_SEARCH_INDEX_NAME: searchIndexName.default(SEARCH_DEFAULTS.indexName),
  /** Local development only; Azure deployments authenticate with Managed Identity. */
  AZURE_SEARCH_API_KEY: secretString(20).optional(),
  /** Must equal the embedding model's output size (text-embedding-3-small: 1536). */
  AZURE_SEARCH_VECTOR_DIMENSIONS: boundedInteger(1, 3072, SEARCH_DEFAULTS.vectorDimensions),
  /** Semantic ranking needs a Basic or higher tier with the semantic ranker enabled. */
  AZURE_SEARCH_SEMANTIC_ENABLED: booleanFlag(true),
  AZURE_SEARCH_BATCH_SIZE: boundedInteger(1, 1000, SEARCH_DEFAULTS.batchSize),
  AZURE_SEARCH_REQUEST_TIMEOUT_MS: boundedInteger(1_000, 300_000, SEARCH_DEFAULTS.requestTimeoutMs),
  AZURE_SEARCH_MAX_RETRIES: boundedInteger(0, 10, SEARCH_DEFAULTS.maxRetries),
};

export const azureOpenAIConfigShape = {
  AZURE_OPENAI_ENDPOINT: serviceUrl({ httpsOnly: true }),
  AZURE_OPENAI_CHAT_DEPLOYMENT: azureDeploymentName,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: azureDeploymentName,
};

export const EMBEDDING_DEFAULTS = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
  version: '1',
  batchSize: 64,
  maxBatchTokens: 100_000,
  maxInputTokens: 8_191,
  maxConcurrency: 2,
  requestsPerMinute: 120,
  requestTimeoutMs: 30_000,
  maxRetries: 4,
  tokenScope: 'https://ai.azure.com/.default',
} as const;

/*
 * Embedding generation through an Azure OpenAI embedding deployment (phase 8). Separate from
 * azureOpenAI so the indexer does not need a chat deployment configured.
 */
export const embeddingConfigShape = {
  AZURE_OPENAI_ENDPOINT: serviceUrl({ httpsOnly: true }),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: azureDeploymentName,
  /** Local development only; Azure deployments authenticate with Managed Identity. */
  AZURE_OPENAI_API_KEY: secretString(20).optional(),
  /** Microsoft Entra ID token scope for Azure OpenAI. */
  AZURE_OPENAI_TOKEN_SCOPE: z
    .url({ protocol: /^https$/, message: 'Must be an https scope URI.' })
    .default(EMBEDDING_DEFAULTS.tokenScope),
  /** The model behind the deployment; recorded with every embedding and in the cache key. */
  AZURE_OPENAI_EMBEDDING_MODEL: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
      message: 'Must be 1-64 letters, digits, ".", "_" or "-".',
    })
    .default(EMBEDDING_DEFAULTS.model),
  /** Must equal AZURE_SEARCH_VECTOR_DIMENSIONS. */
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: boundedInteger(1, 3072, EMBEDDING_DEFAULTS.dimensions),
  /** Send `dimensions` in requests (text-embedding-3 models only) to shorten vectors. */
  AZURE_OPENAI_EMBEDDING_SEND_DIMENSIONS: booleanFlag(false),
  /** Bump to force re-embedding with the same model (e.g. after changing input normalisation). */
  EMBEDDING_VERSION: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,32}$/, { message: 'Must be 1-32 letters, digits, ".", "_" or "-".' })
    .default(EMBEDDING_DEFAULTS.version),
  EMBEDDING_BATCH_SIZE: boundedInteger(1, 2048, EMBEDDING_DEFAULTS.batchSize),
  EMBEDDING_MAX_BATCH_TOKENS: boundedInteger(1_000, 300_000, EMBEDDING_DEFAULTS.maxBatchTokens),
  EMBEDDING_MAX_INPUT_TOKENS: boundedInteger(1, 8_192, EMBEDDING_DEFAULTS.maxInputTokens),
  EMBEDDING_MAX_CONCURRENCY: boundedInteger(1, 16, EMBEDDING_DEFAULTS.maxConcurrency),
  EMBEDDING_REQUESTS_PER_MINUTE: boundedInteger(1, 10_000, EMBEDDING_DEFAULTS.requestsPerMinute),
  EMBEDDING_REQUEST_TIMEOUT_MS: boundedInteger(1_000, 300_000, EMBEDDING_DEFAULTS.requestTimeoutMs),
  EMBEDDING_MAX_RETRIES: boundedInteger(0, 10, EMBEDDING_DEFAULTS.maxRetries),
  /** Optional directory for the persistent embedding cache (indexer). */
  EMBEDDING_CACHE_DIR: z.string().trim().min(1).max(500).optional(),
};

export const azureIdentityConfigShape = {
  AZURE_TENANT_ID: guid('AZURE_TENANT_ID'),
  AZURE_CLIENT_ID: guid('AZURE_CLIENT_ID'),
  // Optional: deployed environments authenticate with Managed Identity instead.
  AZURE_CLIENT_SECRET: secretString(8).optional(),
};

export const EXTRACTION_DEFAULTS = {
  maxInputBytes: 50 * 1024 * 1024,
  maxTextChars: 2_000_000,
  timeoutMs: 60_000,
  maxArchiveEntries: 2_000,
  maxUncompressedBytes: 200 * 1024 * 1024,
} as const;

export const extractionConfigShape = {
  EXTRACTION_MAX_INPUT_BYTES: boundedInteger(
    1_024,
    500 * 1024 * 1024,
    EXTRACTION_DEFAULTS.maxInputBytes,
  ),
  EXTRACTION_MAX_TEXT_CHARS: boundedInteger(1_000, 20_000_000, EXTRACTION_DEFAULTS.maxTextChars),
  EXTRACTION_TIMEOUT_MS: boundedInteger(1_000, 600_000, EXTRACTION_DEFAULTS.timeoutMs),
  EXTRACTION_MAX_ARCHIVE_ENTRIES: boundedInteger(10, 20_000, EXTRACTION_DEFAULTS.maxArchiveEntries),
  EXTRACTION_MAX_UNCOMPRESSED_BYTES: boundedInteger(
    1024 * 1024,
    2 * 1024 * 1024 * 1024,
    EXTRACTION_DEFAULTS.maxUncompressedBytes,
  ),
};

export const CHUNKING_DEFAULTS = {
  targetTokens: 850,
  maxTokens: 1_000,
  minTokens: 100,
  overlapTokens: 125,
  tokenizer: 'cl100k_base',
} as const;

/** Tokenizers available for counting: cl100k_base (text-embedding-3-*), o200k_base (GPT-4o family). */
export const CHUNK_TOKENIZERS = ['cl100k_base', 'o200k_base'] as const;

export const chunkingConfigShape = {
  CHUNK_TARGET_TOKENS: boundedInteger(50, 8_000, CHUNKING_DEFAULTS.targetTokens),
  CHUNK_MAX_TOKENS: boundedInteger(50, 8_000, CHUNKING_DEFAULTS.maxTokens),
  CHUNK_MIN_TOKENS: boundedInteger(1, 8_000, CHUNKING_DEFAULTS.minTokens),
  CHUNK_OVERLAP_TOKENS: boundedInteger(0, 4_000, CHUNKING_DEFAULTS.overlapTokens),
  CHUNK_TOKENIZER: z.enum(CHUNK_TOKENIZERS).default(CHUNKING_DEFAULTS.tokenizer),
};

export const RETRIEVAL_DEFAULTS = {
  topK: 8,
  maxChunksPerResource: 3,
  candidateCount: 24,
} as const;

const optionalDecimal = (min: number, max: number) =>
  z.coerce
    .number({ message: 'Must be a number.' })
    .min(min, { message: `Must be between ${String(min)} and ${String(max)}.` })
    .max(max, { message: `Must be between ${String(min)} and ${String(max)}.` })
    .optional();

/*
 * Retrieval settings. Active-content filtering is deliberately not a setting: inactive chunks
 * are never retrieved (see docs/retrieval.md).
 */
export const retrievalConfigShape = {
  RETRIEVAL_TOP_K: boundedInteger(1, 50, RETRIEVAL_DEFAULTS.topK),
  RETRIEVAL_MAX_CHUNKS_PER_RESOURCE: boundedInteger(1, 50, RETRIEVAL_DEFAULTS.maxChunksPerResource),
  /** Results fetched before the per-resource cap and thresholds are applied. */
  RETRIEVAL_CANDIDATE_COUNT: boundedInteger(1, 50, RETRIEVAL_DEFAULTS.candidateCount),
  RETRIEVAL_SEMANTIC_RANKING: booleanFlag(true),
  /** Minimum @search.score; its scale depends on the query mode (see docs/retrieval.md). */
  RETRIEVAL_MIN_SCORE: optionalDecimal(0, 1_000_000),
  /** Minimum semantic reranker score (0-4); applies only when semantic ranking ran. */
  RETRIEVAL_MIN_RERANKER_SCORE: optionalDecimal(0, 4),
};

export const observabilityConfigShape = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: z
    .string()
    .trim()
    .refine((value) => /(^|;)\s*InstrumentationKey=/i.test(value), {
      message: 'Must be an Application Insights connection string.',
    })
    .optional(),
};

export const runtimeConfigSchema = defineConfigSchema({});
export const moodleConfigSchema = defineConfigSchema(moodleConfigShape);
export const azureSearchConfigSchema = defineConfigSchema(azureSearchConfigShape);
export const azureOpenAIConfigSchema = defineConfigSchema(azureOpenAIConfigShape);
export const azureIdentityConfigSchema = defineConfigSchema(azureIdentityConfigShape);
export const extractionConfigSchema = defineConfigSchema(extractionConfigShape);
export const chunkingConfigSchema = defineConfigSchema(chunkingConfigShape).superRefine(
  (config, ctx) => {
    if (config.CHUNK_MIN_TOKENS >= config.CHUNK_TARGET_TOKENS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_MIN_TOKENS'],
        message: 'Must be less than CHUNK_TARGET_TOKENS.',
      });
    }
    if (config.CHUNK_TARGET_TOKENS > config.CHUNK_MAX_TOKENS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_TARGET_TOKENS'],
        message: 'Must not exceed CHUNK_MAX_TOKENS.',
      });
    }
    if (config.CHUNK_OVERLAP_TOKENS * 2 > config.CHUNK_TARGET_TOKENS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: 'Must be at most half of CHUNK_TARGET_TOKENS.',
      });
    }
  },
);
export const observabilityConfigSchema = defineConfigSchema(observabilityConfigShape);
export const embeddingConfigSchema = defineConfigSchema(embeddingConfigShape);
export const retrievalConfigSchema = defineConfigSchema(retrievalConfigShape).superRefine(
  (config, ctx) => {
    if (config.RETRIEVAL_CANDIDATE_COUNT < config.RETRIEVAL_TOP_K) {
      ctx.addIssue({
        code: 'custom',
        path: ['RETRIEVAL_CANDIDATE_COUNT'],
        message: 'Must be at least RETRIEVAL_TOP_K.',
      });
    }
  },
);

const URL_KEY_PATTERN = /_(?:URL|ENDPOINT)$/;

/**
 * Builds a schema of the runtime variables plus `shape`, enforcing production-only rules that
 * depend on NODE_ENV (currently: every *_URL / *_ENDPOINT variable must use https).
 */
export function defineConfigSchema<Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<typeof runtimeConfigShape & Shape> {
  return z.object({ ...runtimeConfigShape, ...shape }).superRefine((config, ctx) => {
    const values: Readonly<Record<string, unknown>> = config;
    if (values['NODE_ENV'] !== 'production') {
      return;
    }
    for (const [key, value] of Object.entries(values)) {
      if (URL_KEY_PATTERN.test(key) && typeof value === 'string' && !value.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Must use https in production.' });
      }
    }
  });
}

/** Every application variable in .env.example. */
export const applicationConfigSchema = defineConfigSchema({
  ...moodleConfigShape,
  ...extractionConfigShape,
  ...chunkingConfigShape,
  ...azureSearchConfigShape,
  ...azureOpenAIConfigShape,
  ...azureIdentityConfigShape,
  ...retrievalConfigShape,
  ...embeddingConfigShape,
  ...observabilityConfigShape,
});

export type RuntimeConfig = z.output<typeof runtimeConfigSchema>;
export type MoodleConfig = z.output<typeof moodleConfigSchema>;
export type AzureSearchConfig = z.output<typeof azureSearchConfigSchema>;
export type AzureOpenAIConfig = z.output<typeof azureOpenAIConfigSchema>;
export type AzureIdentityConfig = z.output<typeof azureIdentityConfigSchema>;
export type ExtractionConfig = z.output<typeof extractionConfigSchema>;
export type RetrievalConfig = z.output<typeof retrievalConfigSchema>;
export type EmbeddingConfig = z.output<typeof embeddingConfigSchema>;
export type ChunkingConfig = z.output<typeof chunkingConfigSchema>;
export type ObservabilityConfig = z.output<typeof observabilityConfigSchema>;
export type ApplicationConfig = z.output<typeof applicationConfigSchema>;

/** Named configuration groups, used for health reporting and per-command validation. */
export const CONFIG_FEATURES = {
  runtime: runtimeConfigSchema,
  moodle: moodleConfigSchema,
  azureSearch: azureSearchConfigSchema,
  azureOpenAI: azureOpenAIConfigSchema,
  azureIdentity: azureIdentityConfigSchema,
  extraction: extractionConfigSchema,
  chunking: chunkingConfigSchema,
  retrieval: retrievalConfigSchema,
  embeddings: embeddingConfigSchema,
  observability: observabilityConfigSchema,
} as const;

export type ConfigFeature = keyof typeof CONFIG_FEATURES;

/** The variables each feature owns (runtime variables are shared by all features). */
export const CONFIG_FEATURE_VARIABLES: Readonly<Record<ConfigFeature, readonly string[]>> = {
  runtime: Object.keys(runtimeConfigShape),
  moodle: Object.keys(moodleConfigShape),
  azureSearch: Object.keys(azureSearchConfigShape),
  azureOpenAI: Object.keys(azureOpenAIConfigShape),
  azureIdentity: Object.keys(azureIdentityConfigShape),
  extraction: Object.keys(extractionConfigShape),
  chunking: Object.keys(chunkingConfigShape),
  retrieval: Object.keys(retrievalConfigShape),
  embeddings: Object.keys(embeddingConfigShape),
  observability: Object.keys(observabilityConfigShape),
};
