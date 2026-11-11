// Lints and builds the Bicep templates and parameter files (`pnpm infra:validate`).
//
// - Every .bicep file is linted with infrastructure/bicep/bicepconfig.json; any warning fails.
// - main.bicep is compiled to ARM JSON.
// - Every .bicepparam file (in parameters/) is built for both stages with clearly fake values, so the files are
//   checked without real tenant data.
//
// The Bicep CLI is found as `bicep` on PATH, $EHUB_BICEP, or `az bicep`. Without it the check is
// reported as skipped and exits 0, unless --require-bicep is given.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// --dir <path> validates another template folder (tests use it to check that warnings fail).
const dirFlag = process.argv.indexOf('--dir');
const bicepDir =
  dirFlag > -1 && process.argv[dirFlag + 1] !== undefined
    ? process.argv[dirFlag + 1]
    : join(root, 'infrastructure', 'bicep');
const requireBicep = process.argv.includes('--require-bicep');

/** Placeholder values: syntactically valid, obviously not real. */
export const PLACEHOLDER_ENV = {
  EHUB_NAME_PREFIX: 'ehub',
  EHUB_OPENAI_ACCOUNT_NAME: 'placeholder-openai',
  EHUB_OPENAI_RESOURCE_GROUP: 'placeholder-rg',
  EHUB_OPENAI_ENDPOINT: 'https://placeholder-openai.openai.azure.com',
  EHUB_OPENAI_CHAT_DEPLOYMENT: 'chat',
  EHUB_OPENAI_EMBEDDING_DEPLOYMENT: 'embedding',
  EHUB_EMBEDDING_DIMENSIONS: '1536',
  EHUB_MOODLE_BASE_URL: 'https://ehub.example.com',
  EHUB_SYNC_COURSE_IDS: '12',
  EHUB_ENTRA_API_CLIENT_ID: '00000000-0000-0000-0000-000000000001',
  EHUB_BOT_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
  EHUB_ADMIN_SPA_CLIENT_ID: '00000000-0000-0000-0000-000000000003',
};

function candidates() {
  const list = [];
  if (process.env.EHUB_BICEP) list.push([process.env.EHUB_BICEP]);
  list.push(['bicep'], ['az', 'bicep']);
  return list;
}

function findBicep() {
  for (const command of candidates()) {
    const result = spawnSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8' });
    if (result.status === 0) return command;
  }
  return undefined;
}

function run(command, args, env = process.env) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: bicepDir,
    encoding: 'utf8',
    env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Bicep reports warnings on stderr with exit code 0; any diagnostic fails this check.
  const diagnostics = output
    .split('\n')
    .filter((line) => /: (Warning|Error) [A-Z]+[0-9]*:/.test(line) || /^Error /.test(line));
  return { ok: result.status === 0 && diagnostics.length === 0, diagnostics, output };
}

function bicepFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return bicepFiles(path);
    return entry.name.endsWith('.bicep') ? [path] : [];
  });
}

function main() {
  const bicep = findBicep();
  if (bicep === undefined) {
    const message =
      'Bicep validation skipped: the Bicep CLI is not installed (bicep, $EHUB_BICEP or az bicep).';
    process.stderr.write(`${message}\n`);
    process.exit(requireBicep ? 1 : 0);
  }
  const version = spawnSync(bicep[0], [...bicep.slice(1), '--version'], { encoding: 'utf8' });
  process.stdout.write(`${version.stdout.trim()}\n`);

  const failures = [];
  for (const file of bicepFiles(bicepDir)) {
    const name = relative(bicepDir, file);
    const lint = run(bicep, ['lint', file]);
    if (!lint.ok)
      failures.push({ name: `lint ${name}`, detail: lint.diagnostics.join('\n') || lint.output });
  }
  const build = run(bicep, ['build', join(bicepDir, 'main.bicep'), '--stdout']);
  if (!build.ok)
    failures.push({
      name: 'build main.bicep',
      detail: build.diagnostics.join('\n') || build.output,
    });

  const parameterDir = join(bicepDir, 'parameters');
  const parameterFiles = existsSync(parameterDir)
    ? readdirSync(parameterDir).filter((name) => name.endsWith('.bicepparam'))
    : [];
  for (const file of parameterFiles) {
    for (const deployApps of ['false', 'true']) {
      const env = {
        ...process.env,
        ...PLACEHOLDER_ENV,
        EHUB_DEPLOY_APPS: deployApps,
        EHUB_IMAGE_TAG: deployApps === 'true' ? 'validate' : '',
      };
      const result = run(bicep, ['build-params', join(parameterDir, file), '--stdout'], env);
      if (!result.ok) {
        failures.push({
          name: `build-params ${file} (deployApps=${deployApps})`,
          detail: result.diagnostics.join('\n') || result.output,
        });
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`✗ ${failure.name}\n${failure.detail.replaceAll(bicepDir, '.')}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('Bicep templates and parameter files are valid.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
