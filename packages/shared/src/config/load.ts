import type { z } from 'zod';

import { redactString, registerSecretValue } from '../logging/redaction.js';
import {
  CONFIG_FEATURE_VARIABLES,
  CONFIG_FEATURES,
  SECRET_ENV_KEYS,
  isSecretEnvKey,
  type ConfigFeature,
} from './schema.js';

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  /** Variable name, e.g. `MOODLE_BASE_URL`. Never contains the value. */
  readonly variable: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.variable}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

/**
 * Treats empty and whitespace-only values as unset, so `KEY=` lines copied from
 * .env.example behave like missing variables rather than invalid empty strings.
 */
export function cleanEnvironment(env: EnvironmentSource): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function toConfigIssues(
  error: z.ZodError,
  cleaned: Readonly<Record<string, string>>,
): ConfigIssue[] {
  return error.issues.map((issue) => {
    const variable = issue.path.map(String).join('.') || '(root)';
    const message =
      cleaned[variable] === undefined
        ? 'Required.'
        : // Messages are ours or Zod's generic ones; scrub defensively anyway.
          redactString(issue.message);
    return { variable, message };
  });
}

/**
 * Validates `env` against `schema` and returns the typed configuration. Secret values are
 * registered for log redaction before validation, so even a malformed secret is never
 * echoed. Throws {@link ConfigValidationError} listing variable names only.
 */
export function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  env: EnvironmentSource = process.env,
): z.output<Schema> {
  const cleaned = cleanEnvironment(env);
  for (const key of SECRET_ENV_KEYS) {
    registerSecretValue(cleaned[key]);
  }

  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigValidationError(toConfigIssues(result.error, cleaned));
  }
  return result.data;
}

export type ConfigFeatureState = 'valid' | 'missing' | 'invalid';

export interface ConfigFeatureStatus {
  readonly feature: ConfigFeature;
  readonly state: ConfigFeatureState;
  /** True when at least one of the feature's own variables is set. */
  readonly anyVariableSet: boolean;
  /** Variables that are missing or invalid. Names only. */
  readonly problems: readonly ConfigIssue[];
}

/**
 * Reports whether a configuration feature is fully configured, entirely absent, or present
 * but invalid — without revealing any values. Used by health commands.
 */
export function getConfigFeatureStatus(
  feature: ConfigFeature,
  env: EnvironmentSource = process.env,
): ConfigFeatureStatus {
  const cleaned = cleanEnvironment(env);
  const ownVariables = CONFIG_FEATURE_VARIABLES[feature];
  const anyPresent = ownVariables.some((variable) => cleaned[variable] !== undefined);

  try {
    loadConfig(CONFIG_FEATURES[feature], cleaned);
    return { feature, state: 'valid', anyVariableSet: anyPresent, problems: [] };
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) {
      throw error;
    }
    const featureProblems = error.issues.filter((issue) => ownVariables.includes(issue.variable));
    const state: ConfigFeatureState =
      feature !== 'runtime' && !anyPresent && featureProblems.length > 0 ? 'missing' : 'invalid';
    return { feature, state, anyVariableSet: anyPresent, problems: error.issues };
  }
}

export type ConfigDescription = Readonly<Record<string, string | number | boolean>>;

/** Safe-to-print view of a loaded configuration: secret values are shown as configured/not set. */
export function describeConfig(config: Readonly<Record<string, unknown>>): ConfigDescription {
  const description: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretEnvKey(key)) {
      description[key] = value === undefined ? '[not set]' : '[configured]';
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      description[key] = value;
    } else if (typeof value === 'string') {
      description[key] = redactString(value);
    } else if (value === undefined) {
      description[key] = '[not set]';
    } else {
      description[key] = '[complex value]';
    }
  }
  return description;
}
