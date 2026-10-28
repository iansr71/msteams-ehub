import { z } from 'zod';

import { LOG_LEVEL_SETTINGS } from '../logging/logger.js';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

/** Variables whose values are secrets: never printed, always registered for log scrubbing. */
export const SECRET_ENV_KEYS = [
  'MOODLE_TOKEN',
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

export const azureSearchConfigShape = {
  AZURE_SEARCH_ENDPOINT: serviceUrl({ httpsOnly: true }),
  AZURE_SEARCH_INDEX_NAME: searchIndexName,
};

export const azureOpenAIConfigShape = {
  AZURE_OPENAI_ENDPOINT: serviceUrl({ httpsOnly: true }),
  AZURE_OPENAI_CHAT_DEPLOYMENT: azureDeploymentName,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: azureDeploymentName,
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
  ...observabilityConfigShape,
});

export type RuntimeConfig = z.output<typeof runtimeConfigSchema>;
export type MoodleConfig = z.output<typeof moodleConfigSchema>;
export type AzureSearchConfig = z.output<typeof azureSearchConfigSchema>;
export type AzureOpenAIConfig = z.output<typeof azureOpenAIConfigSchema>;
export type AzureIdentityConfig = z.output<typeof azureIdentityConfigSchema>;
export type ExtractionConfig = z.output<typeof extractionConfigSchema>;
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
  observability: Object.keys(observabilityConfigShape),
};
