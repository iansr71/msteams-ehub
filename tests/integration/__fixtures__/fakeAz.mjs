// A stand-in for the Azure CLI, for testing the deployment scripts without Azure.
//
// FAKE_AZ_SCENARIO: JSON file with { "rules": [ { "args": [...], "responses": [ { "stdout",
//   "stderr", "exit" } ] } ] }. A rule matches when every string in `args` appears, in order,
//   among the call's arguments. The first matching rule answers; its responses are used in turn
//   and the last one repeats. No match: exit 0, no output.
// FAKE_AZ_LOG: every call is appended as one JSON line { args, env } (selected EHUB_ variables).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenarioFile = process.env.FAKE_AZ_SCENARIO;
const logFile = process.env.FAKE_AZ_LOG;

appendFileSync(
  logFile,
  `${JSON.stringify({
    args,
    env: {
      EHUB_DEPLOY_APPS: process.env.EHUB_DEPLOY_APPS ?? null,
      EHUB_IMAGE_TAG: process.env.EHUB_IMAGE_TAG ?? null,
    },
  })}\n`,
);

function matches(ruleArgs) {
  let position = 0;
  for (const expected of ruleArgs) {
    const found = args.indexOf(expected, position);
    if (found === -1) return false;
    position = found + 1;
  }
  return true;
}

const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const index = scenario.rules.findIndex((rule) => matches(rule.args));
if (index === -1) process.exit(0);

const counterFile = `${scenarioFile}.${String(index)}.count`;
const used = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
writeFileSync(counterFile, String(used + 1));
const responses = scenario.rules[index].responses;
const response = responses[Math.min(used, responses.length - 1)];
if (response.stdin === true) {
  // Lets a test check what the script passed on stdin (nothing secret is expected there).
  readFileSync(0);
}
if (response.stdout !== undefined) process.stdout.write(`${response.stdout}\n`);
if (response.stderr !== undefined) process.stderr.write(`${response.stderr}\n`);
process.exit(response.exit ?? 0);
