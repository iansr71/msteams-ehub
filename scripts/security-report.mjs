// Runs the security tests and reports pass or fail per control (`pnpm test:security`).
//
// tests/security/controls.json lists each control and the tests that check it. This script runs
// those test files once with Vitest's JSON reporter and writes:
//   reports/security/security-test-report.json
//   reports/security/security-test-report.md
// With --write-docs it also updates docs/security-test-report.md (the committed copy).
//
// A control passes only when every listed test ran and passed and at least one test matched.
// The exit code is 1 when any control fails, has no matching tests, or the secret scan fails.
// The report states what was tested; it is not a statement of compliance with any standard.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRepository } from './secret-scan.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: control results from the catalogue and Vitest's JSON results. */
export function evaluateControls(controls, testResults, rootDir) {
  const byFile = new Map(
    testResults.map((file) => [relative(rootDir, file.name).replaceAll('\\', '/'), file]),
  );
  return controls.map((control) => {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const missing = [];
    for (const reference of control.tests) {
      const file = byFile.get(reference.file);
      const assertions = (file?.assertionResults ?? []).filter(
        (assertion) =>
          reference.suite === undefined || assertion.ancestorTitles.includes(reference.suite),
      );
      // A file that failed to load has no assertions: that is a failure, not "nothing to run".
      if (file === undefined || assertions.length === 0) {
        missing.push(
          reference.suite === undefined ? reference.file : `${reference.file} › ${reference.suite}`,
        );
        continue;
      }
      for (const assertion of assertions) {
        if (assertion.status === 'passed') passed += 1;
        else if (assertion.status === 'failed') failed += 1;
        else skipped += 1;
      }
    }
    const result =
      failed > 0 || missing.length > 0
        ? 'fail'
        : skipped > 0
          ? 'incomplete'
          : passed > 0
            ? 'pass'
            : 'fail';
    return { ...control, result, passed, failed, skipped, missing };
  });
}

export function renderMarkdown(report) {
  const lines = [
    '# Security test report',
    '',
    `Generated ${report.generatedAt} from commit \`${report.commit}\`${report.dirty ? ' with uncommitted changes' : ''}, Node.js ${report.node}.`,
    '',
    `**Result: ${report.result.toUpperCase()}.** ${String(report.totals.controlsPassed)} of ${String(report.totals.controls)} controls passed; ${String(report.totals.testsPassed)} tests passed, ${String(report.totals.testsFailed)} failed, ${String(report.totals.testsSkipped)} skipped. Secret scan: ${report.secretScan.result} (${String(report.secretScan.scanned)} files).`,
    '',
    'Regenerate with `pnpm test:security` (add `-- --write-docs` to update this file).',
    '',
    '## What this report is, and is not',
    '',
    '- It lists the security controls in this repository and whether the automated tests for each one passed on the commit above.',
    '- The tests run without Azure, Moodle, Teams or a real language model. They show what the application does with hostile input and hostile model output; they do not show how the deployed model, tenant or network behave.',
    '- It is not a penetration test, an audit, or a statement of compliance with any standard or regulation (including POPIA, ISO 27001 and SOC 2).',
    '- Known gaps and risks that tests cannot cover are in docs/threat-model.md.',
    '',
    '## Attack tests',
    '',
    '| Attack | Control | Result |',
    '| --- | --- | --- |',
    ...report.controls
      .filter((control) => control.attack !== undefined)
      .map((control) => `| ${control.attack} | ${control.id} | ${control.result} |`),
    '',
    '## Controls',
  ];
  let area = '';
  for (const control of report.controls) {
    if (control.area !== area) {
      area = control.area;
      lines.push(
        '',
        `### ${area}`,
        '',
        '| ID | Control | Result | Tests |',
        '| --- | --- | --- | --- |',
      );
    }
    const counts = `${String(control.passed)} passed${control.failed > 0 ? `, ${String(control.failed)} failed` : ''}${control.skipped > 0 ? `, ${String(control.skipped)} skipped` : ''}${control.missing.length > 0 ? `, not found: ${control.missing.join('; ')}` : ''}`;
    lines.push(`| ${control.id} | ${control.control} | ${control.result} | ${counts} |`);
  }
  lines.push('', '## Test files', '', ...report.files.map((file) => `- \`${file}\``), '');
  return lines.join('\n');
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function main() {
  const writeDocs = process.argv.includes('--write-docs');
  const catalogue = JSON.parse(
    readFileSync(join(root, 'tests', 'security', 'controls.json'), 'utf8'),
  );
  const files = [
    ...new Set(catalogue.controls.flatMap((control) => control.tests.map((test) => test.file))),
  ].sort();
  const outDir = join(root, 'reports', 'security');
  mkdirSync(outDir, { recursive: true });
  const vitestJson = join(outDir, 'vitest-results.json');

  const run = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--reporter=json',
      `--outputFile=${vitestJson}`,
      ...files,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let results;
  try {
    results = JSON.parse(readFileSync(vitestJson, 'utf8'));
  } catch {
    process.stderr.write(`The tests did not produce results.\n${run.stderr.slice(-2000)}\n`);
    process.exit(1);
  }

  const controls = evaluateControls(catalogue.controls, results.testResults, root);
  const scan = scanRepository(root);
  const allPassed =
    controls.every((control) => control.result === 'pass') && scan.findings.length === 0;
  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    commit: git(['rev-parse', '--short=12', 'HEAD']) || 'unknown',
    dirty: git(['status', '--porcelain']) !== '',
    node: process.version,
    result: allPassed ? 'pass' : 'fail',
    totals: {
      controls: controls.length,
      controlsPassed: controls.filter((control) => control.result === 'pass').length,
      testsPassed: results.numPassedTests,
      testsFailed: results.numFailedTests,
      testsSkipped: results.numPendingTests + (results.numTodoTests ?? 0),
    },
    secretScan: {
      result: scan.findings.length === 0 ? 'pass' : 'fail',
      scanned: scan.scanned,
      findings: scan.findings,
    },
    controls,
    files,
  };

  writeFileSync(join(outDir, 'security-test-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  writeFileSync(join(outDir, 'security-test-report.md'), markdown);
  if (writeDocs) {
    writeFileSync(join(root, 'docs', 'security-test-report.md'), markdown);
  }

  for (const control of controls) {
    process.stdout.write(
      `${control.result === 'pass' ? '✓' : '✗'} ${control.id.padEnd(7)} ${control.result.padEnd(10)} ${control.control.slice(0, 90)}\n`,
    );
  }
  process.stdout.write(
    `\nSecurity tests: ${report.result.toUpperCase()}. ${String(report.totals.controlsPassed)}/${String(report.totals.controls)} controls, ${String(report.totals.testsPassed)} tests passed, ${String(report.totals.testsFailed)} failed, ${String(report.totals.testsSkipped)} skipped. Secret scan: ${report.secretScan.result}.\nReport: ${relative(root, join(outDir, 'security-test-report.md'))}\n`,
  );
  process.exit(allPassed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
