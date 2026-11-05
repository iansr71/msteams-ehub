import { cleanEnvironment, type EnvironmentSource } from '../config/load.js';
import { observabilityConfigSchema } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { registerSecretValue } from '../logging/redaction.js';
import { OpenTelemetryTelemetry } from './openTelemetry.js';
import { noopTelemetry, setTelemetry, type Telemetry } from './telemetry.js';

export interface TelemetryStartOptions {
  /** `ehub-api`, `ehub-teams-app`, `ehub-indexer`. */
  readonly serviceName: string;
  readonly version: string;
  /** APPLICATIONINSIGHTS_CONNECTION_STRING; without it telemetry stays off (no-op). */
  readonly connectionString: string | undefined;
  readonly logger: Logger;
  /** For tests: replaces loading @azure/monitor-opentelemetry. */
  readonly useAzureMonitor?: (options: AzureMonitorOptions) => { shutdown(): Promise<void> };
}

/** The subset of @azure/monitor-opentelemetry's options this app sets. */
export interface AzureMonitorOptions {
  readonly azureMonitorExporterOptions: { readonly connectionString: string };
  readonly enableLiveMetrics: boolean;
  readonly enableStandardMetrics: boolean;
  readonly enablePerformanceCounters: boolean;
  readonly instrumentationOptions: Readonly<Record<string, { readonly enabled: boolean }>>;
  readonly samplingRatio: number;
  readonly tracesPerSecond: number;
}

/**
 * Every automatic instrumentation is switched off. The HTTP one would record full outbound URLs,
 * and Moodle file downloads carry the web-service token in the query string; the console and
 * logging ones would export log text. The services emit explicit, allow-listed spans instead.
 */
export const AZURE_MONITOR_OPTIONS: Omit<AzureMonitorOptions, 'azureMonitorExporterOptions'> = {
  enableLiveMetrics: false,
  enableStandardMetrics: true,
  enablePerformanceCounters: false,
  instrumentationOptions: {
    http: { enabled: false },
    azureSdk: { enabled: false },
    mongoDb: { enabled: false },
    mySql: { enabled: false },
    postgreSql: { enabled: false },
    redis: { enabled: false },
    redis4: { enabled: false },
    bunyan: { enabled: false },
    winston: { enabled: false },
    console: { enabled: false },
  },
  samplingRatio: 1,
  // The distribution defaults to a rate-limited sampler (5 traces a second) that takes
  // precedence over samplingRatio and drops a varying share of traces at low volume; 0 selects
  // the fixed-ratio sampler, so every trace is kept.
  tracesPerSecond: 0,
};

/** The distribution's resource detectors, minus `process`. */
const RESOURCE_DETECTORS = [
  'env',
  'host',
  'os',
  'serviceinstance',
  'azure_aks',
  'azure_app_service',
  'azure_functions',
  'azure_vm',
] as const;

/**
 * The value for OTEL_NODE_RESOURCE_DETECTORS. The process detector adds `process.command_args`
 * to every span and metric, and CLI arguments carry questions and email addresses, so it is
 * never enabled (`all` is expanded without it). Unset means the distribution's default.
 */
export function safeResourceDetectors(requested: string | undefined): {
  readonly value: string;
  readonly removed: boolean;
} {
  if (requested === undefined || requested.trim() === '') {
    return { value: 'env,host,os', removed: false };
  }
  const names = requested
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (names.includes('none')) {
    return { value: 'none', removed: false };
  }
  const removed = names.includes('process') || names.includes('all');
  const kept = names.includes('all')
    ? [...RESOURCE_DETECTORS]
    : names.filter((name): name is (typeof RESOURCE_DETECTORS)[number] =>
        (RESOURCE_DETECTORS as readonly string[]).includes(name),
      );
  return { value: kept.length === 0 ? 'none' : kept.join(','), removed };
}

export interface StartedTelemetry {
  readonly telemetry: Telemetry;
  readonly exporting: boolean;
  /** Flushes and stops export; call before a command exits. */
  shutdown(): Promise<void>;
}

/**
 * Configures telemetry for a service. With a connection string, Azure Monitor's OpenTelemetry
 * distribution is registered and spans and metrics go to Application Insights; without one,
 * telemetry is a no-op. Call once, before anything else runs.
 */
export async function startTelemetry(options: TelemetryStartOptions): Promise<StartedTelemetry> {
  if (options.connectionString === undefined) {
    setTelemetry(noopTelemetry);
    return { telemetry: noopTelemetry, exporting: false, shutdown: () => Promise.resolve() };
  }
  registerSecretValue(options.connectionString);
  process.env['OTEL_SERVICE_NAME'] ??= options.serviceName;
  const detectors = safeResourceDetectors(process.env['OTEL_NODE_RESOURCE_DETECTORS']);
  if (detectors.removed) {
    options.logger.warn(
      'OTEL_NODE_RESOURCE_DETECTORS asked for the process detector; it is not used (command-line arguments can hold user input).',
    );
  }
  process.env['OTEL_NODE_RESOURCE_DETECTORS'] = detectors.value;
  let register = options.useAzureMonitor;
  if (register === undefined) {
    // Loaded only when exporting: the distribution is large and starts its own pipelines.
    const azure = await import('@azure/monitor-opentelemetry');
    register = (settings) => {
      azure.useAzureMonitor(settings);
      return { shutdown: () => azure.shutdownAzureMonitor() };
    };
  }
  const registered = register({
    azureMonitorExporterOptions: { connectionString: options.connectionString },
    ...AZURE_MONITOR_OPTIONS,
  });
  const telemetry = new OpenTelemetryTelemetry({
    serviceName: options.serviceName,
    version: options.version,
  });
  setTelemetry(telemetry);
  options.logger.info('Telemetry export to Application Insights is on.', {
    service: options.serviceName,
  });
  return {
    telemetry,
    exporting: true,
    shutdown: async () => {
      try {
        await registered.shutdown();
      } catch (error) {
        options.logger.warn('Telemetry could not be flushed.', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        setTelemetry(noopTelemetry);
      }
    },
  };
}

/**
 * Starts telemetry from APPLICATIONINSIGHTS_CONNECTION_STRING. An invalid value is reported (by
 * name only) and telemetry stays off: monitoring must never stop a service from starting.
 */
export async function startTelemetryFromEnv(options: {
  readonly serviceName: string;
  readonly version: string;
  readonly env: EnvironmentSource;
  readonly logger: Logger;
}): Promise<StartedTelemetry> {
  const parsed = observabilityConfigSchema.safeParse(cleanEnvironment(options.env));
  if (!parsed.success) {
    options.logger.warn('APPLICATIONINSIGHTS_CONNECTION_STRING is invalid; telemetry is off.');
  }
  return await startTelemetry({
    serviceName: options.serviceName,
    version: options.version,
    connectionString: parsed.success
      ? parsed.data.APPLICATIONINSIGHTS_CONNECTION_STRING
      : undefined,
    logger: options.logger,
  });
}
