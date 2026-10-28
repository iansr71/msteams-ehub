/*
 * The E-Hub course-content index, expressed as the Azure AI Search REST payload
 * (api-version 2026-04-01). Every attribute is stated explicitly: the service's defaults make
 * string fields searchable, filterable, sortable and facetable, which would silently enlarge the
 * index and make later schema comparisons ambiguous.
 */

export const SEARCH_API_VERSION = '2026-04-01';

/**
 * Bumped whenever the definition below changes. Recorded in the index description so the
 * deployed version can be read back. A bump that changes an attribute Azure cannot change in
 * place also needs a new index name (see docs/search-index.md).
 */
export const SEARCH_SCHEMA_VERSION = 1;

export const VECTOR_FIELD_NAME = 'contentVector';
export const VECTOR_PROFILE_NAME = 'ehub-vector-profile';
export const VECTOR_ALGORITHM_NAME = 'ehub-hnsw';
export const SEMANTIC_CONFIGURATION_NAME = 'ehub-semantic';
export const TEXT_ANALYZER = 'en.microsoft';

export const SEARCH_FIELD_TYPES = [
  'Edm.String',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Double',
  'Edm.Boolean',
  'Edm.DateTimeOffset',
  'Collection(Edm.String)',
  'Collection(Edm.Single)',
] as const;
export type SearchFieldType = (typeof SEARCH_FIELD_TYPES)[number];

export interface SearchFieldDefinition {
  readonly name: string;
  readonly type: SearchFieldType;
  readonly key: boolean;
  readonly searchable: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly facetable: boolean;
  readonly retrievable: boolean;
  readonly stored: boolean;
  readonly analyzer?: string;
  readonly dimensions?: number;
  readonly vectorSearchProfile?: string;
}

export interface HnswAlgorithmDefinition {
  readonly name: string;
  readonly kind: 'hnsw';
  readonly hnswParameters: {
    readonly m: number;
    readonly efConstruction: number;
    readonly efSearch: number;
    readonly metric: 'cosine' | 'euclidean' | 'dotProduct' | 'hamming';
  };
}

export interface VectorSearchDefinition {
  readonly algorithms: readonly HnswAlgorithmDefinition[];
  readonly profiles: readonly { readonly name: string; readonly algorithm: string }[];
}

export interface SemanticConfigurationDefinition {
  readonly name: string;
  readonly prioritizedFields: {
    readonly titleField?: { readonly fieldName: string };
    readonly prioritizedContentFields: readonly { readonly fieldName: string }[];
    readonly prioritizedKeywordsFields: readonly { readonly fieldName: string }[];
  };
}

export interface SemanticSearchDefinition {
  readonly defaultConfiguration: string;
  readonly configurations: readonly SemanticConfigurationDefinition[];
}

export interface SearchIndexDefinition {
  readonly name: string;
  readonly description: string;
  readonly fields: readonly SearchFieldDefinition[];
  readonly vectorSearch: VectorSearchDefinition;
  readonly semantic?: SemanticSearchDefinition;
}

export interface IndexDefinitionOptions {
  readonly indexName: string;
  /** Must equal the embedding model's output size; checked when documents are built. */
  readonly vectorDimensions: number;
  /** Semantic ranking needs the Basic tier or higher with the semantic ranker enabled. */
  readonly semanticEnabled: boolean;
}

type Attributes = Partial<Omit<SearchFieldDefinition, 'name' | 'type'>>;

const NONE: Omit<SearchFieldDefinition, 'name' | 'type'> = {
  key: false,
  searchable: false,
  filterable: false,
  sortable: false,
  facetable: false,
  retrievable: true,
  stored: true,
};

function field(
  name: string,
  type: SearchFieldType,
  attributes: Attributes = {},
): SearchFieldDefinition {
  return { name, type, ...NONE, ...attributes };
}

const text = (name: string, attributes: Attributes = {}): SearchFieldDefinition =>
  field(name, 'Edm.String', { searchable: true, analyzer: TEXT_ANALYZER, ...attributes });
const keyword = (name: string, attributes: Attributes = {}): SearchFieldDefinition =>
  field(name, 'Edm.String', { filterable: true, ...attributes });
const integer = (name: string, attributes: Attributes = {}): SearchFieldDefinition =>
  field(name, 'Edm.Int32', attributes);

/** The index schema version an index description records, or undefined if it records none. */
export function schemaVersionFromDescription(description: string | undefined): number | undefined {
  const match = /\bschema-version=(\d{1,6})\b/.exec(description ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function buildIndexDefinition(options: IndexDefinitionOptions): SearchIndexDefinition {
  if (!Number.isInteger(options.vectorDimensions) || options.vectorDimensions < 1) {
    throw new RangeError('vectorDimensions must be a positive integer.');
  }
  const fields: SearchFieldDefinition[] = [
    keyword('id', { key: true, sortable: true }),
    keyword('tenantId'),
    integer('courseId', { filterable: true, sortable: true, facetable: true }),
    text('courseName', { filterable: true, facetable: true }),
    keyword('courseCategory', { facetable: true }),
    integer('sectionId', { filterable: true }),
    text('sectionName'),
    integer('moduleId', { filterable: true }),
    text('moduleName'),
    field('moduleUrl', 'Edm.String'),
    keyword('resourceId'),
    text('resourceName'),
    keyword('resourceType', { facetable: true }),
    // File names such as "aftercare_v2.pdf" tokenise better with the default analyser.
    field('fileName', 'Edm.String', { searchable: true }),
    keyword('mimeType', { facetable: true }),
    text('title'),
    field('headingPath', 'Collection(Edm.String)', { searchable: true, analyzer: TEXT_ANALYZER }),
    text('content'),
    field(VECTOR_FIELD_NAME, 'Collection(Edm.Single)', {
      searchable: true,
      // Vectors are only needed for similarity; not storing them roughly halves vector storage.
      retrievable: false,
      stored: false,
      dimensions: options.vectorDimensions,
      vectorSearchProfile: VECTOR_PROFILE_NAME,
    }),
    field('sourceUrl', 'Edm.String'),
    integer('pageNumber', { filterable: true }),
    integer('pageNumberEnd'),
    integer('slideNumber', { filterable: true }),
    integer('chunkNumber', { filterable: true, sortable: true }),
    integer('chunkCount'),
    integer('tokenCount'),
    keyword('contentHash'),
    keyword('sourceContentHash'),
    field('modifiedAt', 'Edm.DateTimeOffset', { filterable: true, sortable: true }),
    field('indexedAt', 'Edm.DateTimeOffset', { filterable: true, sortable: true }),
    keyword('extractorVersion', { facetable: true }),
    keyword('chunkerVersion', { facetable: true }),
    // Security trimming only: filterable, never returned to callers.
    field('allowedUserIds', 'Collection(Edm.String)', { filterable: true, retrievable: false }),
    field('allowedGroupIds', 'Collection(Edm.String)', { filterable: true, retrievable: false }),
    field('isActive', 'Edm.Boolean', { filterable: true }),
  ];

  return {
    name: options.indexName,
    description: `E-Hub Moodle course content for the Teams knowledge assistant. schema-version=${String(SEARCH_SCHEMA_VERSION)}`,
    fields,
    vectorSearch: {
      algorithms: [
        {
          name: VECTOR_ALGORITHM_NAME,
          kind: 'hnsw',
          hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' },
        },
      ],
      profiles: [{ name: VECTOR_PROFILE_NAME, algorithm: VECTOR_ALGORITHM_NAME }],
    },
    ...(options.semanticEnabled
      ? {
          semantic: {
            defaultConfiguration: SEMANTIC_CONFIGURATION_NAME,
            configurations: [
              {
                name: SEMANTIC_CONFIGURATION_NAME,
                prioritizedFields: {
                  titleField: { fieldName: 'title' },
                  prioritizedContentFields: [{ fieldName: 'content' }],
                  prioritizedKeywordsFields: [
                    { fieldName: 'headingPath' },
                    { fieldName: 'resourceName' },
                    { fieldName: 'moduleName' },
                    { fieldName: 'courseName' },
                  ],
                },
              },
            ],
          },
        }
      : {}),
  };
}

/** Fields the search client returns to callers: everything retrievable. */
export const RETRIEVABLE_FIELD_NAMES = buildIndexDefinition({
  indexName: 'placeholder',
  vectorDimensions: 1,
  semanticEnabled: false,
})
  .fields.filter((definition) => definition.retrievable)
  .map((definition) => definition.name);
