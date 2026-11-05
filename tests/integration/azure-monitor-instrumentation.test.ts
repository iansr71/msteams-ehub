import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AZURE_MONITOR_OPTIONS } from '@ehub/shared';
import { describe, expect, it } from 'vitest';

/*
 * Runs the real Azure Monitor distribution in a child process (instrumentation patches modules
 * as they load, so it needs a fresh process) and makes an outbound `http` request and a `fetch`
 * whose URLs carry a token, as Moodle downloads do. With this app's options no automatic span
 * may appear, and an explicit span must be exported (so sampling keeps it). The control run enables HTTP instrumentation and must show the token, which proves
 * the probe would catch a leak (for example after a distribution upgrade turns a new
 * instrumentation on by default).
 */

const SECRET = 'probe-token-secret-7d3f9a';
const run = promisify(execFile);

const PROBE = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
const { InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
const { metrics, trace } = await import('@opentelemetry/api');
const { MetricReader } = await import('@opentelemetry/sdk-metrics');
class OnDemandReader extends MetricReader {
  onForceFlush() { return Promise.resolve(); }
  onShutdown() { return Promise.resolve(); }
}
const reader = new OnDemandReader();
const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(exporter);
useAzureMonitor({
  ...JSON.parse(process.env.PROBE_OPTIONS),
  azureMonitorExporterOptions: {
    connectionString: 'InstrumentationKey=00000000-0000-4000-8000-000000000000;IngestionEndpoint=http://127.0.0.1:9/',
  },
  spanProcessors: [processor],
  metricReaders: [reader],
});
// Loaded after the distribution, as the services' own modules are.
const http = require('node:http');
const server = http.createServer((request, response) => response.end('ok'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
await new Promise((resolve, reject) =>
  http.get(base + '/webservice/pluginfile.php/1/a.pdf?token=' + process.env.PROBE_SECRET, (response) => {
    response.resume();
    response.on('end', resolve);
  }).on('error', reject),
);
await (await fetch(base + '/webservice/rest/server.php?wstoken=' + process.env.PROBE_SECRET)).text();
// fetch keeps its connection alive; close it rather than wait for the keep-alive timeout.
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
// An explicit span, as the services create: it must reach the exporter (and is not sampled out).
trace.getTracer('probe').startSpan('explicit.span').end();
// Export waits for the resource's asynchronous detector attributes.
await processor.forceFlush();
metrics.getMeter('probe').createCounter('explicit.counter').add(3, { status: 'answered' });
const collected = await reader.collect();
const metricNames = collected.resourceMetrics.scopeMetrics.flatMap((scope) =>
  scope.metrics.map((metric) => metric.descriptor.name),
);
process.stdout.write(JSON.stringify({
  spans: exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes })),
  metricNames,
}),
  // Shutting down would flush to the dummy endpoint for several seconds; nothing needs it.
  () => process.exit(0),
);

`;

interface ProbeResult {
  readonly spans: { readonly name: string; readonly attributes: unknown }[];
  readonly metricNames: string[];
}

async function probe(options: unknown): Promise<ProbeResult> {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', PROBE], {
    // Resolves the distribution from the package that depends on it.
    cwd: fileURLToPath(new URL('../../packages/shared/', import.meta.url)),
    env: {
      PATH: process.env['PATH'] ?? '',
      PROBE_OPTIONS: JSON.stringify(options),
      PROBE_SECRET: SECRET,
    },
    timeout: 60_000,
  });
  return JSON.parse(stdout) as ProbeResult;
}

describe('Azure Monitor distribution with this app’s options', { timeout: 90_000 }, () => {
  it('exports explicit spans and metrics, and no automatic span for outbound http or fetch', async () => {
    const { spans, metricNames } = await probe(AZURE_MONITOR_OPTIONS);
    expect(spans.map((span) => span.name)).toEqual(['explicit.span']);
    expect(JSON.stringify(spans)).not.toContain(SECRET);
    expect(metricNames).toContain('explicit.counter');
  });

  it('control: with HTTP instrumentation on, the token would be exported', async () => {
    const { spans } = await probe({
      ...AZURE_MONITOR_OPTIONS,
      instrumentationOptions: {
        ...AZURE_MONITOR_OPTIONS.instrumentationOptions,
        http: { enabled: true },
      },
    });
    expect(spans.length).toBeGreaterThan(0);
    expect(JSON.stringify(spans)).toContain(SECRET);
  });
});
