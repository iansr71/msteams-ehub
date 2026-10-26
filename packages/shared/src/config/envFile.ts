import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LocalEnvFileResult {
  readonly loaded: boolean;
  readonly path?: string;
  readonly reason?: 'production' | 'not-found';
}

/** Walks up from `startDirectory` to the directory containing pnpm-workspace.yaml. */
export function findWorkspaceRoot(startDirectory: string): string | undefined {
  let current = startDirectory;
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Developer convenience: loads `<workspace root>/.env` into `process.env` when present.
 * Variables already set in the environment take precedence, and nothing is loaded when
 * NODE_ENV is `production` — deployed environments get configuration from Key Vault
 * references and app settings only.
 */
export function loadLocalEnvFile(startDirectory: string = process.cwd()): LocalEnvFileResult {
  if (process.env['NODE_ENV'] === 'production') {
    return { loaded: false, reason: 'production' };
  }
  const root = findWorkspaceRoot(startDirectory);
  const path = root === undefined ? undefined : join(root, '.env');
  if (path === undefined || !existsSync(path)) {
    return { loaded: false, reason: 'not-found' };
  }
  process.loadEnvFile(path);
  return { loaded: true, path };
}
