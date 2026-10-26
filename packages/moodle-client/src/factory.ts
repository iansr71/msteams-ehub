import {
  loadConfig,
  moodleConfigSchema,
  type EnvironmentSource,
  type Logger,
  type MoodleConfig,
} from '@ehub/shared';

import { normalizeMoodleBaseUrl, type NormalizedMoodleBaseUrl } from './baseUrl.js';
import { DefaultMoodleClient, type MoodleClient } from './client.js';
import { HttpMoodleFileDownloader, type MoodleFileDownloader } from './downloader.js';
import type { FetchFn } from './http.js';
import { DEFAULT_RETRY_POLICY, type RandomSource, type RetryPolicy, type Sleep } from './retry.js';
import { HttpMoodleTransport, type MoodleTransport } from './transport.js';

export interface MoodleClientSettings {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs: number;
  readonly downloadTimeoutMs: number;
  readonly maxDownloadBytes: number;
  readonly maxRetries: number;
  /** Plain http is accepted only outside production. */
  readonly allowHttp: boolean;
  readonly additionalRedirectHosts?: readonly string[];
}

export function moodleSettingsFromConfig(config: MoodleConfig): MoodleClientSettings {
  return {
    baseUrl: config.MOODLE_BASE_URL,
    token: config.MOODLE_TOKEN,
    requestTimeoutMs: config.MOODLE_REQUEST_TIMEOUT_MS,
    downloadTimeoutMs: config.MOODLE_DOWNLOAD_TIMEOUT_MS,
    maxDownloadBytes: config.MOODLE_MAX_DOWNLOAD_BYTES,
    maxRetries: config.MOODLE_MAX_RETRIES,
    allowHttp: config.NODE_ENV !== 'production',
  };
}

/** Validates the Moodle variables (throws ConfigValidationError naming variables only). */
export function loadMoodleSettings(env: EnvironmentSource = process.env): MoodleClientSettings {
  return moodleSettingsFromConfig(loadConfig(moodleConfigSchema, env));
}

/** Seams for tests and for callers that need custom logging or HTTP behaviour. */
export interface MoodleClientDependencies {
  readonly fetch?: FetchFn;
  readonly logger?: Logger;
  readonly sleep?: Sleep;
  readonly random?: RandomSource;
  readonly userAgent?: string;
  readonly retryPolicy?: Omit<RetryPolicy, 'maxRetries'>;
}

export interface MoodleServices {
  readonly baseUrl: NormalizedMoodleBaseUrl;
  readonly transport: MoodleTransport;
  readonly client: MoodleClient;
  readonly downloader: MoodleFileDownloader;
}

export function createMoodleServices(
  settings: MoodleClientSettings,
  dependencies: MoodleClientDependencies = {},
): MoodleServices {
  const baseUrl = normalizeMoodleBaseUrl(settings.baseUrl, { allowHttp: settings.allowHttp });
  const retryPolicy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...dependencies.retryPolicy,
    maxRetries: settings.maxRetries,
  };
  const shared = {
    baseUrl,
    token: settings.token,
    retryPolicy,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    ...(dependencies.random === undefined ? {} : { random: dependencies.random }),
    ...(dependencies.userAgent === undefined ? {} : { userAgent: dependencies.userAgent }),
  };

  const transport = new HttpMoodleTransport({
    ...shared,
    requestTimeoutMs: settings.requestTimeoutMs,
  });
  const downloader = new HttpMoodleFileDownloader({
    ...shared,
    downloadTimeoutMs: settings.downloadTimeoutMs,
    maxDownloadBytes: settings.maxDownloadBytes,
    ...(settings.additionalRedirectHosts === undefined
      ? {}
      : { additionalRedirectHosts: settings.additionalRedirectHosts }),
  });

  return { baseUrl, transport, client: new DefaultMoodleClient(transport), downloader };
}
