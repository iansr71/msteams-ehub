// Runs the acceptance suites and reports pass or fail per suite (`pnpm test:acceptance`).
//
// tests/acceptance/suites.json lists each suite, what it proves and its test files. This script
// runs those files once with Vitest's JSON reporter and writes:
//   reports/acceptance/acceptance-report.json
//   reports/acceptance/acceptance-report.md
// With --write-docs it also updates docs/acceptance-report.md (the committed copy).
//
// A suite passes only when every listed file produced results and every test in it passed. A
// skipped test makes the suite `incomplete`, which counts as a failure: a suite that quietly
// stops running is the failure mode this report exists to catch. Suites whose `requires` is not
// `none` are reported as `not-run (needs <service>)` and never affect the exit code: they can
// only be checked against a deployment, and the report names the command for each.
//
// The exit code is 1 when any runnable suite does not pass.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pure: suite results from the catalogue and Vitest's JSON results. */
export function evaluateSuites(suites, testResults, rootDir) {
  const byFile = new Map(
    testResults.map((file) => [relative(rootDir, file.name).replaceAll('\\', '/'), file]),
  );
  return suites.map((suite) => {
    if (suite.requires !== 'none') {
      return { ...suite, result: 'not-run', passed: 0, failed: 0, skipped: 0, missing: [] };
    }
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const missing = [];
    for (const reference of suite.files) {
      const file = byFile.get(reference);
      const assertions = file?.assertionResults ?? [];
      // A file that failed to load has no assertions: that is a failure, not "nothing to run".
      if (file === undefined || assertions.length === 0) {
        missing.push(reference);
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
    return { ...suite, result, passed, failed, skipped, missing };
  });
}

function counts(suite) {
  if (suite.result === 'not-run') {
    return `needs ${suite.requires}: ${suite.command ?? 'see docs/acceptance.md'}`;
  }
  return [
    `${String(suite.passed)} passed`,
    suite.failed > 0 ? `${String(suite.failed)} failed` : '',
    suite.skipped > 0 ? `${String(suite.skipped)} skipped` : '',
    suite.missing.length > 0 ? `not found: ${suite.missing.join('; ')}` : '',
  ]
    .filter((part) => part !== '')
    .join(', ');
}

export function renderMarkdown(report) {
  const runnable = report.suites.filter((suite) => suite.result !== 'not-run');
  const environment = report.suites.filter((suite) => suite.result === 'not-run');
  const lines = [
    '# Acceptance test report',
    '',
    `Generated ${report.generatedAt} from commit \`${report.commit}\`${report.dirty ? ' with uncommitted changes' : ''}, Node.js ${report.node}.`,
    '',
    `**Result: ${report.result.toUpperCase()}.** ${String(report.totals.suitesPassed)} of ${String(report.totals.suitesRunnable)} runnable suites passed; ${String(report.totals.testsPassed)} tests passed, ${String(report.totals.testsFailed)} failed, ${String(report.totals.testsSkipped)} skipped. ${String(environment.length)} suites need a live service and were not run.`,
    '',
    'Regenerate with `pnpm test:acceptance` (add `-- --write-docs` to update this file).',
    '',
    '## What this report is, and is not',
    '',
    '- It lists the acceptance suites in this repository and whether their automated tests passed on the commit above.',
    '- The runnable suites use fakes for Moodle, Azure AI Search, the embedding service and the chat model. The indexing pipeline, retrieval, grounding, citation, authorization and Teams rendering code is the real code, so an answer depends on what the pipeline actually indexed.',
    '- Because the chat model is a fake that quotes the retrieved passages, these suites prove the system is faithful to the index. They do not predict how a real language model phrases answers, nor how good the content in Moodle is.',
    '- Checks that need a live Moodle, Azure or Teams are listed below and must be run against a deployment.',
    '',
    '## Suites',
    '',
    '| ID | Suite | Result | Tests |',
    '| --- | --- | --- | --- |',
    ...runnable.map(
      (suite) => `| ${suite.id} | ${suite.name} | ${suite.result} | ${counts(suite)} |`,
    ),
    '',
    '## Checks that need a live service',
    '',
    '| ID | Check | Needs | How to run |',
    '| --- | --- | --- | --- |',
    ...environment.map(
      (suite) =>
        `| ${suite.id} | ${suite.name} | ${suite.requires} | \`${suite.command ?? 'see docs/acceptance.md'}\` |`,
    ),
    '',
    '## What each suite proves',
    '',
    ...report.suites.flatMap((suite) => [`- **${suite.id} ${suite.name}** — ${suite.proves}`]),
    '',
  ];
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
    readFileSync(join(root, 'tests', 'acceptance', 'suites.json'), 'utf8'),
  );
  const files = [
    ...new Set(
      catalogue.suites.filter((suite) => suite.requires === 'none').flatMap((suite) => suite.files),
    ),
  ].sort();
  const outDir = join(root, 'reports', 'acceptance');
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

  const suites = evaluateSuites(catalogue.suites, results.testResults, root);
  const runnable = suites.filter((suite) => suite.result !== 'not-run');
  const allPassed = runnable.every((suite) => suite.result === 'pass');
  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    commit: git(['rev-parse', '--short=12', 'HEAD']) || 'unknown',
    dirty: git(['status', '--porcelain']) !== '',
    node: process.version,
    result: allPassed ? 'pass' : 'fail',
    totals: {
      suites: suites.length,
      suitesRunnable: runnable.length,
      suitesPassed: runnable.filter((suite) => suite.result === 'pass').length,
      suitesNeedingServices: suites.length - runnable.length,
      testsPassed: results.numPassedTests,
      testsFailed: results.numFailedTests,
      testsSkipped: results.numPendingTests + (results.numTodoTests ?? 0),
    },
    suites,
    files,
  };

  writeFileSync(join(outDir, 'acceptance-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderMarkdown(report);
  writeFileSync(join(outDir, 'acceptance-report.md'), markdown);
  if (writeDocs) {
    writeFileSync(join(root, 'docs', 'acceptance-report.md'), markdown);
  }

  for (const suite of suites) {
    const mark = suite.result === 'pass' ? '✓' : suite.result === 'not-run' ? '–' : '✗';
    process.stdout.write(
      `${mark} ${suite.id.padEnd(3)} ${suite.result.padEnd(10)} ${suite.name.slice(0, 60).padEnd(60)} ${counts(suite)}\n`,
    );
  }
  process.stdout.write(
    `\nAcceptance tests: ${report.result.toUpperCase()}. ${String(report.totals.suitesPassed)}/${String(report.totals.suitesRunnable)} runnable suites, ${String(report.totals.testsPassed)} tests passed, ${String(report.totals.testsFailed)} failed, ${String(report.totals.testsSkipped)} skipped. ${String(report.totals.suitesNeedingServices)} suites need a live Moodle, Azure or Teams.\nReport: ${relative(root, join(outDir, 'acceptance-report.md'))}\n`,
  );
  process.exit(allPassed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
