// Release readiness (`pnpm release:verify`): runs every gate this repository can run, then
// writes the release report Prompt 20 asks for.
//
//   reports/release/release-report.json
//   reports/release/release-report.md
//
// Three outcomes per step, and the difference matters:
//
//   pass     the step ran and succeeded.
//   fail     the step ran and failed. The release is not ready.
//   blocked  the step could not run here, because the tooling or the production configuration
//            is not available on this machine. The release is *also* not ready: a gate that
//            nobody ran is not a gate that passed. The report lists it as a manual check.
//
// The one exception is Bicep validation, which Prompt 20 asks for only "where tooling is
// installed": without a Bicep CLI it is reported as skipped and becomes a manual check, but it
// does not by itself hold the release.
//
// Nothing here prints configuration values. Step output is captured, and only the tail of a
// failing step's output is shown, after redaction of anything that looks like a secret.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Collapses anything that looks like a credential before it reaches a report. */
export function redactOutput(text) {
  return text
    .replace(/(["'\s=:])(?:[A-Za-z0-9_-]{24,})(["'\s]|$)/g, '$1[redacted]$2')
    .replace(/wstoken=[^&\s"']+/gi, 'wstoken=[redacted]')
    .replace(/InstrumentationKey=[^;\s"']+/gi, 'InstrumentationKey=[redacted]');
}

/**
 * Pure: the release verdict. Ready only when every step passed; `blocked` steps hold the
 * release exactly as failures do, which is what stops a report from claiming readiness for
 * gates that never ran.
 */
export function summarizeSteps(steps) {
  const failed = steps.filter((step) => step.result === 'fail');
  const blocked = steps.filter((step) => step.result === 'blocked');
  const skipped = steps.filter((step) => step.result === 'skipped');
  const ready = failed.length === 0 && blocked.length === 0;
  return {
    ready,
    verdict: ready
      ? skipped.length === 0
        ? 'ready'
        : 'ready-with-skipped-steps'
      : failed.length > 0
        ? 'not-ready-failed'
        : 'not-ready-incomplete',
    failed: failed.map((step) => step.id),
    blocked: blocked.map((step) => step.id),
    skipped: skipped.map((step) => step.id),
  };
}

function git(args) {
  try {
    // stderr is swallowed: `git describe` writes "No names found" when there is no tag, and
    // that is a normal state here, not something to print in the middle of a release run.
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hasBicep(env) {
  for (const candidate of [env['EHUB_BICEP'], 'bicep'].filter((entry) => entry !== undefined)) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', stdio: 'ignore' });
    if (probe.status === 0) {
      return true;
    }
  }
  const az = spawnSync('az', ['bicep', 'version'], { encoding: 'utf8', stdio: 'ignore' });
  return az.status === 0;
}

/** Variables the Teams manifest and the production configuration checks need. */
const MANIFEST_VARIABLES = [
  'TEAMS_APP_ID',
  'TEAMS_BOT_CLIENT_ID',
  'TEAMS_DEVELOPER_NAME',
  'TEAMS_WEBSITE_URL',
  'TEAMS_PRIVACY_URL',
  'TEAMS_TERMS_URL',
];

/** Reads KEY=value lines from an environment file, for --env-file. */
function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match === null || match[1] === undefined) {
      continue;
    }
    const raw = (match[2] ?? '').trim();
    values[match[1]] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function buildSteps(env) {
  const missingManifest = MANIFEST_VARIABLES.filter((name) => (env[name] ?? '').trim() === '');
  // The release-scope configuration check needs the same non-secret settings as the manifest.
  // Secrets are not part of it: they stay in Key Vault and `pnpm preflight` checks them in the
  // deployed environment (packages/shared/src/production/productionReadiness.ts).
  return [
    { id: 'format', name: 'Formatting check', argv: ['format:check'] },
    { id: 'lint', name: 'Lint', argv: ['lint'] },
    { id: 'typecheck', name: 'Type check', argv: ['typecheck'] },
    { id: 'unit', name: 'Unit tests', argv: ['test:unit'] },
    {
      id: 'integration',
      name: 'Integration tests (local fakes and emulators only)',
      argv: ['test:integration'],
    },
    { id: 'acceptance', name: 'Acceptance suites', argv: ['test:acceptance'] },
    { id: 'security', name: 'Security tests and control report', argv: ['test:security'] },
    {
      id: 'manifest-dev',
      name: 'Teams manifest validation (development)',
      argv: ['teams:validate'],
      blocked:
        missingManifest.length === 0
          ? undefined
          : `the manifest variables are not set here: ${missingManifest.join(', ')}. Run with --env-file pointing at the environment file for this release.`,
    },
    {
      id: 'manifest-prod',
      name: 'Teams manifest validation (production)',
      argv: ['teams:validate', '--env', 'production'],
      blocked: missingManifest.length === 0 ? undefined : 'same manifest variables as above.',
    },
    {
      id: 'bicep',
      name: 'Bicep template validation',
      argv: ['infra:validate'],
      // Prompt 20 asks for this "where tooling is installed", so a missing CLI is a skip.
      skipped: hasBicep(env) ? undefined : 'no Bicep CLI (bicep, $EHUB_BICEP or az bicep).',
    },
    { id: 'secrets', name: 'Secret scan', argv: ['secrets:scan'] },
    {
      id: 'docs-config',
      name: 'Configuration reference is up to date',
      argv: ['config:reference', '--check'],
    },
    {
      id: 'production-config',
      name: 'Release configuration validation (no secrets)',
      argv: ['preflight', '--static', '--scope', 'release'],
      blocked:
        missingManifest.length === 0
          ? undefined
          : 'no release environment file was supplied, so the application settings could not be checked. Run with --env-file (docs/production-deployment.md).',
    },
    { id: 'build', name: 'Package build', argv: ['build'] },
    {
      id: 'teams-package',
      name: 'Teams app package',
      argv: ['teams:package', '--env', 'production'],
      blocked:
        missingManifest.length === 0
          ? undefined
          : 'same manifest variables as above, so the package cannot be built here.',
    },
  ];
}

function runStep(step, env) {
  if (step.blocked !== undefined) {
    return { ...step, result: 'blocked', reason: step.blocked, durationMs: 0, output: '' };
  }
  if (step.skipped !== undefined) {
    return { ...step, result: 'skipped', reason: step.skipped, durationMs: 0, output: '' };
  }
  const started = Date.now();
  const run = spawnSync(pnpm, [...step.argv], {
    cwd: root,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return {
    ...step,
    result: run.status === 0 ? 'pass' : 'fail',
    reason: undefined,
    durationMs: Date.now() - started,
    output: run.status === 0 ? '' : redactOutput(output).slice(-1500),
  };
}

function teamsPackages() {
  const directory = join(root, 'apps', 'teams-app', 'build');
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => join(directory, name));
}

/** Files a deployment is made from, with checksums so what was tested can be identified later. */
function artifacts() {
  const candidates = [
    'pnpm-lock.yaml',
    'apps/api/dist/cli.js',
    'apps/indexer/dist/cli.js',
    'apps/teams-app/dist/main.js',
    'Dockerfile',
    'infrastructure/bicep/main.bicep',
    ...teamsPackages().map((path) => relative(root, path)),
  ];
  return candidates.flatMap((path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      return [];
    }
    return [{ path, bytes: statSync(absolute).size, sha256: sha256(absolute) }];
  });
}

const KNOWN_LIMITATIONS = [
  'Grounding is mechanical: a claim that cites a real passage and reuses its words can contradict it and still pass (docs/acceptance.md).',
  'The acceptance suites use a chat model that quotes retrieved passages, so they do not predict how the deployed model phrases answers.',
  'Retrieval and answer quality against real E-Hub content are measured only by `pnpm evaluation:full` against a deployment.',
  'Rate limits and the concurrency cap are per API replica, held in memory (docs/decisions.md).',
  'Teams app icons are the placeholders unless they have been replaced (docs/teams-deployment.md).',
  'The assistant answers from indexed Moodle content only; it cannot say that Moodle itself is out of date.',
];

const MANUAL_CHECKS = [
  'Run `pnpm preflight` in the deployed environment: it is the only check that contacts Moodle, Azure AI Search, the embedding and chat deployments, the state store and the deployed index schema.',
  'Sign in to the Teams app as a pilot user, ask a question answerable from a selected course, and follow every citation link into Moodle (docs/acceptance-signoff.md).',
  'Ask a question about a course the tester is not enrolled in and confirm the refusal.',
  'Confirm the alert rules fire by resolving a test alert (docs/operations-runbook.md).',
  'Confirm a restore from the state-store backup and an application revision rollback (docs/backup-and-recovery.md, docs/rollback.md).',
  'Record the Moodle token expiry date in the environment file (MOODLE_TOKEN_EXPIRES_ON) so the preflight can warn before it lapses.',
];

export function renderMarkdown(report) {
  const mark = { pass: '✓', fail: '✗', blocked: '!', skipped: '–' };
  const lines = [
    '# Release report',
    '',
    `Generated ${report.generatedAt}, Node.js ${report.node}.`,
    '',
    `**Verdict: ${report.verdict.toUpperCase()}.**`,
    '',
    report.ready
      ? 'Every gate that can run in this repository passed. This is not a statement that the deployment works: the checks that need the live Moodle, Azure and Teams services are listed under "Manual checks still required" and must be run against the environment.'
      : 'This release is not ready. A gate failed, or a gate could not be run here and so has not passed. Both hold the release.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Version | ${report.version} |`,
    `| Source commit | \`${report.commit}\`${report.dirty ? ' (uncommitted changes present)' : ''} |`,
    `| Branch | ${report.branch} |`,
    `| Rollback commit | ${report.rollbackCommit === undefined ? 'none recorded' : `\`${report.rollbackCommit}\``} |`,
    `| Rollback tag | ${report.rollbackTag ?? 'none'} |`,
    `| Build | ${report.results.build ?? 'not run'} |`,
    `| Unit tests | ${report.results.unit ?? 'not run'} |`,
    `| Integration tests | ${report.results.integration ?? 'not run'} |`,
    `| Acceptance suites | ${report.results.acceptance ?? 'not run'} |`,
    `| Security tests | ${report.results.security ?? 'not run'} |`,
    `| Teams package | ${report.teamsPackages.length === 0 ? 'not built (run `pnpm teams:package`)' : report.teamsPackages.join(', ')} |`,
    '',
    '## Gates',
    '',
    '| Step | Result | Duration | Note |',
    '| --- | --- | --- | --- |',
    ...report.steps.map(
      (step) =>
        `| ${step.name} | ${mark[step.result]} ${step.result} | ${step.durationMs === 0 ? '—' : `${String(Math.round(step.durationMs / 1000))} s`} | ${step.reason ?? ''} |`,
    ),
    '',
  ];
  const failures = report.steps.filter((step) => step.result === 'fail');
  if (failures.length > 0) {
    lines.push('## Failures', '');
    for (const step of failures) {
      lines.push(`### ${step.name}`, '', '```', step.output.trim(), '```', '');
    }
  }
  lines.push(
    '## Known limitations',
    '',
    ...report.knownLimitations.map((entry) => `- ${entry}`),
    '',
    '## Manual checks still required',
    '',
    ...report.manualChecks.map((entry) => `- ${entry}`),
    '',
    '## Deployment artifact checksums',
    '',
    '| File | Bytes | SHA-256 |',
    '| --- | --- | --- |',
    ...report.artifacts.map(
      (artifact) => `| \`${artifact.path}\` | ${String(artifact.bytes)} | \`${artifact.sha256}\` |`,
    ),
    '',
    'Regenerate with `pnpm release:verify` (add `-- --env-file <path>` to supply the environment file for this release).',
    '',
  );
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const envFileIndex = argv.indexOf('--env-file');
  const envFile = envFileIndex === -1 ? undefined : argv[envFileIndex + 1];
  if (envFileIndex !== -1 && envFile === undefined) {
    process.stderr.write('--env-file needs a path.\n');
    process.exit(2);
  }
  if (envFile !== undefined && !existsSync(join(root, envFile)) && !existsSync(envFile)) {
    process.stderr.write(`--env-file: ${envFile} does not exist.\n`);
    process.exit(2);
  }
  const fileValues =
    envFile === undefined ? {} : readEnvFile(existsSync(envFile) ? envFile : join(root, envFile));
  const env = { ...process.env, ...fileValues, NODE_ENV: 'production' };

  const steps = buildSteps(env).map((step) => {
    const result = runStep(step, env);
    process.stdout.write(
      `${result.result === 'pass' ? '✓' : result.result === 'fail' ? '✗' : result.result === 'blocked' ? '!' : '–'} ${result.id.padEnd(18)} ${result.result}${result.reason === undefined ? '' : `: ${result.reason}`}\n`,
    );
    return result;
  });

  const summary = summarizeSteps(steps);
  const resultOf = (id) => steps.find((step) => step.id === id)?.result;
  const packages = teamsPackages().map((path) => relative(root, path));
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    commit: git(['rev-parse', '--short=12', 'HEAD']) || 'unknown',
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    dirty: git(['status', '--porcelain']) !== '',
    rollbackCommit: git(['rev-parse', '--short=12', 'HEAD^']) || undefined,
    rollbackTag: git(['describe', '--tags', '--abbrev=0', 'HEAD^']) || undefined,
    ready: summary.ready,
    verdict: summary.verdict,
    results: {
      build: resultOf('build'),
      unit: resultOf('unit'),
      integration: resultOf('integration'),
      acceptance: resultOf('acceptance'),
      security: resultOf('security'),
    },
    steps: steps.map(({ output, ...rest }) => ({ ...rest, output: output.slice(-1500) })),
    knownLimitations: KNOWN_LIMITATIONS,
    manualChecks: [
      ...MANUAL_CHECKS,
      ...steps
        .filter((step) => step.result === 'blocked' || step.result === 'skipped')
        .map((step) => `${step.name}: ${step.reason ?? 'could not run here'}`),
    ],
    teamsPackages: packages,
    artifacts: artifacts(),
  };

  const outDir = join(root, 'reports', 'release');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'release-report.md'), renderMarkdown(report));
  process.stdout.write(
    `\nRelease: ${report.verdict.toUpperCase()}. version ${report.version}, commit ${report.commit}.\n${
      report.ready
        ? 'Every gate that can run here passed. The manual checks in the report still have to be done against the deployment.\n'
        : `Not ready: ${[...summary.failed, ...summary.blocked].join(', ')}.\n`
    }Report: ${relative(root, join(outDir, 'release-report.md'))}\n`,
  );
  process.exit(report.ready ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
