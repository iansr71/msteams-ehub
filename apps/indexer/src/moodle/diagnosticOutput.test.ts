import { clearRegisteredSecretValues, registerSecretValue } from '@ehub/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { fixtureClient } from './__fixtures__/fixtureClient.js';
import {
  formatBytes,
  renderCoursesText,
  renderInspectionText,
  renderJson,
  renderPingText,
  sanitizeText,
} from './diagnosticOutput.js';
import { discoverCourses } from './discoverCourses.js';
import { inspectCourse } from './inspectCourse.js';
import { pingMoodle } from './pingMoodle.js';

afterEach(() => {
  clearRegisteredSecretValues();
});

describe('sanitizeText', () => {
  it('removes terminal escape sequences and bidi overrides', () => {
    expect(sanitizeText('Safe\u001b[31mRED\u001b[0m name')).toBe('Safe [31mRED [0m name');
    expect(sanitizeText('abc‮gnp.exe')).toBe('abc gnp.exe');
    expect(sanitizeText('line1\nline2\r\tend')).toBe('line1 line2 end');
  });

  it('bounds length and marks missing values', () => {
    expect(sanitizeText('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(sanitizeText(undefined)).toBe('-');
    expect(sanitizeText('   ')).toBe('-');
  });
});

describe('formatBytes', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(182044)).toBe('177.8 KB');
    expect(formatBytes(250_000_000)).toBe('238.4 MB');
  });
});

describe('rendering', () => {
  it('renders an inspection with summary, tree and unsupported reasons', async () => {
    const { client, baseUrl } = fixtureClient({ contents: 'contents-multiple-files' });
    const { structure, summary } = await inspectCourse(client, baseUrl, 12, {
      maxFileBytes: 100 * 1024 * 1024,
    });
    const text = renderInspectionText(structure, summary);

    expect(text).toContain('Course 12: Consultation Standards (CONSULT101) — visible');
    expect(text).toContain('Modules:    3 (0 hidden; 2 supported, 1 unsupported)');
    expect(text).toContain('Resources:  8 (5 supported, 3 unsupported, 0 hidden from students)');
    expect(text).toContain('Unsupported: file_type_not_supported×3');
    expect(text).toContain('[801] Treatment protocols  <folder → folder>  supported');
    expect(text).toMatch(
      /file\s+\/slides\/induction\.pptx .* 878\.9 KB .* folder-file {2}supported/,
    );
    expect(text).toContain('unsupported (file_type_not_supported)');
  });

  it('renders an empty course clearly', async () => {
    const { client, baseUrl } = fixtureClient({ contents: 'contents-empty-course' });
    const { structure, summary } = await inspectCourse(client, baseUrl, 12);
    expect(renderInspectionText(structure, summary)).toContain('(no modules)');
  });

  it('never renders descriptions or summaries, only their presence', async () => {
    const { client, baseUrl } = fixtureClient({ contents: 'contents-unsupported-modules' });
    const { structure, summary } = await inspectCourse(client, baseUrl, 12);
    const outputs = [renderInspectionText(structure, summary), renderJson({ structure, summary })];
    for (const output of outputs) {
      expect(output).not.toContain('Welcome to the E-Hub');
      expect(output).not.toContain('How we run consultations');
    }
  });

  it('renders the course table and ping report', async () => {
    const { client, baseUrl } = fixtureClient();
    const courses = renderCoursesText(await discoverCourses(client, baseUrl));
    expect(courses.split('\n')[0]).toMatch(/^ID\s+Short name\s+Visible\s+Full name$/);
    expect(courses).toContain('3 of 3 courses shown (site front page excluded).');
    expect(courses).toMatch(/7\s+LASER-SAFE\s+no\s+Laser Safety Procedures/);

    const ping = renderPingText(await pingMoodle(client, baseUrl));
    expect(ping).toContain('Moodle connection: OK');
    expect(ping).toContain('6 of 6 required functions available');
  });

  it('strips control characters from untrusted course names in the table', async () => {
    const { client, baseUrl } = fixtureClient({
      courses: [{ id: 5, shortname: 'X\u001b]0;pwned\u0007', fullname: 'Evil\u001b[2J name' }],
    });
    const text = renderCoursesText(await discoverCourses(client, baseUrl));
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  it('scrubs registered secrets from every rendering as a final pass', () => {
    registerSecretValue('planted-secret-value-123456');
    expect(renderJson({ name: 'planted-secret-value-123456' })).not.toContain(
      'planted-secret-value-123456',
    );
  });
});
