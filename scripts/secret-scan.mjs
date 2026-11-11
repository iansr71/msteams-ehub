// Scans the repository's files for committed secrets (`pnpm secrets:scan`).
//
// Two kinds of rule:
// - "format" rules match credentials whose shape is unmistakable (private keys, cloud and
//   source-host tokens, storage keys). They apply to every file, tests included.
// - "assignment" rules match a secret setting given a real-looking value (MOODLE_TOKEN=...,
//   "clientSecret": "..."). They skip tests and fixtures, which use fake values by design, and
//   skip values that are plainly placeholders.
//
// It reads the files git tracks plus untracked files that are not ignored, so a secret is caught
// before it is committed. This is a safety net, not a guarantee: a secret with no recognisable
// shape or name is not detected. .gitleaks.toml configures the same idea for gitleaks.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const FORMAT_RULES = [
  { id: 'private-key', pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  {
    id: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'azure-storage-key', pattern: /AccountKey=[A-Za-z0-9+/]{60,}={0,2}/ },
  { id: 'azure-sas-signature', pattern: /[?&]sig=[A-Za-z0-9%+/]{30,}(?:%3D|=)/ },
  {
    id: 'application-insights-key',
    // A real instrumentation key; all-zero and example GUIDs are placeholders.
    pattern:
      /InstrumentationKey=(?!0{8}-0{4}-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  },
];

const SECRET_SETTINGS = [
  'MOODLE_TOKEN',
  'AZURE_SEARCH_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_CLIENT_SECRET',
  'TEAMS_BOT_CLIENT_SECRET',
  'APPLICATIONINSIGHTS_CONNECTION_STRING',
];

// NAME=value, NAME: value, "name": "value" for the settings above and common secret names.
const ASSIGNMENT = new RegExp(
  String.raw`(?:\b(?:${SECRET_SETTINGS.join('|')})\b|["']?\b(?:client[_-]?secret|api[_-]?key|password|passwd|wstoken)\b["']?)` +
    String.raw`\s*[:=]\s*["'\`]?([^\s"'\`,;)}\]]{12,})`,
  'gi',
);

/** Values that are obviously not secrets: placeholders, references and fakes. */
const PLACEHOLDER =
  /^(?:<|\$|\{|%|\.\.\.|x{4,}|\*{3,})|fake|example|placeholder|dummy|changeme|your[-_]|redacted|from-key-vault|not-a-|test|sample|secretref|keyvault|process\.env|options\.|config\.|settings\.|env\[|readEnvironmentVariable/i;

const TEST_PATH =
  /(?:^|\/)(?:tests|__fixtures__|fixtures)\/|\.test\.[cm]?[jt]s$|(?:^|\/)scripts\/secret-scan\.mjs$/;
const BINARY_PATH = /\.(?:png|jpg|jpeg|gif|ico|pdf|docx|pptx|xlsx|zip|woff2?|ttf)$/i;

/** Tracked file names that should never be committed, whatever they contain. */
const FORBIDDEN_FILE =
  /(?:^|\/)\.env(?:\.(?!example$)[^/]*)?$|\.(?:pem|pfx|p12|key)$|(?:^|\/)id_(?:rsa|ed25519)$/;

function looksRandom(value) {
  // Real secrets mix character classes; prose and identifiers mostly do not.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((c) => c.test(value)).length;
  return (
    /^[0-9a-f]{32,}$/i.test(value) || (classes >= 3 && value.length >= 16) || value.length >= 40
  );
}

/** Findings for one file: { path, line, rule }. Never includes the matched value. */
export function scanText(path, text) {
  const findings = [];
  if (FORBIDDEN_FILE.test(path)) {
    findings.push({ path, line: 0, rule: 'forbidden-file' });
  }
  const isTest = TEST_PATH.test(path);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of FORMAT_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.id });
      }
    }
    if (isTest) {
      return;
    }
    for (const match of line.matchAll(ASSIGNMENT)) {
      const value = match[1] ?? '';
      if (!PLACEHOLDER.test(value) && looksRandom(value)) {
        findings.push({ path, line: index + 1, rule: 'secret-assignment' });
      }
    }
  });
  return findings;
}

function repositoryFiles(root) {
  const list = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\0')
      .filter((name) => name !== '');
  return [
    ...new Set([
      ...list(['ls-files', '-z']),
      ...list(['ls-files', '-z', '--others', '--exclude-standard']),
    ]),
  ];
}

export function scanRepository(root) {
  const findings = [];
  let scanned = 0;
  for (const path of repositoryFiles(root)) {
    const full = join(root, path);
    let size;
    try {
      size = statSync(full).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (BINARY_PATH.test(path) || size > MAX_FILE_BYTES) {
      findings.push(...scanText(path, ''));
      continue;
    }
    findings.push(...scanText(path, readFileSync(full, 'utf8')));
    scanned += 1;
  }
  return { findings, scanned };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { findings, scanned } = scanRepository(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.path}:${String(finding.line)}: ${finding.rule}\n`);
    }
    process.stderr.write(
      `Secret scan failed: ${String(findings.length)} finding(s). Remove the value, rotate the credential if it was real, and keep secrets in Key Vault or an untracked .env file.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`Secret scan passed: ${String(scanned)} files, no findings.\n`);
}
