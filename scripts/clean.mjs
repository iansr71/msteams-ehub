// Cross-platform removal of build output. Usage: node scripts/clean.mjs <path> [path...]
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node scripts/clean.mjs <path> [path...]');
  process.exit(1);
}

for (const target of targets) {
  rmSync(resolve(process.cwd(), target), { recursive: true, force: true });
}
