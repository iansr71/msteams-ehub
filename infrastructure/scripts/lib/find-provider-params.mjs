// Reads `az bot authsetting list-providers --provider-name Aadv2 -o json` on stdin and prints the
// provider's parameter keys for the tenant ID and the token exchange URL, one per line.
//
// The Azure Bot templates do not document these keys, so they are read from the service at run
// time instead of being hard-coded. Any object with a string `name` (or `key`) property anywhere
// in the response counts as a candidate parameter.
import { readFileSync } from 'node:fs';

function collectNames(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
  } else if (value !== null && typeof value === 'object') {
    for (const field of ['name', 'key']) {
      if (typeof value[field] === 'string') names.add(value[field]);
    }
    for (const child of Object.values(value)) collectNames(child, names);
  }
  return names;
}

export function findProviderParameters(json) {
  const names = [...collectNames(json, new Set())];
  const tenant = names.find((name) => /^tenant[_-]?id$/i.test(name));
  const exchange = names.find((name) => /^token[_-]?exchange[_-]?url$/i.test(name));
  return { tenant, exchange };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('The provider list is not valid JSON.\n');
    process.exit(1);
  }
  const { tenant, exchange } = findProviderParameters(parsed);
  if (tenant === undefined || exchange === undefined) {
    process.stderr.write(
      'Could not find the tenant ID and token exchange URL parameters for Azure Active Directory v2.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${tenant}\n${exchange}\n`);
}
