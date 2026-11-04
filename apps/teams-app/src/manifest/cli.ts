#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadLocalEnvFile, parseCommandArgs, UsageError } from '@ehub/shared';
import { z } from 'zod';

import {
  MANIFEST_ENVIRONMENTS,
  PRODUCTION_PACKAGE_BLOCKED,
  defaultPaths,
  validateManifest,
  type ValidationResult,
} from './manifestTool.js';
import { buildPackage, writePackage } from './packageApp.js';
import { placeholderColorIcon, placeholderOutlineIcon } from './placeholderIcons.js';

/*
 * pnpm teams:validate [--env development|production] [--json]
 * pnpm teams:package  [--env development]
 * pnpm --filter @ehub/teams-app run manifest icons   (regenerate the placeholder icons)
 */

loadLocalEnvFile();

const args = z
  .object({
    env: z.enum(MANIFEST_ENVIRONMENTS).default('development'),
    json: z.boolean().optional(),
  })
  .strict();

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

function report(result: ValidationResult): void {
  write(
    `Teams manifest (${result.environment}): ${result.errors.length === 0 ? 'valid' : `${String(result.errors.length)} problem(s)`}`,
  );
  for (const error of result.errors) {
    write(`  ✗ ${error}`);
  }
  for (const warning of result.warnings) {
    write(`  ! ${warning}`);
  }
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === 'icons') {
    const { manifestDir } = defaultPaths();
    writeFileSync(join(manifestDir, 'color.png'), placeholderColorIcon());
    writeFileSync(join(manifestDir, 'outline.png'), placeholderOutlineIcon());
    write('Placeholder icons written to apps/teams-app/manifest/.');
    return 0;
  }
  if (command !== 'validate' && command !== 'package') {
    write('Usage: manifest <validate|package|icons> [--env development|production] [--json]');
    return 2;
  }
  const options = parseCommandArgs(rest, { env: 'string', json: 'boolean' }, args);
  if (command === 'package' && options.env === 'production') {
    write(PRODUCTION_PACKAGE_BLOCKED);
    return 1;
  }
  const result = validateManifest({ environment: options.env, env: process.env });
  if (options.json === true) {
    write(
      JSON.stringify(
        { environment: result.environment, errors: result.errors, warnings: result.warnings },
        null,
        2,
      ),
    );
  } else {
    report(result);
  }
  if (result.errors.length > 0 || result.files === undefined) {
    return 1;
  }
  if (command === 'package') {
    const version = (JSON.parse(result.files.manifestJson) as { version: string }).version;
    const path = writePackage(
      join(defaultPaths().manifestDir, '..', 'build'),
      `ehub-assistant-${options.env}-${version}.zip`,
      buildPackage(result.files),
    );
    write(`Package written: ${path}`);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  write(error instanceof UsageError ? error.message : 'The manifest tool failed.');
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
