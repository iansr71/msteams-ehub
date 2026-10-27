import { posix } from 'node:path';

import type { Deadline } from './deadline.js';
import { ExtractionFailure } from './errors.js';
import { isSafeEntryName, type SafeZip } from './safeZip.js';
import type { ExtractionLimits } from './types.js';
import { decodeXmlBytes, parseXml } from './xml.js';

export interface Relationship {
  readonly id: string;
  readonly type: string;
  /** Package part name resolved against the source part, e.g. `ppt/slides/slide1.xml`. */
  readonly target: string;
}

/**
 * Resolves a relationship target to a part name inside the package. Returns undefined for
 * targets that are external, escape the package root, or are otherwise unsafe.
 */
export function resolvePartName(sourcePart: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return undefined;
  }
  const withoutFragment = target.split('#')[0] ?? '';
  const joined = withoutFragment.startsWith('/')
    ? withoutFragment.slice(1)
    : posix.join(posix.dirname(sourcePart), withoutFragment);
  const normalized = posix.normalize(joined);
  if (normalized.startsWith('../') || normalized === '..' || !isSafeEntryName(normalized)) {
    return undefined;
  }
  return normalized;
}

export function relationshipsPartFor(part: string): string {
  return posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
}

export interface PackageContext {
  readonly zip: SafeZip;
  readonly limits: ExtractionLimits;
  readonly deadline: Deadline;
}

export async function readXmlPart(context: PackageContext, part: string): Promise<string> {
  return decodeXmlBytes(await context.zip.read(part));
}

/** Reads a part's relationships. External targets (TargetMode="External") are never followed. */
export async function readRelationships(
  context: PackageContext,
  part: string,
): Promise<Relationship[]> {
  const relsPart = relationshipsPartFor(part);
  if (!context.zip.has(relsPart)) {
    return [];
  }
  const relationships: Relationship[] = [];
  parseXml(
    await readXmlPart(context, relsPart),
    {
      open: (element) => {
        if (element.name !== 'Relationship' || element.attributes['TargetMode'] === 'External') {
          return;
        }
        const id = element.attributes['Id'];
        const type = element.attributes['Type'];
        const target = element.attributes['Target'];
        if (id === undefined || type === undefined || target === undefined) {
          return;
        }
        const resolved = resolvePartName(part, target);
        if (resolved !== undefined) {
          relationships.push({ id, type, target: resolved });
        }
      },
    },
    { maxDepth: context.limits.maxXmlDepth, deadline: context.deadline },
  );
  return relationships;
}

/** Finds the package's main document part from `_rels/.rels`, falling back to the convention. */
export async function findMainPart(context: PackageContext, fallback: string): Promise<string> {
  const root = await readRelationships(context, '');
  const main = root.find((relationship) => relationship.type.endsWith('/officeDocument'));
  const part = main?.target ?? fallback;
  if (!context.zip.has(part)) {
    throw new ExtractionFailure('corrupt', 'Document main part is missing.');
  }
  return part;
}
