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
    feature: 'embeddings',
    requirement: 'optional',
    missingNote: 'Without it, retrieval is keyword-only.',
  },
  {
    feature: 'chat',
    requirement: 'optional',
    missingNote: 'Needed for answer generation (the ask command).',
  },
  {
    feature: 'apiServer',
    requirement: 'optional',
    missingNote: 'Settings for `serve`, the HTTP answer API used by the Teams app.',
  },
  {
    feature: 'entraAuth',
    requirement: 'optional',
    missingNote: 'Needed for `serve` to accept Entra ID sign-in (docs/entra-sso.md).',
  },
  {
    feature: 'azureIdentity',
    requirement: 'optional',
    missingNote: 'Service credentials for Azure resources; Managed Identity in Azure.',
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
