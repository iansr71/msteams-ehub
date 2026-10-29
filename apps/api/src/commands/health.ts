import {
  buildHealthReport,
  healthExitCode,
  readPackageVersion,
  type CommandDefinition,
  type ConfigHealthRequirement,
  type EnvironmentSource,
  type HealthReport,
} from '@ehub/shared';

export const SERVICE_NAME = 'ehub-api';

export const API_CONFIG_REQUIREMENTS: readonly ConfigHealthRequirement[] = [
  { feature: 'runtime', requirement: 'required' },
  {
    feature: 'azureSearch',
    requirement: 'optional',
    missingNote: 'Needed for retrieval (the retrieve and evaluation commands).',
  },
  { feature: 'retrieval', requirement: 'optional' },
  {
    feature: 'azureOpenAI',
    requirement: 'optional',
    missingNote: 'Not required until answer generation is implemented (phase 9).',
  },
  {
    feature: 'azureIdentity',
    requirement: 'optional',
    missingNote: 'Not required until Entra ID SSO is implemented (phase 13).',
  },
  { feature: 'observability', requirement: 'optional' },
];

export function buildApiHealthReport(env: EnvironmentSource, clock?: () => Date): HealthReport {
  return buildHealthReport({
    service: SERVICE_NAME,
    version: readPackageVersion(new URL('../../package.json', import.meta.url)),
    requirements: API_CONFIG_REQUIREMENTS,
    env,
    ...(clock === undefined ? {} : { clock }),
  });
}

export function createHealthCommand(env: EnvironmentSource = process.env): CommandDefinition {
  return {
    description: 'Report configuration health as JSON (never prints values or secrets).',
    run: ({ stdout, logger }) => {
      const report = buildApiHealthReport(env);
      stdout(JSON.stringify(report, null, 2));
      logger.info('Health check completed.', { status: report.status });
      return Promise.resolve(healthExitCode(report));
    },
  };
}
