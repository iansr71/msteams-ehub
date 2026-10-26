import { readFileSync } from 'node:fs';

import { z } from 'zod';

const packageJsonSchema = z.object({ version: z.string().min(1) });

/**
 * Reads `version` from a package.json, returning `unknown` if it cannot be read. Callers pass
 * a URL relative to `import.meta.url`; src/ and dist/ mirror each other, so the same relative
 * path works for source runs and builds.
 */
export function readPackageVersion(packageJsonUrl: URL): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
    return packageJsonSchema.parse(raw).version;
  } catch {
    return 'unknown';
  }
}
