import { describe, expect, it } from 'vitest';

import { reportSyncGauges } from '../../apps/indexer/src/jobs/syncMetrics.js';
import { incrementalSync } from '../../apps/indexer/src/jobs/syncJobs.js';
import {
  HARNESS_AZURE,
  TENANT_ID,
  pageHtml,
} from '../../apps/indexer/src/jobs/__fixtures__/syncHarness.js';
import { createEndToEndStack } from './framework/endToEnd.js';

/*
 * Acceptance suite 18: an operator can see what the system did, and what they see is safe to
 * paste into a ticket. Both halves matter: logs nobody dares share are no use during an
 * incident, and a leaked Moodle token is a tenant-wide compromise.
 */

const SECRET_GUIDANCE = 'Reapply broad-spectrum sunscreen every two hours after a peel.';
const QUESTION = 'What aftercare applies after a peel?';

function logLines(logs: readonly string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('18 Monitoring and redaction', () => {
  it('logs structured JSON carrying the job correlation ID', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', [SECRET_GUIDANCE]),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'observe-1' });

    const entries = logLines(stack.harness.logs);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry['time'] === 'string')).toBe(true);
    expect(entries.every((entry) => typeof entry['level'] === 'string')).toBe(true);
    expect(entries.every((entry) => typeof entry['msg'] === 'string')).toBe(true);
    expect(entries.some((entry) => JSON.stringify(entry).includes('observe-1'))).toBe(true);
  });

  it('never writes credentials into the indexer logs', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', [SECRET_GUIDANCE]),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'observe-2' });

    const text = stack.harness.logs.join('\n');
    for (const secret of [HARNESS_AZURE.searchKey, HARNESS_AZURE.openAiKey]) {
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text.toLowerCase()).not.toContain('api-key');
  });

  it('never writes course content into the indexer logs', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', [SECRET_GUIDANCE]),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'observe-3' });

    const text = stack.harness.logs.join('\n');
    // Resource IDs and counts are fine; the words of the document are not.
    expect(text).not.toContain('broad-spectrum sunscreen');
    expect(text).toContain('701');
  });

  it('reports sync lag and resource counts after a run', async () => {
    const stack = await createEndToEndStack();
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', [SECRET_GUIDANCE]),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'gauges' });

    stack.harness.clock.advance(300_000);
    const snapshot = await reportSyncGauges(
      stack.harness.state,
      TENANT_ID,
      stack.harness.clock.now(),
    );
    expect(snapshot.lagSeconds).toBe(300);
    expect(snapshot.resources.indexed).toBe(1);
    expect(snapshot.resources.failed).toBe(0);
  });

  it('logs an answer without the question text or the retrieved passages', async () => {
    const answerLogs: string[] = [];
    const stack = await createEndToEndStack({ logs: answerLogs });
    stack.harness.site.addCourse(12, { name: 'Chemical peels' });
    stack.harness.site.setPage(12, 701, {
      name: 'Aftercare',
      html: pageHtml('Aftercare', [SECRET_GUIDANCE]),
    });
    await incrementalSync(await stack.harness.services(), { jobId: 'answer-logs' });
    const before = answerLogs.length;
    const answer = await stack.ask(QUESTION);
    expect(answer.status).toBe('answered');

    const text = answerLogs.slice(before).join('\n');
    const answered = logLines(answerLogs.slice(before)).find(
      (entry) => entry['msg'] === 'Question answered.',
    );
    // Counts, not content: enough to diagnose a bad answer rate without storing what was asked.
    expect(answered).toMatchObject({ status: 'answered' });
    expect(answered?.['sources']).toBeGreaterThan(0);
    expect(text).not.toContain(QUESTION);
    expect(text).not.toContain('broad-spectrum sunscreen');
  });

  it('records a failure category when a question cannot be answered', async () => {
    const answerLogs: string[] = [];
    const stack = await createEndToEndStack({ logs: answerLogs });
    const answer = await stack.ask('What does the handbook say about parking?');
    expect(answer.status).not.toBe('answered');
    const entries = logLines(answerLogs).filter((entry) => entry['msg'] === 'Question answered.');
    expect(entries.at(-1)?.['status']).not.toBe('answered');
  });
});
