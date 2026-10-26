import {
  getConfigFeatureStatus,
  type ConfigFeatureStatus,
  type EnvironmentSource,
} from '../config/load.js';
import type { ConfigFeature } from '../config/schema.js';
import { getCorrelationId } from '../correlation/correlation.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheckResult {
  readonly name: string;
  readonly status: HealthStatus;
  readonly detail: string;
  /** Variable names or other non-sensitive identifiers relevant to the result. */
  readonly items?: readonly string[];
}

export interface RuntimeInfo {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
}

export interface HealthReport {
  readonly service: string;
  readonly version: string;
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly correlationId: string | undefined;
  readonly runtime: RuntimeInfo;
  readonly checks: readonly HealthCheckResult[];
}

const SEVERITY: Readonly<Record<HealthStatus, number>> = { pass: 0, warn: 1, fail: 2 };

export function aggregateHealthStatus(results: readonly HealthCheckResult[]): HealthStatus {
  return results.reduce<HealthStatus>(
    (worst, result) => (SEVERITY[result.status] > SEVERITY[worst] ? result.status : worst),
    'pass',
  );
}

export function getRuntimeInfo(): RuntimeInfo {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

export interface ConfigHealthRequirement {
  readonly feature: ConfigFeature;
  /**
   * `required`: missing or invalid fails the check.
   * `optional`: missing only warns; invalid still fails, because a half-configured
   * dependency is a deployment mistake rather than a deliberate omission.
   */
  readonly requirement: 'required' | 'optional';
  /** Shown when an optional feature is missing, e.g. why it is not needed yet. */
  readonly missingNote?: string;
}

export interface HealthReportOptions {
  readonly service: string;
  readonly version: string;
  readonly requirements: readonly ConfigHealthRequirement[];
  readonly env: EnvironmentSource;
  readonly clock?: () => Date;
}

/** Builds a configuration-level health report. Contains variable names, never values. */
export function buildHealthReport(options: HealthReportOptions): HealthReport {
  const checks = options.requirements.map((requirement) =>
    checkConfigFeature(requirement, options.env),
  );
  return {
    service: options.service,
    version: options.version,
    status: aggregateHealthStatus(checks),
    timestamp: (options.clock ?? (() => new Date()))().toISOString(),
    correlationId: getCorrelationId(),
    runtime: getRuntimeInfo(),
    checks,
  };
}

export function healthExitCode(report: HealthReport): number {
  return report.status === 'fail' ? 1 : 0;
}

export function checkConfigFeature(
  requirement: ConfigHealthRequirement,
  env: EnvironmentSource,
): HealthCheckResult {
  const status: ConfigFeatureStatus = getConfigFeatureStatus(requirement.feature, env);
  const name = `configuration.${requirement.feature}`;
  const items = status.problems.map((problem) => `${problem.variable}: ${problem.message}`);

  switch (status.state) {
    case 'valid':
      return {
        name,
        status: 'pass',
        detail:
          status.anyVariableSet || requirement.feature === 'runtime'
            ? 'Configured.'
            : 'Not configured (all variables optional).',
      };
    case 'missing':
      return requirement.requirement === 'required'
        ? { name, status: 'fail', detail: 'Required configuration is missing.', items }
        : {
            name,
            status: 'warn',
            detail: requirement.missingNote ?? 'Not configured.',
            items,
          };
    case 'invalid':
      return { name, status: 'fail', detail: 'Configuration is invalid.', items };
  }
}
