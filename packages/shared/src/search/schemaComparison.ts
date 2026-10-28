import { z } from 'zod';

import {
  schemaVersionFromDescription,
  type HnswAlgorithmDefinition,
  type SearchFieldDefinition,
  type SearchIndexDefinition,
  type SemanticConfigurationDefinition,
} from './indexDefinition.js';

/*
 * Compares the definition this code expects with the one deployed. Azure AI Search can change
 * some things in place (add a field, make a field retrievable, semantic configuration, the
 * description, new vector profiles) but most attribute changes need a rebuilt index. Anything
 * not known to be safe in place is classified as incompatible.
 */

// Loose: the service returns many more properties than this code manages, and an update must
// send them back unchanged.
const deployedFieldSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  key: z.boolean().nullish(),
  searchable: z.boolean().nullish(),
  filterable: z.boolean().nullish(),
  sortable: z.boolean().nullish(),
  facetable: z.boolean().nullish(),
  retrievable: z.boolean().nullish(),
  stored: z.boolean().nullish(),
  analyzer: z.string().nullish(),
  searchAnalyzer: z.string().nullish(),
  indexAnalyzer: z.string().nullish(),
  dimensions: z.number().nullish(),
  vectorSearchProfile: z.string().nullish(),
});

const deployedAlgorithmSchema = z.looseObject({
  name: z.string(),
  kind: z.string(),
  hnswParameters: z
    .looseObject({
      m: z.number().nullish(),
      efConstruction: z.number().nullish(),
      efSearch: z.number().nullish(),
      metric: z.string().nullish(),
    })
    .nullish(),
});

const deployedSemanticConfigurationSchema = z.looseObject({
  name: z.string(),
  prioritizedFields: z.looseObject({
    titleField: z.looseObject({ fieldName: z.string() }).nullish(),
    prioritizedContentFields: z.array(z.looseObject({ fieldName: z.string() })).nullish(),
    prioritizedKeywordsFields: z.array(z.looseObject({ fieldName: z.string() })).nullish(),
  }),
});

export const deployedIndexSchema = z.looseObject({
  name: z.string(),
  description: z.string().nullish(),
  '@odata.etag': z.string().optional(),
  fields: z.array(deployedFieldSchema),
  vectorSearch: z
    .looseObject({
      algorithms: z.array(deployedAlgorithmSchema).nullish(),
      profiles: z.array(z.looseObject({ name: z.string(), algorithm: z.string() })).nullish(),
    })
    .nullish(),
  semantic: z
    .looseObject({
      defaultConfiguration: z.string().nullish(),
      configurations: z.array(deployedSemanticConfigurationSchema).nullish(),
    })
    .nullish(),
});
export type DeployedIndex = z.output<typeof deployedIndexSchema>;
type DeployedField = z.output<typeof deployedFieldSchema>;

export type DifferenceSeverity = 'compatible' | 'incompatible' | 'informational';

export interface SchemaDifference {
  readonly severity: DifferenceSeverity;
  readonly kind:
    | 'missing-field'
    | 'extra-field'
    | 'field-attribute'
    | 'vector-algorithm'
    | 'vector-profile'
    | 'semantic'
    | 'description';
  readonly field?: string;
  readonly attribute?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly detail: string;
}

export type SchemaComparisonStatus = 'match' | 'compatible-changes' | 'incompatible';

export interface SchemaComparison {
  readonly status: SchemaComparisonStatus;
  readonly deployedSchemaVersion: number | undefined;
  readonly differences: readonly SchemaDifference[];
}

const IN_PLACE_FIELD_ATTRIBUTES: ReadonlySet<string> = new Set(['retrievable']);

const show = (value: string | number | boolean | null | undefined): string =>
  value === undefined || value === null ? '(none)' : String(value);

function fieldAttributes(definition: SearchFieldDefinition | DeployedField) {
  return {
    type: definition.type,
    key: definition.key ?? false,
    searchable: definition.searchable ?? false,
    filterable: definition.filterable ?? false,
    sortable: definition.sortable ?? false,
    facetable: definition.facetable ?? false,
    retrievable: definition.retrievable ?? true,
    stored: definition.stored ?? true,
    analyzer: definition.analyzer ?? undefined,
    dimensions: definition.dimensions ?? undefined,
    vectorSearchProfile: definition.vectorSearchProfile ?? undefined,
  };
}

function compareFields(
  expected: SearchIndexDefinition,
  deployed: DeployedIndex,
  differences: SchemaDifference[],
): void {
  const deployedByName = new Map(deployed.fields.map((entry) => [entry.name, entry]));
  for (const wanted of expected.fields) {
    const actual = deployedByName.get(wanted.name);
    if (actual === undefined) {
      differences.push({
        // A new key field cannot be added; any other field can.
        severity: wanted.key ? 'incompatible' : 'compatible',
        kind: 'missing-field',
        field: wanted.name,
        detail: `Field ${wanted.name} is not in the deployed index.`,
      });
      continue;
    }
    const want = fieldAttributes(wanted);
    const have = fieldAttributes(actual);
    for (const attribute of Object.keys(want) as (keyof typeof want)[]) {
      if (want[attribute] === have[attribute]) {
        continue;
      }
      differences.push({
        severity: IN_PLACE_FIELD_ATTRIBUTES.has(attribute) ? 'compatible' : 'incompatible',
        kind: 'field-attribute',
        field: wanted.name,
        attribute,
        expected: show(want[attribute]),
        actual: show(have[attribute]),
        detail: `Field ${wanted.name}: ${attribute} is ${show(have[attribute])}, expected ${show(want[attribute])}.`,
      });
    }
    if ((actual.searchAnalyzer ?? actual.indexAnalyzer ?? undefined) !== undefined) {
      differences.push({
        severity: 'incompatible',
        kind: 'field-attribute',
        field: wanted.name,
        attribute: 'searchAnalyzer/indexAnalyzer',
        detail: `Field ${wanted.name} uses separate index and search analysers.`,
      });
    }
  }
  const expectedNames = new Set(expected.fields.map((entry) => entry.name));
  for (const actual of deployed.fields) {
    if (!expectedNames.has(actual.name)) {
      differences.push({
        severity: 'informational',
        kind: 'extra-field',
        field: actual.name,
        detail: `Field ${actual.name} is deployed but not used by this version; fields cannot be removed in place.`,
      });
    }
  }
}

function sameAlgorithm(
  wanted: HnswAlgorithmDefinition,
  actual: z.output<typeof deployedAlgorithmSchema>,
): boolean {
  const parameters = actual.hnswParameters;
  return (
    actual.kind === wanted.kind &&
    parameters?.m === wanted.hnswParameters.m &&
    parameters.efConstruction === wanted.hnswParameters.efConstruction &&
    parameters.efSearch === wanted.hnswParameters.efSearch &&
    parameters.metric === wanted.hnswParameters.metric
  );
}

function compareVectorSearch(
  expected: SearchIndexDefinition,
  deployed: DeployedIndex,
  differences: SchemaDifference[],
): void {
  const algorithms = new Map(
    (deployed.vectorSearch?.algorithms ?? []).map((entry) => [entry.name, entry]),
  );
  for (const wanted of expected.vectorSearch.algorithms) {
    const actual = algorithms.get(wanted.name);
    if (actual === undefined) {
      differences.push({
        severity: 'compatible',
        kind: 'vector-algorithm',
        detail: `Vector algorithm ${wanted.name} is not configured.`,
      });
    } else if (!sameAlgorithm(wanted, actual)) {
      differences.push({
        severity: 'incompatible',
        kind: 'vector-algorithm',
        detail: `Vector algorithm ${wanted.name} has different parameters.`,
      });
    }
  }
  const profiles = new Map(
    (deployed.vectorSearch?.profiles ?? []).map((entry) => [entry.name, entry]),
  );
  for (const wanted of expected.vectorSearch.profiles) {
    const actual = profiles.get(wanted.name);
    if (actual === undefined) {
      differences.push({
        severity: 'compatible',
        kind: 'vector-profile',
        detail: `Vector profile ${wanted.name} is not configured.`,
      });
    } else if (actual.algorithm !== wanted.algorithm) {
      differences.push({
        severity: 'incompatible',
        kind: 'vector-profile',
        detail: `Vector profile ${wanted.name} uses algorithm ${actual.algorithm}, expected ${wanted.algorithm}.`,
      });
    }
  }
}

function semanticSignature(
  configuration:
    SemanticConfigurationDefinition | z.output<typeof deployedSemanticConfigurationSchema>,
): string {
  const fields = configuration.prioritizedFields;
  return JSON.stringify([
    fields.titleField?.fieldName ?? null,
    (fields.prioritizedContentFields ?? []).map((entry) => entry.fieldName),
    (fields.prioritizedKeywordsFields ?? []).map((entry) => entry.fieldName),
  ]);
}

function compareSemantic(
  expected: SearchIndexDefinition,
  deployed: DeployedIndex,
  differences: SchemaDifference[],
): void {
  // Semantic configuration can always be changed in place, so differences are compatible.
  // When this deployment has semantic ranking switched off, a deployed configuration is left
  // alone rather than removed.
  if (expected.semantic === undefined) {
    return;
  }
  const deployedConfigurations = new Map(
    (deployed.semantic?.configurations ?? []).map((entry) => [entry.name, entry]),
  );
  for (const wanted of expected.semantic.configurations) {
    const actual = deployedConfigurations.get(wanted.name);
    if (actual === undefined || semanticSignature(actual) !== semanticSignature(wanted)) {
      differences.push({
        severity: 'compatible',
        kind: 'semantic',
        detail:
          actual === undefined
            ? `Semantic configuration ${wanted.name} is not configured.`
            : `Semantic configuration ${wanted.name} has different prioritised fields.`,
      });
    }
  }
  if (
    (deployed.semantic?.defaultConfiguration ?? undefined) !==
    expected.semantic.defaultConfiguration
  ) {
    differences.push({
      severity: 'compatible',
      kind: 'semantic',
      detail: `Default semantic configuration is ${show(deployed.semantic?.defaultConfiguration)}, expected ${expected.semantic.defaultConfiguration}.`,
    });
  }
}

export function compareIndexDefinitions(
  expected: SearchIndexDefinition,
  deployed: DeployedIndex,
): SchemaComparison {
  const differences: SchemaDifference[] = [];
  compareFields(expected, deployed, differences);
  compareVectorSearch(expected, deployed, differences);
  compareSemantic(expected, deployed, differences);
  if ((deployed.description ?? '') !== expected.description) {
    differences.push({
      severity: 'compatible',
      kind: 'description',
      detail: 'Index description (which records the schema version) differs.',
    });
  }
  const status: SchemaComparisonStatus = differences.some(
    (difference) => difference.severity === 'incompatible',
  )
    ? 'incompatible'
    : differences.some((difference) => difference.severity === 'compatible')
      ? 'compatible-changes'
      : 'match';
  return {
    status,
    deployedSchemaVersion: schemaVersionFromDescription(deployed.description ?? undefined),
    differences,
  };
}

/**
 * The body for an in-place update: the deployed definition with this version's fields,
 * vector configuration, semantic configuration and description merged in. Deployed fields and
 * settings this code does not manage are carried over unchanged, because an update that omits
 * an existing field is rejected and omitting other settings (e.g. an encryption key) would
 * remove them. Only valid when the comparison found no incompatible differences.
 */
export function buildInPlaceUpdate(
  expected: SearchIndexDefinition,
  deployed: DeployedIndex,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(deployed)) {
    if (!property.startsWith('@odata.')) {
      body[property] = value;
    }
  }
  const deployedFields = new Map(deployed.fields.map((entry) => [entry.name, entry]));
  const expectedNames = new Set(expected.fields.map((entry) => entry.name));
  body['fields'] = [
    ...expected.fields.map((wanted) => ({ ...(deployedFields.get(wanted.name) ?? {}), ...wanted })),
    ...deployed.fields.filter((entry) => !expectedNames.has(entry.name)),
  ];

  const mergeByName = <T extends { name: string }>(
    current: readonly T[] | null | undefined,
    wanted: readonly T[],
  ): T[] => {
    const wantedNames = new Set(wanted.map((entry) => entry.name));
    return [...wanted, ...(current ?? []).filter((entry) => !wantedNames.has(entry.name))];
  };
  body['vectorSearch'] = {
    ...(deployed.vectorSearch ?? {}),
    algorithms: mergeByName<{ name: string }>(
      deployed.vectorSearch?.algorithms,
      expected.vectorSearch.algorithms,
    ),
    profiles: mergeByName<{ name: string }>(
      deployed.vectorSearch?.profiles,
      expected.vectorSearch.profiles,
    ),
  };
  if (expected.semantic !== undefined) {
    body['semantic'] = {
      ...(deployed.semantic ?? {}),
      defaultConfiguration: expected.semantic.defaultConfiguration,
      configurations: mergeByName<{ name: string }>(
        deployed.semantic?.configurations,
        expected.semantic.configurations,
      ),
    };
  }
  body['description'] = expected.description;
  body['name'] = expected.name;
  return body;
}
