import {
  buildHealthReport,
  healthExitCode,
  readPackageVersion,
  type CommandDefinition,
  type ConfigHealthRequirement,
  type EnvironmentSource,
  type HealthReport,
} from '@ehub/shared';

export const SERVICE_NAME = 'ehub-indexer';

export const INDEXER_CONFIG_REQUIREMENTS: readonly ConfigHealthRequirement[] = [
  { feature: 'runtime', requirement: 'required' },
  {
    feature: 'moodle',
    requirement: 'optional',
    missingNote: 'Needed for the moodle:* commands and, from phase 4, indexing.',
  },
  {
    feature: 'azureSearch',
    requirement: 'optional',
    missingNote: 'Not required until indexing is implemented (phase 6).',
  },
  {
    feature: 'azureOpenAI',
    requirement: 'optional',
    missingNote: 'Not required until embeddings are implemented (phase 8).',
  },
  { feature: 'extraction', requirement: 'optional' },
  { feature: 'observability', requirement: 'optional' },
];

export function buildIndexerHealthReport(env: EnvironmentSource, clock?: () => Date): HealthReport {
  return buildHealthReport({
    service: SERVICE_NAME,
    version: readPackageVersion(new URL('../../package.json', import.meta.url)),
    requirements: INDEXER_CONFIG_REQUIREMENTS,
    env,
    ...(clock === undefined ? {} : { clock }),
  });
}

export function createHealthCommand(env: EnvironmentSource = process.env): CommandDefinition {
  return {
    description: 'Report configuration health as JSON (never prints values or secrets).',
    run: ({ stdout, logger }) => {
      const report = buildIndexerHealthReport(env);
      stdout(JSON.stringify(report, null, 2));
      logger.info('Health check completed.', { status: report.status });
      return Promise.resolve(healthExitCode(report));
    },
  };
}
