import { describe, expect, it } from 'vitest';

import { sanitizeServiceMessage } from './errors.js';
import {
  RETRIEVABLE_FIELD_NAMES,
  SEARCH_SCHEMA_VERSION,
  buildIndexDefinition,
  schemaVersionFromDescription,
  type SearchIndexDefinition,
} from './indexDefinition.js';
import {
  InvalidFilterValueError,
  MissingPrincipalsError,
  buildCourseFilter,
  buildPrincipalFilter,
  buildScopeFilter,
  buildStringInFilter,
  buildTenantFilter,
  odataString,
} from './odata.js';
import {
  buildInPlaceUpdate,
  compareIndexDefinitions,
  deployedIndexSchema,
  type DeployedIndex,
} from './schemaComparison.js';

const definition = buildIndexDefinition({
  indexName: 'ehub-course-content-v1',
  vectorDimensions: 1536,
  semanticEnabled: true,
});

const REQUIRED_FIELDS = [
  'id',
  'tenantId',
  'courseId',
  'courseName',
  'courseCategory',
  'sectionId',
  'sectionName',
  'moduleId',
  'moduleName',
  'resourceId',
  'resourceName',
  'resourceType',
  'fileName',
  'mimeType',
  'title',
  'headingPath',
  'content',
  'contentVector',
  'sourceUrl',
  'pageNumber',
  'slideNumber',
  'chunkNumber',
  'contentHash',
  'modifiedAt',
  'indexedAt',
  'extractorVersion',
  'chunkerVersion',
  'allowedUserIds',
  'allowedGroupIds',
  'isActive',
];

const fieldNamed = (index: SearchIndexDefinition, name: string) => {
  const found = index.fields.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`missing ${name}`);
  }
  return found;
};

/** What GET /indexes/{name} returns for an index created from `index`: every attribute filled. */
function asDeployed(
  index: SearchIndexDefinition,
  extra: Record<string, unknown> = {},
): DeployedIndex {
  return deployedIndexSchema.parse(
    JSON.parse(
      JSON.stringify({
        '@odata.etag': '"0x1"',
        ...index,
        fields: index.fields.map((entry) => ({
          analyzer: null,
          searchAnalyzer: null,
          indexAnalyzer: null,
          dimensions: null,
          vectorSearchProfile: null,
          synonymMaps: [],
          ...entry,
        })),
        ...extra,
      }),
    ),
  );
}

function withField(
  index: SearchIndexDefinition,
  name: string,
  change: Record<string, unknown>,
): SearchIndexDefinition {
  return {
    ...index,
    fields: index.fields.map((entry) => (entry.name === name ? { ...entry, ...change } : entry)),
  };
}

describe('buildIndexDefinition', () => {
  it('contains every field the specification lists, with a single key', () => {
    const names = definition.fields.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(REQUIRED_FIELDS));
    expect(new Set(names).size).toBe(names.length);
    expect(definition.fields.filter((entry) => entry.key).map((entry) => entry.name)).toEqual([
      'id',
    ]);
  });

  it('states every attribute explicitly so service defaults never apply', () => {
    for (const entry of definition.fields) {
      for (const attribute of [
        'key',
        'searchable',
        'filterable',
        'sortable',
        'facetable',
        'retrievable',
        'stored',
      ] as const) {
        expect(typeof entry[attribute], `${entry.name}.${attribute}`).toBe('boolean');
      }
      if (entry.type.startsWith('Collection(')) {
        expect(entry.sortable, entry.name).toBe(false);
      }
      if (entry.analyzer !== undefined) {
        expect(entry.searchable, entry.name).toBe(true);
      }
    }
  });

  it('keeps access lists filterable but never retrievable', () => {
    for (const name of ['allowedUserIds', 'allowedGroupIds']) {
      expect(fieldNamed(definition, name)).toMatchObject({
        type: 'Collection(Edm.String)',
        filterable: true,
        retrievable: false,
        searchable: false,
      });
    }
    expect(RETRIEVABLE_FIELD_NAMES).not.toContain('allowedUserIds');
    expect(RETRIEVABLE_FIELD_NAMES).not.toContain('allowedGroupIds');
    expect(RETRIEVABLE_FIELD_NAMES).not.toContain('contentVector');
  });

  it('defines the vector field, HNSW profile and semantic configuration', () => {
    expect(fieldNamed(definition, 'contentVector')).toMatchObject({
      type: 'Collection(Edm.Single)',
      searchable: true,
      filterable: false,
      facetable: false,
      retrievable: false,
      stored: false,
      dimensions: 1536,
      vectorSearchProfile: 'ehub-vector-profile',
    });
    expect(definition.vectorSearch.profiles).toEqual([
      { name: 'ehub-vector-profile', algorithm: 'ehub-hnsw' },
    ]);
    expect(definition.vectorSearch.algorithms[0]?.hnswParameters.metric).toBe('cosine');
    expect(definition.semantic?.configurations[0]?.prioritizedFields.titleField).toEqual({
      fieldName: 'title',
    });
  });

  it('makes the fields used for deletion and filtering filterable', () => {
    for (const name of ['tenantId', 'courseId', 'resourceId', 'isActive', 'sourceContentHash']) {
      expect(fieldNamed(definition, name).filterable, name).toBe(true);
    }
    expect(fieldNamed(definition, 'id')).toMatchObject({ filterable: true, sortable: true });
  });

  it('honours configured dimensions and the semantic switch', () => {
    const small = buildIndexDefinition({
      indexName: 'x1',
      vectorDimensions: 3072,
      semanticEnabled: false,
    });
    expect(fieldNamed(small, 'contentVector').dimensions).toBe(3072);
    expect(small.semantic).toBeUndefined();
    expect(() =>
      buildIndexDefinition({ indexName: 'x1', vectorDimensions: 0, semanticEnabled: true }),
    ).toThrow(RangeError);
  });

  it('records the schema version in the description', () => {
    expect(schemaVersionFromDescription(definition.description)).toBe(SEARCH_SCHEMA_VERSION);
    expect(schemaVersionFromDescription(undefined)).toBeUndefined();
    expect(schemaVersionFromDescription('no version here')).toBeUndefined();
  });
});

describe('compareIndexDefinitions', () => {
  it('matches a deployed index created from the same definition', () => {
    const result = compareIndexDefinitions(definition, asDeployed(definition));
    expect(result).toEqual({
      status: 'match',
      deployedSchemaVersion: SEARCH_SCHEMA_VERSION,
      differences: [],
    });
  });

  it('treats a missing non-key field as a compatible change', () => {
    const deployed = asDeployed({
      ...definition,
      fields: definition.fields.filter((entry) => entry.name !== 'tokenCount'),
    });
    const result = compareIndexDefinitions(definition, deployed);
    expect(result.status).toBe('compatible-changes');
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: 'missing-field',
        field: 'tokenCount',
        severity: 'compatible',
      }),
    ]);
  });

  it.each([
    ['type', { type: 'Edm.Int64' }],
    ['filterable', { filterable: false }],
    ['searchable', { searchable: false }],
    ['analyzer', { analyzer: 'standard.lucene' }],
    ['stored', { stored: true }],
  ])('treats a change to %s as incompatible', (attribute, change) => {
    const field = attribute === 'stored' ? 'contentVector' : 'courseName';
    const result = compareIndexDefinitions(
      definition,
      asDeployed(withField(definition, field, change)),
    );
    expect(result.status).toBe('incompatible');
    expect(result.differences).toContainEqual(
      expect.objectContaining({ field, attribute, severity: 'incompatible' }),
    );
  });

  it('treats different vector dimensions as incompatible', () => {
    const deployed = asDeployed(withField(definition, 'contentVector', { dimensions: 3072 }));
    const result = compareIndexDefinitions(definition, deployed);
    expect(result.status).toBe('incompatible');
    expect(result.differences).toContainEqual(
      expect.objectContaining({ attribute: 'dimensions', expected: '1536', actual: '3072' }),
    );
  });

  it('treats retrievable, semantic and description changes as compatible', () => {
    const deployed = asDeployed(
      {
        ...withField(definition, 'sourceUrl', { retrievable: false }),
        description: 'older',
      },
      { semantic: null },
    );
    const result = compareIndexDefinitions(definition, deployed);
    expect(result.status).toBe('compatible-changes');
    expect(result.deployedSchemaVersion).toBeUndefined();
    expect(result.differences.map((difference) => difference.kind).sort()).toEqual([
      'description',
      'field-attribute',
      'semantic',
      'semantic',
    ]);
  });

  it('reports deployed fields this version does not use without failing', () => {
    const deployed = asDeployed({
      ...definition,
      fields: [...definition.fields, { ...fieldNamed(definition, 'title'), name: 'legacyField' }],
    });
    const result = compareIndexDefinitions(definition, deployed);
    expect(result.status).toBe('match');
    expect(result.differences).toEqual([
      expect.objectContaining({
        kind: 'extra-field',
        field: 'legacyField',
        severity: 'informational',
      }),
    ]);
  });

  it('treats changed HNSW parameters as incompatible and a missing profile as compatible', () => {
    const changed = asDeployed({
      ...definition,
      vectorSearch: {
        ...definition.vectorSearch,
        algorithms: [
          {
            name: 'ehub-hnsw',
            kind: 'hnsw',
            hnswParameters: { m: 8, efConstruction: 400, efSearch: 500, metric: 'cosine' },
          },
        ],
      },
    });
    expect(compareIndexDefinitions(definition, changed).status).toBe('incompatible');
    const missingProfile = asDeployed({
      ...definition,
      vectorSearch: { ...definition.vectorSearch, profiles: [] },
    });
    expect(compareIndexDefinitions(definition, missingProfile).status).toBe('compatible-changes');
  });

  it('does not ask to remove semantic configuration when semantic ranking is off', () => {
    const noSemantic = buildIndexDefinition({
      indexName: 'ehub-course-content-v1',
      vectorDimensions: 1536,
      semanticEnabled: false,
    });
    const deployed = asDeployed(definition);
    expect(compareIndexDefinitions(noSemantic, deployed).status).toBe('match');
  });
});

describe('buildInPlaceUpdate', () => {
  it('keeps deployed fields and settings this code does not manage, and drops OData metadata', () => {
    const deployed = asDeployed(
      {
        ...definition,
        fields: [
          ...definition.fields.filter((entry) => entry.name !== 'tokenCount'),
          { ...fieldNamed(definition, 'title'), name: 'legacyField' },
        ],
        description: 'old',
      },
      {
        encryptionKey: { keyVaultKeyName: 'k', keyVaultUri: 'https://kv.example.test' },
        scoringProfiles: [{ name: 'custom' }],
      },
    );
    const update = buildInPlaceUpdate(definition, deployed);
    const fields = update['fields'] as { name: string }[];
    expect(fields.map((entry) => entry.name)).toEqual([
      ...definition.fields.map((entry) => entry.name),
      'legacyField',
    ]);
    expect(update['encryptionKey']).toEqual({
      keyVaultKeyName: 'k',
      keyVaultUri: 'https://kv.example.test',
    });
    expect(update['scoringProfiles']).toEqual([{ name: 'custom' }]);
    expect(update['description']).toBe(definition.description);
    expect(Object.keys(update).some((key) => key.startsWith('@odata.'))).toBe(false);
  });
});

describe('OData filters', () => {
  it('escapes single quotes in string literals', () => {
    expect(odataString("O'Brien's")).toBe("'O''Brien''s'");
  });

  it('cannot be broken out of by a hostile resource ID', () => {
    const filter = buildScopeFilter({
      tenantId: 'tenant-1',
      courseId: 12,
      resourceId: "701:file:/x' or tenantId ne 'none",
    });
    expect(filter).toBe(
      "tenantId eq 'tenant-1' and courseId eq 12 and resourceId eq '701:file:/x'' or tenantId ne ''none'",
    );
  });

  it('builds tenant, course and principal clauses from validated values', () => {
    expect(buildTenantFilter('tenant-1')).toBe("tenantId eq 'tenant-1' and isActive eq true");
    expect(buildCourseFilter([12, 13, 12])).toBe('(courseId eq 12 or courseId eq 13)');
    expect(buildPrincipalFilter({ userIds: ['u-1'], groupIds: ['g-1', 'g-2'] })).toBe(
      "(allowedUserIds/any(v: search.in(v, 'u-1', ',')) or allowedGroupIds/any(v: search.in(v, 'g-1,g-2', ',')))",
    );
  });

  it('rejects values that could alter a filter', () => {
    expect(() => buildPrincipalFilter({ userIds: [], groupIds: [] })).toThrow(
      MissingPrincipalsError,
    );
    for (const bad of ['a,b', "a'b", 'a b', '', 'x)']) {
      expect(() => buildPrincipalFilter({ userIds: [bad], groupIds: [] })).toThrow(
        InvalidFilterValueError,
      );
    }
    expect(() => buildTenantFilter("t' or '1")).toThrow(InvalidFilterValueError);
    for (const bad of [
      [],
      [0],
      [-1],
      [1.5],
      [Number.NaN],
      Array.from({ length: 1001 }, (_, i) => i + 1),
    ]) {
      expect(() => buildCourseFilter(bad)).toThrow(InvalidFilterValueError);
    }
    const allowed = new Set(['pdf', 'docx']);
    expect(buildStringInFilter('resourceType', ['pdf', 'docx'], allowed)).toBe(
      "search.in(resourceType, 'pdf,docx', ',')",
    );
    for (const bad of [[], ["pdf') or true or ('"], ['pdf,docx'], ['PDF']]) {
      expect(() => buildStringInFilter('resourceType', bad, allowed)).toThrow(
        InvalidFilterValueError,
      );
    }
    expect(() => buildScopeFilter({ tenantId: 'tenant-1', courseId: 12, resourceId: '' })).toThrow(
      InvalidFilterValueError,
    );
  });
});

describe('sanitizeServiceMessage', () => {
  it('removes quoted values, control characters and secrets, and bounds the length', () => {
    const message = sanitizeServiceMessage(
      "Document 'Patient Jane Doe, 0821234567' failed.\u0000 Bearer abc.def.ghi " + 'x'.repeat(400),
    );
    expect(message).not.toContain('Jane');
    expect(message).not.toContain('\u0000');
    expect(message).not.toContain('abc.def.ghi');
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('keeps quoted identifiers only when asked', () => {
    const text = "The field 'contentVector' has an invalid value 'Botox'.";
    expect(sanitizeServiceMessage(text)).toBe(
      "The field '[value]' has an invalid value '[value]'.",
    );
    expect(sanitizeServiceMessage(text, { keepQuotedIdentifiers: true })).toBe(
      "The field 'contentVector' has an invalid value 'Botox'.",
    );
  });
});
