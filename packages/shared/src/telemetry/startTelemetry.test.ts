import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, type LogSink } from '../logging/logger.js';
import { clearRegisteredSecretValues, redactString } from '../logging/redaction.js';
import { OpenTelemetryTelemetry } from './openTelemetry.js';
import {
  AZURE_MONITOR_OPTIONS,
  startTelemetry,
  safeResourceDetectors,
  startTelemetryFromEnv,
  type AzureMonitorOptions,
} from './startTelemetry.js';
import { getTelemetry, noopTelemetry, resetTelemetry } from './telemetry.js';

const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=https://example.in.applicationinsights.azure.com/';

function sink(): LogSink & { text: () => string } {
  const lines: string[] = [];
  return { write: (line) => lines.push(line), text: () => lines.join('\n') };
}

afterEach(() => {
  resetTelemetry();
  clearRegisteredSecretValues();
});

describe('startTelemetry', () => {
  it('stays a no-op without a connection string', async () => {
    let called = false;
    const started = await startTelemetry({
      serviceName: 'ehub-api',
      version: '1.0.0',
      connectionString: undefined,
      logger: createLogger({ service: 't', sink: sink() }),
      useAzureMonitor: () => {
        called = true;
        return { shutdown: () => Promise.resolve() };
      },
    });
    expect(started.exporting).toBe(false);
    expect(getTelemetry()).toBe(noopTelemetry);
    expect(called).toBe(false);
  });

  it('registers Azure Monitor with every auto-instrumentation off and the secret redacted', async () => {
    const out = sink();
    let options: AzureMonitorOptions | undefined;
    let shutdowns = 0;
    const started = await startTelemetry({
      serviceName: 'ehub-api',
      version: '1.0.0',
      connectionString: CONNECTION_STRING,
      logger: createLogger({ service: 't', sink: out }),
      useAzureMonitor: (settings) => {
        options = settings;
        return {
          shutdown: () => {
            shutdowns += 1;
            return Promise.resolve();
          },
        };
      },
    });
    expect(started.exporting).toBe(true);
    expect(getTelemetry()).toBeInstanceOf(OpenTelemetryTelemetry);
    expect(options?.azureMonitorExporterOptions.connectionString).toBe(CONNECTION_STRING);
    expect(options?.enableLiveMetrics).toBe(false);
    // The distribution's default rate-limited sampler would override samplingRatio.
    expect(options?.tracesPerSecond).toBe(0);
    expect(options?.samplingRatio).toBe(1);
    expect(options?.instrumentationOptions['http']).toEqual({ enabled: false });
    for (const [name, setting] of Object.entries(AZURE_MONITOR_OPTIONS.instrumentationOptions)) {
      expect(setting.enabled, name).toBe(false);
    }
    expect(redactString(`value ${CONNECTION_STRING}`)).not.toContain('InstrumentationKey=');
    expect(out.text()).not.toContain('InstrumentationKey');

    await started.shutdown();
    expect(shutdowns).toBe(1);
    expect(getTelemetry()).toBe(noopTelemetry);
  });

  it('reports a failed flush and still resets', async () => {
    const out = sink();
    const started = await startTelemetry({
      serviceName: 'ehub-api',
      version: '1.0.0',
      connectionString: CONNECTION_STRING,
      logger: createLogger({ service: 't', sink: out }),
      useAzureMonitor: () => ({ shutdown: () => Promise.reject(new TypeError(CONNECTION_STRING)) }),
    });
    await expect(started.shutdown()).resolves.toBeUndefined();
    expect(out.text()).toContain('"errorType":"TypeError"');
    expect(out.text()).not.toContain('InstrumentationKey');
    expect(getTelemetry()).toBe(noopTelemetry);
  });
});

describe('startTelemetryFromEnv', () => {
  it('keeps telemetry off and warns by name when the connection string is invalid', async () => {
    const out = sink();
    const started = await startTelemetryFromEnv({
      serviceName: 'ehub-api',
      version: '1.0.0',
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: 'not-a-connection-string' },
      logger: createLogger({ service: 't', sink: out }),
    });
    expect(started.exporting).toBe(false);
    expect(out.text()).toContain('APPLICATIONINSIGHTS_CONNECTION_STRING is invalid');
    expect(out.text()).not.toContain('not-a-connection-string');
  });

  it('is off when the variable is unset', async () => {
    const started = await startTelemetryFromEnv({
      serviceName: 'ehub-api',
      version: '1.0.0',
      env: {},
      logger: createLogger({ service: 't', sink: sink() }),
    });
    expect(started.exporting).toBe(false);
  });
});

describe('resource detectors', () => {
  it.each([
    [undefined, 'env,host,os', false],
    ['', 'env,host,os', false],
    ['env,host', 'env,host', false],
    ['process', 'none', true],
    ['env,Process,os', 'env,os', true],
    [
      'all',
      'env,host,os,serviceinstance,azure_aks,azure_app_service,azure_functions,azure_vm',
      true,
    ],
    ['none', 'none', false],
    ['bogus', 'none', false],
  ])('%s becomes %s', (requested, value, removed) => {
    expect(safeResourceDetectors(requested)).toEqual({ value, removed });
  });

  it('never lets the process detector run when telemetry starts', async () => {
    const previous = process.env['OTEL_NODE_RESOURCE_DETECTORS'];
    process.env['OTEL_NODE_RESOURCE_DETECTORS'] = 'all';
    const out = sink();
    try {
      const started = await startTelemetry({
        serviceName: 'ehub-api',
        version: '1.0.0',
        connectionString: CONNECTION_STRING,
        logger: createLogger({ service: 't', sink: out }),
        useAzureMonitor: () => {
          expect(process.env['OTEL_NODE_RESOURCE_DETECTORS']).not.toMatch(/process|all/);
          return { shutdown: () => Promise.resolve() };
        },
      });
      await started.shutdown();
      expect(out.text()).toContain('process detector');
    } finally {
      if (previous === undefined) {
        delete process.env['OTEL_NODE_RESOURCE_DETECTORS'];
      } else {
        process.env['OTEL_NODE_RESOURCE_DETECTORS'] = previous;
      }
    }
  });
});
